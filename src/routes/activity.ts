import { Router } from 'express';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel } from '../models/User.js';
import { AttendanceModel } from '../models/Attendance.js';
import { ActivityLogModel } from '../models/ActivityLog.js';
import { AppSettingsModel } from '../models/AppSettings.js';
import { NotificationModel } from '../models/Notification.js';
import { AgentWindowEventModel } from '../models/AgentWindowEvent.js';
import { AgentScreenshotModel } from '../models/AgentScreenshot.js';
import { AgentAlertModel } from '../models/AgentAlert.js';
import { AuditLogModel } from '../models/AuditLog.js';
import { TaskModel } from '../models/Task.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';

export const activityRouter = Router();

activityRouter.use(requireAuth);
activityRouter.use(requireDb);

const ACTIVITY_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AGENT_HEALTH_MS = 2 * 60 * 1000;

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function createAdminAlert(ruleKey: string, userId: string, message: string, details = '', severity: 'info' | 'warning' | 'critical' = 'warning') {
  const id = `agent-alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await AgentAlertModel.create({ id, userId, ruleKey, message, details, severity }).catch(() => {});
  const admins = await UserModel.find({ role: { $in: ['admin', 'super-admin'] }, status: 'active' }).select('_id').lean();
  const now = new Date().toLocaleTimeString();
  if (admins.length > 0) {
    const rows = admins.map((u: any) => ({
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: String(u._id),
      title: 'Desktop Agent Alert',
      message,
      type: severity === 'critical' ? 'alert' : 'info',
      time: now,
      read: false
    }));
    await NotificationModel.insertMany(rows).catch(() => {});
    for (const u of admins) {
      emitNotify(String((u as any)._id), {
        id: `realtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: 'Desktop Agent Alert',
        message
      });
    }
  }
  emitInvalidate('notifications');
  emitInvalidate('activity');
}

