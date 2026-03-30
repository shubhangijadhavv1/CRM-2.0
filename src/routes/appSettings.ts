import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AppSettingsModel } from '../models/AppSettings.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { AuditLogModel } from '../models/AuditLog.js';

// Server-side cache for db stats — 60 second TTL to avoid hammering the DB
let dbStatsCache: { data: any; at: number } | null = null;
const DB_STATS_TTL_MS = 10_000; // 10s — fast enough to feel real-time without hammering DB

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
    const p = (doc as any).agentPolicy ?? {};
    const out: any = {
      key: doc.key,
      forceNotificationPrompt: doc.forceNotificationPrompt,
      geminiApiKeySet: Boolean(doc.geminiApiKey && String(doc.geminiApiKey).trim().length > 0),
      // Explicitly cast each field — avoids Mongoose subdoc serialization quirks with boolean false
      // Use `=== false` check: if field is false → false, if true or undefined (never set) → true
      agentPolicy: {
        screenshotEnabled:     p.screenshotEnabled    === false ? false : true,
        screenshotIntervalSec: Math.max(15, Number(p.screenshotIntervalSec) || 300),
        urlTrackingEnabled:    p.urlTrackingEnabled   === false ? false : true,
        windowTrackingEnabled: p.windowTrackingEnabled === false ? false : true,
        trackKeyboard:         p.trackKeyboard        === false ? false : true,
        trackMouse:            p.trackMouse           === false ? false : true,
        idleAlertMinutes:      Math.max(1, Number(p.idleAlertMinutes) || 20),
        blockedKeywords:       Array.isArray(p.blockedKeywords) ? p.blockedKeywords : [],
        retentionDays:         Math.max(1, Number(p.retentionDays) || 7),
      }
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
    if (patch.clearGeminiApiKey === true) {
      update.geminiApiKey = '';
    }
    if (patch.geminiApiKey !== undefined) {
      update.geminiApiKey = String(patch.geminiApiKey || '').trim();
    }
    if (patch.agentPolicy && typeof patch.agentPolicy === 'object') {
      const p = patch.agentPolicy;
      // Use dot-notation so Mongoose never applies subdocument schema defaults
      // over explicit boolean false values (a known Mongoose gotcha with nested schemas)
      update['agentPolicy.screenshotEnabled']    = Boolean(p.screenshotEnabled);
      update['agentPolicy.screenshotIntervalSec'] = Math.max(15, Number(p.screenshotIntervalSec) || 300);
      update['agentPolicy.urlTrackingEnabled']    = Boolean(p.urlTrackingEnabled);
      update['agentPolicy.windowTrackingEnabled'] = Boolean(p.windowTrackingEnabled);
      update['agentPolicy.trackKeyboard']         = Boolean(p.trackKeyboard);
      update['agentPolicy.trackMouse']            = Boolean(p.trackMouse);
      update['agentPolicy.idleAlertMinutes']      = Math.max(1, Number(p.idleAlertMinutes) || 20);
      update['agentPolicy.blockedKeywords']       = Array.isArray(p.blockedKeywords) ? p.blockedKeywords.map((x: any) => String(x).trim()).filter(Boolean) : [];
      update['agentPolicy.retentionDays']         = Math.max(1, Number(p.retentionDays) || 7);
    }

    const updated = await AppSettingsModel.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const up = (updated as any).agentPolicy ?? {};
    const out: any = {
      key: updated!.key,
      forceNotificationPrompt: (updated as any).forceNotificationPrompt,
      geminiApiKeySet: Boolean((updated as any).geminiApiKey && String((updated as any).geminiApiKey).trim().length > 0),
      agentPolicy: {
        screenshotEnabled:     up.screenshotEnabled    === false ? false : true,
        screenshotIntervalSec: Math.max(15, Number(up.screenshotIntervalSec) || 300),
        urlTrackingEnabled:    up.urlTrackingEnabled   === false ? false : true,
        windowTrackingEnabled: up.windowTrackingEnabled === false ? false : true,
        trackKeyboard:         up.trackKeyboard        === false ? false : true,
        trackMouse:            up.trackMouse           === false ? false : true,
        idleAlertMinutes:      Math.max(1, Number(up.idleAlertMinutes) || 20),
        blockedKeywords:       Array.isArray(up.blockedKeywords) ? up.blockedKeywords : [],
        retentionDays:         Math.max(1, Number(up.retentionDays) || 7),
      }
    };
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

// GET /api/app-settings/db-stats — real MongoDB storage stats (admin/super-admin only)
// Server-side cached for 60s so multiple clients / refreshes don't hammer the DB.
appSettingsRouter.get('/db-stats', requireRole(['admin', 'super-admin']), async (_req, res, next) => {
  try {
    const now = Date.now();
    if (dbStatsCache && now - dbStatsCache.at < DB_STATS_TTL_MS) {
      return res.json({ dbStats: dbStatsCache.data, cached: true });
    }

    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ error: 'Database not connected' });

    // dbStats returns sizes in bytes
    const stats = await db.command({ dbStats: 1, scale: 1 });

    // Per-collection stats for breakdown (storageSize in bytes)
    const collNames = await db.listCollections().toArray();
    const collStats = await Promise.all(
      collNames.map(async (c) => {
        try {
          const cs = await db.command({ collStats: c.name, scale: 1 });
          return {
            name: c.name,
            count: cs.count ?? 0,
            storageSize: cs.storageSize ?? 0,
            dataSize: cs.size ?? 0,   // cs.size = logical dataSize for this collection
            indexSize: cs.totalIndexSize ?? 0,
            avgObjSize: cs.avgObjSize ?? 0,
          };
        } catch {
          return { name: c.name, count: 0, storageSize: 0, dataSize: 0, indexSize: 0, avgObjSize: 0 };
        }
      })
    );

    // MongoDB Atlas M0 free tier = 512 MB
    const ATLAS_FREE_TIER_BYTES = 512 * 1024 * 1024;

    // Atlas M0 free tier quota is measured against dataSize (logical uncompressed bytes).
    // storageSize is the WiredTiger compressed on-disk size — NOT what Atlas uses for the 512 MB limit.
    // indexSize counts toward the quota as well.
    const storageSize = stats.storageSize ?? 0;
    const dataSize    = stats.dataSize    ?? 0;
    const indexSize   = stats.indexSize   ?? 0;
    // Atlas M0 quota = dataSize + indexSize
    const usedBytes   = dataSize + indexSize;

    const result = {
      dataSize,
      storageSize,
      indexSize,
      totalSize: usedBytes,
      objects: stats.objects ?? 0,
      collectionCount: stats.collections ?? 0,
      atlasFreeTierLimitBytes: ATLAS_FREE_TIER_BYTES,
      usedBytes,
      usedPercent: Math.min(100, Math.round((usedBytes / ATLAS_FREE_TIER_BYTES) * 100)),
      // Per-collection: use dataSize for Atlas quota contribution
      collections: collStats.map((c: any) => ({
        ...c,
        // dataSize per collection (Atlas quota metric)
        dataSize: c.size ?? c.dataSize ?? 0,
      })).sort((a: any, b: any) => (b.dataSize ?? 0) - (a.dataSize ?? 0)),
      fetchedAt: new Date().toISOString(),
    };

    dbStatsCache = { data: result, at: now };
    return res.json({ dbStats: result, cached: false });
  } catch (e) {
    return next(e);
  }
});

