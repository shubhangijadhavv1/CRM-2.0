import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { NotificationModel } from '../models/Notification.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);
notificationsRouter.use(requireDb);

notificationsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const docs = await NotificationModel.find({ userId: req.user!.id }).sort({ createdAt: -1 }).lean();
    const notifications = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ notifications });
  } catch (e) {
    return next(e);
  }
});

notificationsRouter.put('/:id/read', async (req: AuthedRequest, res, next) => {
  try {
    const updated = await NotificationModel.findOneAndUpdate(
      { id: req.params.id, userId: req.user!.id },
      { $set: { read: true } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('notifications');
    return res.json({ notification: out });
  } catch (e) {
    return next(e);
  }
});

notificationsRouter.put('/read-all', async (req: AuthedRequest, res, next) => {
  try {
    await NotificationModel.updateMany({ userId: req.user!.id, read: false }, { $set: { read: true } }).lean();
    emitInvalidate('notifications');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

