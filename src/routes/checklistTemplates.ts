import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { ChecklistTemplateModel } from '../models/ChecklistTemplate.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const checklistTemplatesRouter = Router();

checklistTemplatesRouter.use(requireAuth);
checklistTemplatesRouter.use(requireDb);

checklistTemplatesRouter.get('/', async (_req, res, next) => {
  try {
    const doc = await ChecklistTemplateModel.findOne({ key: 'default' }).lean();
    if (!doc) {
      return res.json({ checklistTemplates: {} });
    }
    const out: any = { ...doc };
    delete out._id;
    delete out.__v;
    return res.json({ checklistTemplates: out.templates || {} });
  } catch (e) {
    return next(e);
  }
});

// Replace all templates (admin UX is simplest)
checklistTemplatesRouter.put('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const templates = req.body?.checklistTemplates;
    if (!templates || typeof templates !== 'object') {
      return res.status(400).json({ error: 'checklistTemplates object is required' });
    }

    const updated = await ChecklistTemplateModel.findOneAndUpdate(
      { key: 'default' },
      { $set: { key: 'default', templates } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    emitInvalidate('checklist-templates');
    return res.json({ checklistTemplates: (updated as any).templates || {} });
  } catch (e) {
    return next(e);
  }
});

