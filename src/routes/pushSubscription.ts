import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { PushSubscriptionModel } from '../models/PushSubscription.js';
import { sendPushToUser } from '../realtime/webpush.js';

export const pushRouter = Router();
pushRouter.use(requireAuth);
pushRouter.use(requireDb);

pushRouter.get('/vapid-public-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || '';
  return res.json({ publicKey: key });
});

pushRouter.post('/subscribe', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const { endpoint, keys } = req.body ?? {};

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription data' });
    }

    await PushSubscriptionModel.findOneAndUpdate(
      { userId, endpoint },
      { userId, endpoint, keys },
      { upsert: true, new: true }
    );

    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

pushRouter.post('/test', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const subCount = await PushSubscriptionModel.countDocuments({ userId });
    if (subCount === 0) {
      return res.json({ ok: false, error: 'No push subscriptions found for your account. Enable notifications first.' });
    }
    await sendPushToUser(userId, {
      title: 'Nexus CRM - Test',
      body: 'Push notifications are working correctly!',
      tag: 'test-push-' + Date.now(),
      url: '/'
    });
    return res.json({ ok: true, subscriptions: subCount });
  } catch (e) {
    return next(e);
  }
});

pushRouter.post('/unsubscribe', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const { endpoint } = req.body ?? {};

    if (endpoint) {
      await PushSubscriptionModel.deleteMany({ userId, endpoint });
    } else {
      await PushSubscriptionModel.deleteMany({ userId });
    }

    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});
