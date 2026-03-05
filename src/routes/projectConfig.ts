import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { ProjectConfigModel } from '../models/ProjectConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const projectConfigRouter = Router();

projectConfigRouter.use(requireAuth);
projectConfigRouter.use(requireDb);

projectConfigRouter.get('/', async (_req, res, next) => {
  try {
    const doc = await ProjectConfigModel.findOne({ key: 'default' }).lean();
    if (!doc) {
      // No demo defaults: return an empty config so the UI starts blank.
      return res.json({
        projectConfig: {
          key: 'default',
          categoryOptions: {},
          serverOptions: [],
          websiteTypeOptions: []
        }
      });
    }
    const out: any = { ...doc };
    delete out._id;
    delete out.__v;
    return res.json({ projectConfig: out });
  } catch (e) {
    return next(e);
  }
});

projectConfigRouter.put('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const patch = req.body?.projectConfig;
    if (!patch) return res.status(400).json({ error: 'projectConfig is required' });
    const updated = await ProjectConfigModel.findOneAndUpdate(
      { key: 'default' },
      { $set: { ...patch, key: 'default' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('project-config');
    return res.json({ projectConfig: out });
  } catch (e) {
    return next(e);
  }
});

