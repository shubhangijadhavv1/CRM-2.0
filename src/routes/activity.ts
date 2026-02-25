import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel } from '../models/User.js';
import { AttendanceModel } from '../models/Attendance.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const activityRouter = Router();

activityRouter.use(requireAuth);
activityRouter.use(requireDb);

activityRouter.post('/heartbeat', async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body ?? {};
    const lastActivityAt = Number(body.lastActivityAt);
    const serverIdleAfterMs = Math.max(5001, Number(process.env.BROWSER_IDLE_AFTER_MS) || 60000);
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

    const updated = await UserModel.findByIdAndUpdate(req.user!.id, { $set: patch }, { new: true }).lean();
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

