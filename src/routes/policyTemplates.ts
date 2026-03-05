import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { PolicyTemplateModel } from '../models/PolicyTemplate.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import type { PolicyCategoryItem } from '../models/PolicyTemplate.js';

export const policyTemplatesRouter = Router();

policyTemplatesRouter.use(requireAuth);
policyTemplatesRouter.use(requireDb);

function normalizeCategories(categories: any[]): PolicyCategoryItem[] {
  if (!Array.isArray(categories)) return [];
  return categories.map((c: any) => ({
    id: String(c?.id ?? ''),
    label: String(c?.label ?? ''),
    policyPages: Array.isArray(c?.policyPages)
      ? c.policyPages.map((p: any) => ({
          id: String(p?.id ?? ''),
          label: String(p?.label ?? ''),
          content: String(p?.content ?? '')
        }))
      : []
  })).filter((c) => c.id && c.label);
}

policyTemplatesRouter.get('/', async (_req, res, next) => {
  try {
    const doc = await PolicyTemplateModel.findOne({ key: 'default' }).lean();
    if (!doc) {
      return res.json({ policyTemplates: { categories: [] } });
    }
    const categories = normalizeCategories((doc as any).categories || []);
    return res.json({ policyTemplates: { categories } });
  } catch (e) {
    return next(e);
  }
});

policyTemplatesRouter.put('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const body = req.body?.policyTemplates;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'policyTemplates object is required' });
    }
    const categories = normalizeCategories(Array.isArray(body.categories) ? body.categories : []);
    const updated = await PolicyTemplateModel.findOneAndUpdate(
      { key: 'default' },
      { $set: { key: 'default', categories } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    const out = normalizeCategories((updated as any).categories || []);
    emitInvalidate('policy-templates');
    return res.json({ policyTemplates: { categories: out } });
  } catch (e) {
    return next(e);
  }
});
