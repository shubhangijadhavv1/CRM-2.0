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
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';
import { emitUserStatus } from '../realtime/io.js';

export const activityRouter = Router();

activityRouter.use(requireAuth);
activityRouter.use(requireDb);

const AGENT_HEALTH_MS = 2 * 60 * 1000;
/** Purge activity logs older than retentionDays (from policy). Falls back to 7 days. */
async function pruneActivityLogs(userId: string, retentionDays?: number): Promise<void> {
  const days = Math.max(1, Math.min(30, Number(retentionDays) || 7));
  await ActivityLogModel.deleteMany({
    userId,
    at: { $lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
  }).catch(() => {});
}
const idleAlertState = new Map<string, { openSince: string; lastAlertAt: number }>();
// Per-user blocked-keyword alert cooldown: don't spam alerts for the same keyword
const keywordAlertCooldown = new Map<string, number>(); // key: `${userId}:${keyword}` → lastAlertAt ms
const KEYWORD_ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between same-keyword alerts per user

// Max base64 size accepted (~300 KB decoded) to protect MongoDB from oversized screenshots
const SCREENSHOT_MAX_B64_CHARS = 450_000; // ~337 KB decoded PNG/JPEG

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
      read: false,
      link: { view: 'live-workplace', userId }
    }));
    await NotificationModel.insertMany(rows).catch(() => {});
    for (const u of admins) {
      emitNotify(String((u as any)._id), {
        id: `realtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: 'Desktop Agent Alert',
        message,
        link: { view: 'live-workplace', userId }
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
    // Default 35s: faster idle visibility on admin dashboards; override with BROWSER_IDLE_AFTER_MS (ms).
    const serverIdleAfterMs = Math.max(5000, Number(process.env.BROWSER_IDLE_AFTER_MS) || 35000);
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
    const attForAlert = await AttendanceModel.findOne({ userId: req.user!.id, date: todayStr(), checkOutTime: null })
      .sort({ checkInTime: -1 })
      .lean();
    const userRole = String((updated as any)?.role || '');
    const isAdminRole = userRole === 'super-admin' || userRole === 'admin';
    const isBreakMode = String((attForAlert as any)?.dailyStatus || '').includes('break');
    const canSendIdleAlert = Boolean(attForAlert) && !isAdminRole && !isBreakMode;

    if (!serverIsIdle) {
      idleAlertState.delete(req.user!.id);
    } else if (!canSendIdleAlert) {
      // Never keep stale alert state for users that should not generate idle alerts.
      idleAlertState.delete(req.user!.id);
    } else {
      const policy = await getAgentPolicy();
      const idleAlertMinutes = Math.max(1, Number(policy.idleAlertMinutes) || 20);
      const idleAlertMs = idleAlertMinutes * 60 * 1000;
      if (serverIdleForMs >= idleAlertMs) {
        const openIdle = (attForAlert as any)?.idleIntervals?.find((i: any) => !i.endTime);
        const openSince = String(openIdle?.startTime || (attForAlert as any)?.checkInTime || '');
        const nowTs = Date.now();
        const existing = idleAlertState.get(req.user!.id);
        const resendMs = 60 * 60 * 1000; // At most once per hour for same idle streak.
        const shouldAlert =
          !existing ||
          existing.openSince !== openSince ||
          nowTs - existing.lastAlertAt >= resendMs;

        if (shouldAlert) {
          const user = await UserModel.findById(req.user!.id).select('name').lean();
          const mins = Math.floor(serverIdleForMs / 60000);
          await createAdminAlert(
            'idle-threshold',
            req.user!.id,
            `${(user as any)?.name || 'Staff'} is idle for ${mins} minutes.`,
            `Idle duration crossed threshold (${idleAlertMinutes}m).`,
            mins >= idleAlertMinutes * 2 ? 'critical' : 'warning'
          );
          idleAlertState.set(req.user!.id, { openSince, lastAlertAt: nowTs });
        }
      }
    }
    // Prune old activity logs using policy retention days (not hardcoded)
    void pruneActivityLogs(req.user!.id, (await getAgentPolicy()).retentionDays);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    // --- Update today's attendance live status based on browser-wide activity ---
    // This makes "Idle" visible to admins even when CRM tab isn't open.
    // Only applies to active sessions (checkOutTime is null) and does not override breaks.
    const today = new Date().toISOString().split('T')[0];
    const att = await AttendanceModel.findOne({ userId: req.user!.id, date: today, checkOutTime: null })
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
        // Activity detected — ALWAYS set dailyStatus back to 'checked-in'
        const updatePatch: any = { dailyStatus: 'checked-in' };
        if (openIdx !== -1) {
          const startMs = new Date(idleIntervals[openIdx].startTime).getTime();
          const endMs = new Date(activeIso).getTime();
          const durationMs = Math.max(0, endMs - startMs);
          const deducted = true; // Always count idle time, regardless of duration
          idleIntervals[openIdx] = { ...idleIntervals[openIdx], endTime: activeIso, deducted };
          const addMinutes = Math.floor(durationMs / 60000);
          updatePatch.idleIntervals = idleIntervals;
          updatePatch.idleMinutes = (Number(att.idleMinutes) || 0) + addMinutes;
        }
        await AttendanceModel.findOneAndUpdate(
          { id: att.id },
          { $set: updatePatch },
          { new: false }
        );
      }
    }

    // Emit lightweight real-time status update to all admins instantly
    emitUserStatus({
      userId: req.user!.id,
      browserIsIdle: serverIsIdle,
      browserIdleForMs: serverIdleForMs,
      lastBrowserActivityAt: new Date(lastActivityAt).toISOString(),
      lastBrowserHeartbeatAt: new Date().toISOString(),
    });
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

    void pruneActivityLogs(req.user!.id, (await getAgentPolicy()).retentionDays);

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
      const nowMs = now.getTime();
      const idleIntervals = Array.isArray(openRecord.idleIntervals) ? openRecord.idleIntervals.map((i: any) => ({ ...i })) : [];
      const breaks = Array.isArray(openRecord.breaks) ? openRecord.breaks.map((b: any) => ({ ...b })) : [];

      // Close any open idle interval
      let finalIdleMinutes = Number(openRecord.idleMinutes) || 0;
      const openIdleIdx = idleIntervals.findIndex((i: any) => i.endTime === null);
      if (openIdleIdx !== -1) {
        const duration = nowMs - new Date(idleIntervals[openIdleIdx].startTime).getTime();
        const deducted = true; // Always count idle time
        idleIntervals[openIdleIdx] = { ...idleIntervals[openIdleIdx], endTime: now.toISOString(), deducted };
        finalIdleMinutes += Math.floor(duration / 60000);
      }

      // Close any open break
      const openBreakIdx = breaks.findIndex((b: any) => b.endTime === null);
      if (openBreakIdx !== -1) {
        breaks[openBreakIdx] = { ...breaks[openBreakIdx], endTime: now.toISOString() };
      }

      // Compute totalWorkMinutes: session - breaks(capped) - idle - excessBreak
      let totalWorkMinutes = 0;
      if (openRecord.checkInTime) {
        const checkInMs = new Date(openRecord.checkInTime).getTime();
        const totalSessionMs = nowMs - checkInMs;

        const branchId = String(openRecord.branch || '');
        const branchConfig = branchId ? await BranchConfigModel.findOne({ $or: [{ id: branchId }, { name: branchId }] }).lean() : null;
        const lunchTimeLimit = Number((branchConfig as any)?.lunchTimeLimitMinutes) || 30;
        const teaBreakTimeLimit = Number((branchConfig as any)?.teaBreakTimeLimitMinutes) || 15;

        let allowedBreakMs = 0;
        let excessBreakMs = 0;
        breaks.forEach((b: any) => {
          const bStart = new Date(b.startTime).getTime();
          const bEnd = b.endTime ? new Date(b.endTime).getTime() : nowMs;
          const durationMin = Math.floor((bEnd - bStart) / 60000);
          const limit = b.type === 'lunch' ? lunchTimeLimit : teaBreakTimeLimit;
          allowedBreakMs += Math.min(durationMin, limit) * 60000;
          if (durationMin > limit) excessBreakMs += (durationMin - limit) * 60000;
        });

        const totalIdleMs = finalIdleMinutes * 60000;
        totalWorkMinutes = Math.max(0, Math.floor((totalSessionMs - allowedBreakMs - totalIdleMs - excessBreakMs) / 60000));
      }

      await AttendanceModel.findOneAndUpdate(
        { id: openRecord.id },
        { $set: {
          checkOutTime: now.toISOString(),
          dailyStatus: 'checked-out',
          idleIntervals,
          breaks,
          idleMinutes: finalIdleMinutes,
          totalWorkMinutes
        } },
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
      // Prune old logs (non-blocking) using policy retention
      const policy = await getAgentPolicy();
      void pruneActivityLogs(req.user!.id, policy.retentionDays);
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
            // Cooldown: only alert once per 15 min per user+keyword to prevent spam
            const cooldownKey = `${req.user!.id}:${hit.toLowerCase()}`;
            const lastAlertAt = keywordAlertCooldown.get(cooldownKey) || 0;
            if (Date.now() - lastAlertAt >= KEYWORD_ALERT_COOLDOWN_MS) {
              keywordAlertCooldown.set(cooldownKey, Date.now());
              const me = await UserModel.findById(req.user!.id).select('name').lean();
              await createAdminAlert(
                'blocked-keyword',
                req.user!.id,
                `${(me as any)?.name || 'Staff'} opened restricted content: "${hit}".`,
                `${row.appName} | ${row.windowTitle}`.slice(0, 500),
                'critical'
              );
            }
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

    // Reject screenshots that are too large to protect MongoDB storage
    if (imageDataUrl.length > SCREENSHOT_MAX_B64_CHARS) {
      return res.status(413).json({
        error: 'Screenshot too large. Reduce capture resolution or quality on the agent.',
        maxChars: SCREENSHOT_MAX_B64_CHARS,
        receivedChars: imageDataUrl.length
      });
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

    // Enforce retention: delete screenshots older than retentionDays
    const retentionDays = Math.max(1, Math.min(30, Number(policy.retentionDays) || 3));
    await AgentScreenshotModel.deleteMany({
      userId: req.user!.id,
      at: { $lt: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000) }
    }).catch(() => {});

    // Hard cap: keep at most 200 screenshots per user (delete oldest beyond cap)
    const totalCount = await AgentScreenshotModel.countDocuments({ userId: req.user!.id });
    if (totalCount > 200) {
      const oldest = await AgentScreenshotModel.find({ userId: req.user!.id })
        .sort({ at: 1 })
        .limit(totalCount - 200)
        .select('_id')
        .lean();
      if (oldest.length > 0) {
        await AgentScreenshotModel.deleteMany({ _id: { $in: oldest.map((d: any) => d._id) } }).catch(() => {});
      }
    }

    emitInvalidate('activity');
    return res.json({ ok: true, stored: true, sizeBytes });
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

// GET /api/activity/screenshots — admin/super-admin screenshot feed (metadata only by default)
// Add ?withImage=1 to include base64 imageDataUrl in response (expensive — use sparingly)
activityRouter.get('/screenshots', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const withImage = req.query.withImage === '1';
    const q: any = {};
    if (userId) q.userId = userId;

    // By default return metadata only — exclude imageDataUrl to keep response small
    const select = withImage ? undefined : '-imageDataUrl';
    const shots = await AgentScreenshotModel.find(q).sort({ at: -1 }).limit(limit).select(select ?? '').lean();

    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'view_screenshots',
      targetUserId: userId || '',
      metadata: JSON.stringify({ limit, withImage }).slice(0, 4000)
    }).catch(() => {});

    return res.json({
      screenshots: shots.map((s: any) => ({
        id: String(s._id),
        userId: s.userId,
        at: s.at,
        mimeType: s.mimeType,
        width: s.width || 0,
        height: s.height || 0,
        sizeBytes: s.sizeBytes || 0,
        ...(withImage ? { imageDataUrl: s.imageDataUrl } : {})
      }))
    });
  } catch (e) {
    return next(e);
  }
});

// GET /api/activity/screenshots/:id/image — fetch single screenshot image on demand
activityRouter.get('/screenshots/:id/image', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const shot = await AgentScreenshotModel.findById(req.params.id).select('imageDataUrl mimeType userId').lean() as any;
    if (!shot) return res.status(404).json({ error: 'Screenshot not found' });
    // Return as proper image response to save bandwidth (no JSON wrapper)
    const base64 = String(shot.imageDataUrl || '');
    const match = base64.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!match) return res.status(422).json({ error: 'Invalid image data' });
    const buf = Buffer.from(match[2], 'base64');
    res.set('Content-Type', match[1]);
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'private, max-age=3600');
    return res.end(buf);
  } catch (e) {
    return next(e);
  }
});

// DELETE /api/activity/screenshots — admin/super-admin delete screenshots (optionally by userId)
activityRouter.delete('/screenshots', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const q: any = {};
    if (userId) q.userId = userId;
    const result = await AgentScreenshotModel.deleteMany(q);
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'delete_screenshots',
      targetUserId: userId || '',
      metadata: JSON.stringify({ deletedCount: result.deletedCount || 0 }).slice(0, 4000)
    }).catch(() => {});
    emitInvalidate('activity');
    return res.json({ ok: true, deletedCount: result.deletedCount || 0 });
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

// POST /api/activity/cleanup — admin/super-admin: bulk delete temporary/log collections
// Safe collections only — Attendance, Leave, Projects, Tasks, Users are NEVER touched.
// Body: { targets: Array<'activity-logs'|'window-events'|'agent-alerts-resolved'|'audit-logs'|'notifications-read'>, olderThanDays?: number }
activityRouter.post('/cleanup', requireRole(['admin', 'super-admin']), async (req: AuthedRequest, res, next) => {
  try {
    const targets: string[] = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const olderThanDays = Math.max(1, Number(req.body?.olderThanDays) || 30);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result: Record<string, number> = {};

    if (targets.includes('activity-logs')) {
      const r = await ActivityLogModel.deleteMany({ at: { $lt: cutoff } });
      result['activity-logs'] = r.deletedCount ?? 0;
    }

    if (targets.includes('window-events')) {
      const r = await AgentWindowEventModel.deleteMany({ at: { $lt: cutoff } });
      result['window-events'] = r.deletedCount ?? 0;
    }

    if (targets.includes('agent-alerts-resolved')) {
      // Only delete alerts that have been resolved AND are older than cutoff
      const r = await AgentAlertModel.deleteMany({
        resolvedAt: { $ne: null, $lt: cutoff }
      });
      result['agent-alerts-resolved'] = r.deletedCount ?? 0;
    }

    if (targets.includes('audit-logs')) {
      const r = await AuditLogModel.deleteMany({ createdAt: { $lt: cutoff } });
      result['audit-logs'] = r.deletedCount ?? 0;
    }

    if (targets.includes('notifications-read')) {
      const r = await NotificationModel.deleteMany({ read: true, createdAt: { $lt: cutoff } });
      result['notifications-read'] = r.deletedCount ?? 0;
    }

    const total = Object.values(result).reduce((s, n) => s + n, 0);
    await AuditLogModel.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorUserId: req.user!.id,
      action: 'db_cleanup',
      metadata: JSON.stringify({ targets, olderThanDays, result }).slice(0, 4000)
    }).catch(() => {});

    return res.json({ deleted: result, total });
  } catch (e) {
    return next(e);
  }
});
