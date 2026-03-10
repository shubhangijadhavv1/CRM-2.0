import { Router } from 'express';
import { requireAuth, type AuthedRequest, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { BehaviorModel } from '../models/Behavior.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const behaviorRouter = Router();

behaviorRouter.use(requireAuth);
behaviorRouter.use(requireDb);

behaviorRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const isTeam = req.user?.role === 'team';
    const q: any = {};
    if (isTeam) q.userId = req.user!.id;
    const docs = await BehaviorModel.find(q).sort({ date: -1 }).lean();
    const behaviorRecords = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ behaviorRecords });
  } catch (e) {
    return next(e);
  }
});

behaviorRouter.post('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const rec = req.body ?? {};
    if (!rec.id) return res.status(400).json({ error: 'id is required' });
    const created = await BehaviorModel.findOneAndUpdate({ id: rec.id }, { $setOnInsert: rec }, { upsert: true, new: true }).lean();
    const out: any = { ...created };
    delete out._id;
    delete out.__v;
    emitInvalidate('behavior');
    return res.status(201).json({ behaviorRecord: out });
  } catch (e) {
    return next(e);
  }
});

behaviorRouter.delete('/:id', requireRole(['super-admin']), async (req, res, next) => {
  try {
    const deleted = await BehaviorModel.findOneAndDelete({ id: req.params.id }).lean();
    if (!deleted) return res.status(404).json({ error: 'Behavior record not found' });
    emitInvalidate('behavior');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});