async function getAgentPolicy() {
  const doc = await AppSettingsModel.findOne({ key: 'default' }).lean();
  return (doc as any)?.agentPolicy || {
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
}

activityRouter.post('/heartbeat', async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body ?? {};
    const lastActivityAt = Number(body.lastActivityAt);
    const serverIdleAfterMs = Math.max(5000, Number(process.env.BROWSER_IDLE_AFTER_MS) || 60000);
    const serverIdleForMs = Math.max(0, Date.now() - lastActivityAt);
    const serverIsIdle = serverIdleForMs >= serverIdleAfterMs;
    const reason = typeof body.reason === 'string' ? body.reason : 'interval';
    const crmOrigin = typeof body.crmOrigin === 'string' ? body.crmOrigin : '';
    const extensionVersion = typeof body.extensionVersion === 'string' ? body.extensionVersion : '';

    if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
      return res.status(400).json({ error: 'lastActivityAt is required' });
    }

    const patch: any = {
      lastBrowserActivityAt: new Date(lastActivityAt),
      lastBrowserHeartbeatAt: new Date(),
      browserIsIdle: serverIsIdle,
      browserIdleForMs: serverIdleForMs,
      browserLastReason: reason,
      browserCrmOrigin: crmOrigin,
      browserExtensionVersion: extensionVersion
    };
    if (crmOrigin === 'desktop-agent') {
      patch.lastAgentLoginAt = new Date();
    }

    const updated = await UserModel.findByIdAndUpdate(req.user!.id, { $set: patch }, { new: true }).lean();

    // Append to activity log (staff-wise, type = active/idle) for desktop agent logs
    await ActivityLogModel.create({
      userId: req.user!.id,
      at: new Date(),
      status: serverIsIdle ? 'idle' : 'active',
      source: crmOrigin || 'browser'
    }).catch(() => {});
    if (serverIsIdle) {
      const policy = await getAgentPolicy();
      const idleAlertMs = Math.max(1, Number(policy.idleAlertMinutes) || 20) * 60 * 1000;
      if (serverIdleForMs >= idleAlertMs) {
        const user = await UserModel.findById(req.user!.id).select('name').lean();
        const mins = Math.floor(serverIdleForMs / 60000);
        await createAdminAlert(
          'idle-threshold',
          req.user!.id,
          `${(user as any)?.name || 'Staff'} is idle for ${mins} minutes.`,
          `Idle duration crossed threshold (${policy.idleAlertMinutes}m).`,
          mins >= (Number(policy.idleAlertMinutes) || 20) * 2 ? 'critical' : 'warning'
        );
      }
    }
    await ActivityLogModel.deleteMany({
      userId: req.user!.id,
      at: { $lt: new Date(Date.now() - ACTIVITY_LOG_RETENTION_MS) }
    }).catch(() => {});
    if (!updated) return res.status(404).json({ error: 'User not found' });

    // --- Update today's attendance live status based on browser-wide activity ---
    // This makes "Idle" visible to admins even when CRM tab isn't open.
    // Only applies to active sessions (checkOutTime is null) and does not override breaks.
    const todayStr = new Date().toISOString().split('T')[0];
    const att = await AttendanceModel.findOne({ userId: req.user!.id, date: todayStr, checkOutTime: null })
      .sort({ checkInTime: -1 })
      .lean();

    if (att && att.dailyStatus !== 'checked-out' && att.dailyStatus !== 'lunch-break' && att.dailyStatus !== 'tea-break') {
      const idleIntervals = Array.isArray(att.idleIntervals) ? att.idleIntervals.map((i: any) => ({ ...i })) : [];
      const openIdx = idleIntervals.findIndex((i: any) => i.endTime === null);

      // When idle starts, it effectively begins at lastActivityAt + threshold.
      const idleStartMs = lastActivityAt + serverIdleAfterMs;
      const idleStartIso = new Date(Math.min(idleStartMs, Date.now())).toISOString();
      const activeIso = new Date(lastActivityAt).toISOString();

      if (serverIsIdle) {
        if (openIdx === -1) {
          idleIntervals.push({ startTime: idleStartIso, endTime: null, deducted: false });
        }
        const nextDailyStatus = 'idle';
        await AttendanceModel.findOneAndUpdate(
          { id: att.id },
          { $set: { idleIntervals, dailyStatus: nextDailyStatus } },
          { new: false }
        );
      } else {
        if (openIdx !== -1) {
          const startMs = new Date(idleIntervals[openIdx].startTime).getTime();
          const endMs = new Date(activeIso).getTime();
          const durationMs = Math.max(0, endMs - startMs);
          const deducted = durationMs > 5 * 60 * 1000;
          idleIntervals[openIdx] = { ...idleIntervals[openIdx], endTime: activeIso, deducted };
          const addMinutes = deducted ? Math.floor(durationMs / 60000) : 0;
          const nextIdleMinutes = (Number(att.idleMinutes) || 0) + addMinutes;
          await AttendanceModel.findOneAndUpdate(
            { id: att.id },
            { $set: { idleIntervals, idleMinutes: nextIdleMinutes, dailyStatus: 'checked-in' } },
            { new: false }
          );
        } else if (att.dailyStatus === 'idle') {
          await AttendanceModel.findOneAndUpdate({ id: att.id }, { $set: { dailyStatus: 'checked-in' } }, { new: false });
        }
      }
    }

    emitInvalidate('users');
    emitInvalidate('attendance');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

// POST /api/activity/agent-login — desktop agent calls this right after sign-in
// This guarantees CRM shows "Logged in" immediately and auto clock-in is applied server-side.
activityRouter.post('/agent-login', async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const user = await UserModel.findById(req.user!.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account is inactive.' });

    const extensionVersion = typeof req.body?.extensionVersion === 'string' ? req.body.extensionVersion : '';
    await UserModel.findByIdAndUpdate(req.user!.id, {
      $set: {
        lastAgentLoginAt: now,
        lastBrowserHeartbeatAt: now,
        lastBrowserActivityAt: now,
        browserIsIdle: false,
        browserIdleForMs: 0,
        browserLastReason: 'agent-login',
        browserCrmOrigin: 'desktop-agent',
        browserExtensionVersion: extensionVersion
      }
    });

    const date = todayStr();
    const openRecord = await AttendanceModel.findOne({ userId: req.user!.id, date, checkOutTime: null }).sort({ checkInTime: -1 }).lean();
    if (!openRecord) {
      const branch = String((user as any).branch || 'Main');
      await AttendanceModel.create({
        id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        userId: req.user!.id,
        userName: String((user as any).name || 'Staff'),
        date,
        branch,
        mode: 'office',
        checkInTime: now.toISOString(),
        checkOutTime: null,
        ipAddress: '',
        isLate: false,
        breaks: [],
        idleIntervals: [],
        idleMinutes: 0,
        totalWorkMinutes: 0,
        status: 'present',
        dailyStatus: 'checked-in'
      });
    } else if (openRecord.dailyStatus === 'checked-out') {
      await AttendanceModel.findOneAndUpdate(
        { id: openRecord.id },
        { $set: { dailyStatus: 'checked-in', checkOutTime: null } },
        { new: false }
      );
    }

    await ActivityLogModel.create({
      userId: req.user!.id,
      at: now,
      status: 'active',
      source: 'desktop-agent',
      eventType: 'agent-login'
    }).catch(() => {});

    await ActivityLogModel.deleteMany({
      userId: req.user!.id,
      at: { $lt: new Date(Date.now() - ACTIVITY_LOG_RETENTION_MS) }
    }).catch(() => {});

    emitInvalidate('users');
    emitInvalidate('attendance');
    emitInvalidate('activity');
    return res.json({ ok: true, connectedForMs: AGENT_HEALTH_MS });
  } catch (e) {
    return next(e);
  }
});

