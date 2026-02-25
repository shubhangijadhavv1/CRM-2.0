import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const branchConfigsRouter = Router();

branchConfigsRouter.use(requireAuth);
branchConfigsRouter.use(requireDb);

branchConfigsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await BranchConfigModel.find().lean();
    const branchConfigs = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ branchConfigs });
  } catch (e) {
    return next(e);
  }
});

// Replace all branch configs (simplifies client-side editing UX)
branchConfigsRouter.put('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const list = req.body?.branchConfigs;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'branchConfigs array is required' });

    const ids = list.map((b: any) => b.id).filter(Boolean);
    if (ids.length !== list.length) return res.status(400).json({ error: 'Each branch config must include id' });

    // Upsert each, then delete those missing from the submitted list
    await Promise.all(
      list.map((b: any) =>
        BranchConfigModel.findOneAndUpdate({ id: b.id }, { $set: b }, { upsert: true, new: true, setDefaultsOnInsert: true })
      )
    );
    await BranchConfigModel.deleteMany({ id: { $nin: ids } });

    const docs = await BranchConfigModel.find().lean();
    const branchConfigs = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });

    emitInvalidate('branch-configs');
    return res.json({ branchConfigs });
  } catch (e) {
    return next(e);
  }
});

