import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AppSettingsModel } from '../models/AppSettings.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const appSettingsRouter = Router();

appSettingsRouter.use(requireAuth);
appSettingsRouter.use(requireDb);

appSettingsRouter.get('/', async (_req, res, next) => {
  try {
    const doc = await AppSettingsModel.findOne({ key: 'default' }).lean();
    if (!doc) {
      return res.json({ appSettings: { key: 'default', forceNotificationPrompt: true, geminiApiKeySet: false } });
    }
    const out: any = { key: doc.key, forceNotificationPrompt: doc.forceNotificationPrompt };
    out.geminiApiKeySet = Boolean(doc.geminiApiKey && String(doc.geminiApiKey).trim().length > 0);
    return res.json({ appSettings: out });
  } catch (e) {
    return next(e);
  }
});

appSettingsRouter.put('/', requireRole(['super-admin', 'admin']), async (req, res, next) => {
  try {
    const patch = req.body?.appSettings;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'appSettings object is required' });

    const update: any = { key: 'default', forceNotificationPrompt: Boolean(patch.forceNotificationPrompt) };
    if (patch.geminiApiKey !== undefined) {
      update.geminiApiKey = String(patch.geminiApiKey || '').trim();
    }

    const updated = await AppSettingsModel.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const out: any = { key: updated!.key, forceNotificationPrompt: (updated as any).forceNotificationPrompt };
    out.geminiApiKeySet = Boolean((updated as any).geminiApiKey && String((updated as any).geminiApiKey).trim().length > 0);
    emitInvalidate('app-settings');
    return res.json({ appSettings: out });
  } catch (e) {
    return next(e);
  }
});