// POST /api/activity/agent-logout — desktop agent calls this on sign-out for real-time CRM "Logged out"
activityRouter.post('/agent-logout', async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const userId = req.user!.id;

    // Stop any in-progress task timers for this user
    const inProgressTasks = await TaskModel.find({
      assigneeId: userId,
      status: 'in-progress',
      timerStartedAt: { $ne: null, $type: 'number' }
    }).lean();
    for (const t of inProgressTasks) {
      const started = (t as any).timerStartedAt as number;
      const elapsed = Math.floor((nowMs - started) / 1000);
      const currentTracked = Number((t as any).timeTracked) || 0;
      await TaskModel.findByIdAndUpdate(t._id, {
        $set: {
          status: 'todo',
          timeTracked: currentTracked + elapsed,
          timerStartedAt: null
        }
      });
    }
    if (inProgressTasks.length > 0) emitInvalidate('tasks');

    await UserModel.findByIdAndUpdate(userId, {
      $set: {
        lastAgentLogoutAt: now,
        browserCrmOrigin: ''
      }
    });
    const date = todayStr();
    const openRecord = await AttendanceModel.findOne({ userId, date, checkOutTime: null }).sort({ checkInTime: -1 }).lean();
    if (openRecord?.id) {
      await AttendanceModel.findOneAndUpdate(
        { id: openRecord.id },
        { $set: { checkOutTime: now.toISOString(), dailyStatus: 'checked-out' } },
        { new: false }
      );
    }
    await ActivityLogModel.create({
      userId,
      at: now,
      status: 'idle',
      source: 'desktop-agent',
      eventType: 'agent-logout'
    }).catch(() => {});
    emitInvalidate('users');
    emitInvalidate('attendance');
    emitInvalidate('activity');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

// POST /api/activity/events — desktop agent sends keyboard/mouse activity (batch)
activityRouter.post('/events', async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body ?? {};
    const events = Array.isArray(body.events) ? body.events : [];
    const now = new Date();
    const toCreate: Array<{ userId: string; at: Date; status: 'active'; source: string; activityType?: 'keyboard' | 'mouse'; activityDetail?: string }> = [];
    for (let i = 0; i < Math.min(events.length, 100); i++) {
      const e = events[i];
      const type = e?.type === 'keyboard' || e?.type === 'mouse' ? e.type : undefined;
      if (!type) continue;
      const detail = typeof e?.detail === 'string' ? e.detail.slice(0, 80) : '';
      const at = e?.at ? new Date(e.at) : now;
      toCreate.push({
        userId: req.user!.id,
        at,
        status: 'active',
        source: 'desktop-agent',
        activityType: type,
        activityDetail: detail
      });
    }
    if (toCreate.length > 0) {
      await ActivityLogModel.insertMany(toCreate).catch(() => {});
      emitInvalidate('activity');
    }
    return res.json({ ok: true, received: toCreate.length });
  } catch (e) {
    return next(e);
  }
});

