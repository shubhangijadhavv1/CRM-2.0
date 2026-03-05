import { getIo } from './io.js';
import { sendPushToUser, sendPushToAll } from './webpush.js';

export function emitNotify(userId: string, payload: any) {
  const io = getIo();
  if (!io) return;
  io.to(`user:${userId}`).emit('notify', payload);

  sendPushToUser(userId, {
    title: payload.title || 'Nexus CRM',
    body: payload.message || '',
    tag: `notify-${payload.id || Date.now()}`,
    url: '/'
  }).catch(() => {});
}

export function emitNotifyAll(payload: any, excludeUserId?: string) {
  const io = getIo();
  if (io) {
    if (excludeUserId) {
      io.except(`user:${excludeUserId}`).emit('notify', payload);
    } else {
      io.emit('notify', payload);
    }
  }

  sendPushToAll({
    title: payload.title || 'Nexus CRM',
    body: payload.message || '',
    tag: `notify-${payload.id || Date.now()}`,
    url: '/'
  }, excludeUserId).catch(() => {});
}

