import webpush from 'web-push';
import { PushSubscriptionModel } from '../models/PushSubscription.js';

let configured = false;

export function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || 'mailto:admin@nexuscrm.local';

  if (!publicKey || !privateKey) {
    console.warn('[WebPush] VAPID keys not set — push notifications disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
    return;
  }

  webpush.setVapidDetails(email, publicKey, privateKey);
  configured = true;
  console.log('[WebPush] Configured with VAPID keys');
}

export function isWebPushConfigured() {
  return configured;
}

export async function sendPushToUser(userId: string, payload: { title: string; body: string; icon?: string; tag?: string; url?: string }) {
  if (!configured) { console.log('[WebPush] Not configured, skipping push to', userId); return; }

  const subscriptions = await PushSubscriptionModel.find({ userId }).lean();
  if (subscriptions.length === 0) { console.log('[WebPush] No subscriptions for user', userId); return; }

  console.log(`[WebPush] Sending to user ${userId} (${subscriptions.length} sub${subscriptions.length > 1 ? 's' : ''}): "${payload.title}"`);
  const jsonPayload = JSON.stringify(payload);
  const staleEndpoints: string[] = [];

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          jsonPayload,
          { TTL: 60 * 60 }
        );
        return 'ok';
      } catch (err: any) {
        console.warn(`[WebPush] Failed for endpoint ${sub.endpoint.substring(0, 50)}... status=${err.statusCode}`);
        if (err.statusCode === 404 || err.statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        }
        return 'fail';
      }
    })
  );

  const sent = results.filter(r => r.status === 'fulfilled' && r.value === 'ok').length;
  console.log(`[WebPush] Delivered ${sent}/${subscriptions.length} for user ${userId}`);

  if (staleEndpoints.length > 0) {
    await PushSubscriptionModel.deleteMany({ endpoint: { $in: staleEndpoints } });
    console.log(`[WebPush] Removed ${staleEndpoints.length} stale subscription(s)`);
  }
}

export async function sendPushToAll(payload: { title: string; body: string; icon?: string; tag?: string; url?: string }, excludeUserId?: string) {
  if (!configured) return;

  const filter: any = {};
  if (excludeUserId) filter.userId = { $ne: excludeUserId };
  const subscriptions = await PushSubscriptionModel.find(filter).lean();
  if (subscriptions.length === 0) return;

  const jsonPayload = JSON.stringify(payload);
  const staleEndpoints: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          jsonPayload,
          { TTL: 60 * 60 }
        );
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await PushSubscriptionModel.deleteMany({ endpoint: { $in: staleEndpoints } });
  }
}
