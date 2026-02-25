import { Router } from 'express';
import { requireAuth, type AuthedRequest, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { NoticeModel } from '../models/Notice.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotifyAll } from '../realtime/notify.js';

export const noticesRouter = Router();

noticesRouter.use(requireAuth);
noticesRouter.use(requireDb);

noticesRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await NoticeModel.find().sort({ date: -1 }).lean();
    const notices = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ notices });
  } catch (e) {
    return next(e);
  }
});

noticesRouter.post('/', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const notice = req.body ?? {};
    if (!notice.id) return res.status(400).json({ error: 'id is required' });
    const created = await NoticeModel.findOneAndUpdate(
      { id: notice.id },
      { $setOnInsert: notice },
      { upsert: true, new: true }
    ).lean();
    const out: any = { ...created };
    delete out._id;
    delete out.__v;
    emitInvalidate('notices');
    emitNotifyAll({
      id: `notice-${notice.id}`,
      title: `New Notice: ${notice.title || 'Announcement'}`,
      message: (notice.content || '').slice(0, 100),
      type: 'info',
      time: new Date().toISOString()
    }, req.user!.id);
    return res.status(201).json({ notice: out });
  } catch (e) {
    return next(e);
  }
});

noticesRouter.delete('/:id', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const deleted = await NoticeModel.findOneAndDelete({ id: req.params.id }).lean();
    if (!deleted) return res.status(404).json({ error: 'Notice not found' });
    emitInvalidate('notices');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

noticesRouter.post('/:id/read', async (req: AuthedRequest, res, next) => {
  try {
    const updated = await NoticeModel.findOneAndUpdate(
      { id: req.params.id },
      { $addToSet: { readBy: req.user!.id } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Notice not found' });
    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('notices');
    return res.json({ notice: out });
  } catch (e) {
    return next(e);
  }
});