// POST /api/activity/window-events — desktop agent sends active app/window/url timeline (batch)
activityRouter.post('/window-events', async (req: AuthedRequest, res, next) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const policy = await getAgentPolicy();
    if (!policy.windowTrackingEnabled) return res.json({ ok: true, received: 0, skipped: 'windowTrackingDisabled' });
    const toCreate: Array<{ userId: string; at: Date; appName: string; windowTitle: string; domain?: string; url?: string; source: 'desktop-agent' }> = [];
    for (let i = 0; i < Math.min(events.length, 100); i++) {
      const e = events[i] || {};
      const at = e.at ? new Date(e.at) : new Date();
      const appName = String(e.appName || '').trim().slice(0, 160);
      const windowTitle = String(e.windowTitle || '').trim().slice(0, 300);
      const domain = String(e.domain || '').trim().slice(0, 160);
      const url = policy.urlTrackingEnabled ? String(e.url || '').trim().slice(0, 400) : '';
      if (!appName && !windowTitle) continue;
      toCreate.push({
        userId: req.user!.id,
        at,
        appName,
        windowTitle,
        domain,
        url,
        source: 'desktop-agent'
      });
    }
    if (toCreate.length > 0) {
      await AgentWindowEventModel.insertMany(toCreate).catch(() => {});
      const blocked = Array.isArray(policy.blockedKeywords) ? policy.blockedKeywords : [];
      if (blocked.length > 0) {
        for (const row of toCreate) {
          const hay = `${row.appName} ${row.windowTitle} ${row.domain} ${row.url}`.toLowerCase();
          const hit = blocked.find((k: string) => k && hay.includes(String(k).toLowerCase()));
          if (hit) {
            const me = await UserModel.findById(req.user!.id).select('name').lean();
            await createAdminAlert(
              'blocked-keyword',
              req.user!.id,
              `${(me as any)?.name || 'Staff'} opened restricted content keyword "${hit}".`,
              `${row.appName} | ${row.windowTitle}`.slice(0, 500),
              'critical'
            );
            break;
          }
        }
      }
      const retentionDays = Math.max(1, Number(policy.retentionDays) || 7);
      await AgentWindowEventModel.deleteMany({
        userId: req.user!.id,
        at: { $lt: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000) }
      }).catch(() => {});
      emitInvalidate('activity');
    }
    return res.json({ ok: true, received: toCreate.length });
  } catch (e) {
    return next(e);
  }
});

// POST /api/activity/screenshots — desktop agent sends base64 image snapshots
activityRouter.post('/screenshots', async (req: AuthedRequest, res, next) => {
  try {
    const policy = await getAgentPolicy();
    if (!policy.screenshotEnabled) return res.json({ ok: true, stored: false, skipped: 'screenshotDisabled' });
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl : '';
    if (!imageDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'imageDataUrl is required' });
    }
    const at = req.body?.at ? new Date(req.body.at) : new Date();
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'image/jpeg';
    const width = Number(req.body?.width) || 0;
    const height = Number(req.body?.height) || 0;
    const sizeBytes = Number(req.body?.sizeBytes) || Math.floor((imageDataUrl.length * 3) / 4);
    await AgentScreenshotModel.create({
      userId: req.user!.id,
      at,
      imageDataUrl,
      mimeType,
      width,
      height,
      sizeBytes,
      source: 'desktop-agent'
    });
    const retentionDays = Math.max(1, Number(policy.retentionDays) || 7);
    await AgentScreenshotModel.deleteMany({
      userId: req.user!.id,
      at: { $lt: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000) }
    }).catch(() => {});
    emitInvalidate('activity');
    return res.json({ ok: true, stored: true });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/window-events — admin/super-admin timeline data by staff
