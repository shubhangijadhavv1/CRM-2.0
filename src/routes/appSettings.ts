import { Router } from 'express';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AppSettingsModel } from '../models/AppSettings.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { AuditLogModel } from '../models/AuditLog.js';

export const appSettingsRouter = Router();

appSettingsRouter.use(requireAuth);
appSettingsRouter.use(requireDb);

appSettingsRouter.get('/', async (_req, res, next) => {
  try {
    const doc = await AppSettingsModel.findOne({ key: 'default' }).lean();
    if (!doc) {
      return res.json({
        appSettings: {
          key: 'default',
          forceNotificationPrompt: true,
          geminiApiKeySet: false,
          agentPolicy: {
            screenshotEnabled: true,
            screenshotIntervalSec: 300,
            urlTrackingEnabled: true,
            windowTrackingEnabled: true,
            trackKeyboard: true,
            trackMouse: true,
            idleAlertMinutes: 20,
            blockedKeywords: [],
            retentionDays: 7
          }
        }
      });
    }
    const out: any = { key: doc.key, forceNotificationPrompt: doc.forceNotificationPrompt };
    out.geminiApiKeySet = Boolean(doc.geminiApiKey && String(doc.geminiApiKey).trim().length > 0);
    out.agentPolicy = (doc as any).agentPolicy || {
      screenshotEnabled: true,
      screenshotIntervalSec: 300,
      urlTrackingEnabled: true,
      windowTrackingEnabled: true,
      trackKeyboard: true,
      trackMouse: true,
      idleAlertMinutes: 20,
      blockedKeywords: [],
      retentionDays: 7
    };
    return res.json({ appSettings: out });
  } catch (e) {
    return next(e);
  }
});

appSettingsRouter.put('/', requireRole(['super-admin', 'admin']), async (req: AuthedRequest, res, next) => {
  try {
    const patch = req.body?.appSettings;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'appSettings object is required' });

    const update: any = { key: 'default', forceNotificationPrompt: Boolean(patch.forceNotificationPrompt) };
    if (patch.geminiApiKey !== undefined) {
      update.geminiApiKey = String(patch.geminiApiKey || '').trim();
    }
    if (patch.agentPolicy && typeof patch.agentPolicy === 'object') {
      const p = patch.agentPolicy;
      update.agentPolicy = {
        screenshotEnabled: p.screenshotEnabled !== false,
        screenshotIntervalSec: Math.max(15, Number(p.screenshotIntervalSec) || 300),
        urlTrackingEnabled: p.urlTrackingEnabled !== false,
        windowTrackingEnabled: p.windowTrackingEnabled !== false,
        trackKeyboard: p.trackKeyboard !== false,
        trackMouse: p.trackMouse !== false,
        idleAlertMinutes: Math.max(1, Number(p.idleAlertMinutes) || 20),
        blockedKeywords: Array.isArray(p.blockedKeywords) ? p.blockedKeywords.map((x: any) => String(x).trim()).filter(Boolean) : [],
        retentionDays: Math.max(1, Number(p.retentionDays) || 7)
      };
    }

    const updated = await AppSettingsModel.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const out: any = { key: updated!.key, forceNotificationPrompt: (updated as any).forceNotificationPrompt };
    out.geminiApiKeySet = Boolean((updated as any).geminiApiKey && String((updated as any).geminiApiKey).trim().length > 0);
    out.agentPolicy = (updated as any).agentPolicy;
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'agent_policy_updated',
      metadata: JSON.stringify({ hasPolicy: Boolean(update.agentPolicy) }).slice(0, 4000)
    }).catch(() => {});
    emitInvalidate('app-settings');
    return res.json({ appSettings: out });
  } catch (e) {
    return next(e);
  }
});