activityRouter.get('/window-events', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const q: any = {};
    if (userId) q.userId = userId;
    if (from) q.at = { $gte: new Date(from) };
    if (to) (q.at = q.at || {}), (q.at.$lte = new Date(to));
    const events = await AgentWindowEventModel.find(q).sort({ at: -1 }).limit(limit).lean();
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'view_window_events',
      targetUserId: userId || '',
      metadata: JSON.stringify({ limit }).slice(0, 4000)
    }).catch(() => {});
    return res.json({ events });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/screenshots — admin/super-admin screenshot feed by staff
activityRouter.get('/screenshots', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const q: any = {};
    if (userId) q.userId = userId;
    const shots = await AgentScreenshotModel.find(q).sort({ at: -1 }).limit(limit).lean();
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'view_screenshots',
      targetUserId: userId || '',
      metadata: JSON.stringify({ limit }).slice(0, 4000)
    }).catch(() => {});
    return res.json({
      screenshots: shots.map((s: any) => ({
        userId: s.userId,
        at: s.at,
        imageDataUrl: s.imageDataUrl,
        mimeType: s.mimeType,
        width: s.width,
        height: s.height,
        sizeBytes: s.sizeBytes
      }))
    });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/alerts — admin/super-admin alerts list
activityRouter.get('/alerts', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const includeResolved = req.query.includeResolved === '1';
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const q: any = {};
    if (userId) q.userId = userId;
    if (!includeResolved) q.resolvedAt = null;
    const alerts = await AgentAlertModel.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({
      alerts: alerts.map((a: any) => ({
        id: a.id,
        userId: a.userId,
        ruleKey: a.ruleKey,
        severity: a.severity,
        message: a.message,
        details: a.details || '',
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt || null
      }))
    });
  } catch (e) {
    return next(e);
  }
});

activityRouter.put('/alerts/:id/resolve', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const alert = await AgentAlertModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: { resolvedAt: new Date() } },
      { new: true }
    ).lean();
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'resolve_agent_alert',
      targetUserId: String((alert as any).userId || '')
    }).catch(() => {});
    emitInvalidate('activity');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/timeline — merged staff timeline (events + screenshots + status logs)
activityRouter.get('/timeline', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 150));
    const [statusLogs, windowEvents, screenshots] = await Promise.all([
      ActivityLogModel.find({ userId }).sort({ at: -1 }).limit(limit).lean(),
      AgentWindowEventModel.find({ userId }).sort({ at: -1 }).limit(limit).lean(),
      AgentScreenshotModel.find({ userId }).sort({ at: -1 }).limit(Math.min(50, limit)).lean()
    ]);
    const timeline = [
      ...statusLogs.map((l: any) => ({
        at: l.at,
        kind: 'status',
        status: l.status,
        source: l.source,
        activityType: l.activityType || '',
        activityDetail: l.activityDetail || '',
        eventType: l.eventType || ''
      })),
      ...windowEvents.map((w: any) => ({
        at: w.at,
        kind: 'window',
        appName: w.appName,
        windowTitle: w.windowTitle,
        domain: w.domain || '',
        url: w.url || ''
      })),
      ...screenshots.map((s: any) => ({
        at: s.at,
        kind: 'screenshot',
        width: s.width || 0,
        height: s.height || 0,
        sizeBytes: s.sizeBytes || 0
      }))
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
    return res.json({ timeline });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/logs — admin/super-admin: activity logs (staff-wise, active/idle, source)
activityRouter.get('/logs', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const activityType = typeof req.query.activityType === 'string' ? req.query.activityType : undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    const q: any = {};
    if (userId) q.userId = userId;
    if (from) q.at = { $gte: new Date(from) };
    if (to) (q.at = q.at || {}), (q.at.$lte = new Date(to));
    if (activityType === 'keyboard' || activityType === 'mouse') q.activityType = activityType;

    const logs = await ActivityLogModel.find(q).sort({ at: -1 }).limit(limit).lean();
    const out = logs.map((l: any) => ({
      userId: l.userId,
      at: l.at,
      status: l.status,
      source: l.source,
      activityType: l.activityType || undefined,
      activityDetail: l.activityDetail || undefined,
      eventType: l.eventType || undefined
    }));
    return res.json({ logs: out });
  } catch (e) {
    return next(e);
  }
});

