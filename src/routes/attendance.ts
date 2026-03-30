import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AttendanceModel } from '../models/Attendance.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { sendPushToUser } from '../realtime/webpush.js';
import { UserModel } from '../models/User.js';
import { shiftStartPlusGraceUtcMs } from '../utils/shiftDeadline.js';

export const attendanceRouter = Router();

attendanceRouter.use(requireAuth);
attendanceRouter.use(requireDb);

function getClientIp(req: any) {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : String(xff || '');
  const ip = (raw.split(',')[0]?.trim() || req.ip || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

async function loadBranchConfig(branchKey: string) {
  const k = String(branchKey || 'Main').trim() || 'Main';
  return BranchConfigModel.findOne({ $or: [{ id: k }, { name: k }] }).lean();
}

/** Earliest check-in instant for user+date (optionally excluding one attendance id). */
async function earliestCheckInMs(
  userId: string,
  dateStr: string,
  candidateIso: string,
  excludeAttendanceId?: string,
): Promise<number | null> {
  const candidateMs = new Date(candidateIso).getTime();
  if (!Number.isFinite(candidateMs)) return null;
  const rows = await AttendanceModel.find({
    userId,
    date: dateStr,
    checkInTime: { $ne: null },
  })
    .select({ id: 1, checkInTime: 1 })
    .lean();
  let minMs = candidateMs;
  for (const r of rows as any[]) {
    if (excludeAttendanceId && r.id === excludeAttendanceId) continue;
    const t = new Date(r.checkInTime).getTime();
    if (Number.isFinite(t)) minMs = Math.min(minMs, t);
  }
  return minMs;
}

async function computeIsLateForRecord(params: {
  attendanceId?: string;
  date: string;
  userId: string;
  checkInTime: string;
  branch: string;
}): Promise<boolean | undefined> {
  const bc = await loadBranchConfig(params.branch);
  if (!bc?.startTime) return undefined;
  const expectedMs = shiftStartPlusGraceUtcMs(
    params.date,
    String(bc.startTime),
    Number((bc as any).lateMarkGraceMinutes) || 0,
  );
  if (expectedMs == null) return undefined;
  const earliestMs = await earliestCheckInMs(
    params.userId,
    params.date,
    params.checkInTime,
    params.attendanceId,
  );
  if (earliestMs == null) return undefined;
  return earliestMs > expectedMs;
}

attendanceRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const isTeam = req.user?.role === 'team';
    const q: any = {};
    if (isTeam) q.userId = req.user!.id;
    const docs = await AttendanceModel.find(q).lean();
    const records = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ attendanceRecords: records });
  } catch (e) {
    return next(e);
  }
});

// Upsert by id (client-friendly)
attendanceRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const record = req.body ?? {};
    if (!record.id) return res.status(400).json({ error: 'id is required' });

    // Team can only write their own records
    if (req.user?.role === 'team') {
      record.userId = req.user.id;
    }

    // --- Server-authoritative late-mark (branch id OR name; office offset via BRANCH_UTC_OFFSET_MINUTES) ---
    if (record.date && record.userId && record.checkInTime) {
      const checkInMs = new Date(record.checkInTime).getTime();
      if (!Number.isFinite(checkInMs)) return res.status(400).json({ error: 'Invalid checkInTime' });
      const branchKey = record.branch || 'Main';
      const computed = await computeIsLateForRecord({
        attendanceId: record.id,
        date: record.date,
        userId: record.userId,
        checkInTime: record.checkInTime,
        branch: branchKey,
      });
      if (computed !== undefined) record.isLate = computed;
    }

    // Prefer server IP when not provided by client
    // Always record the real client IP for staff actions.
    if (req.user?.role === 'team') {
      record.ipAddress = getClientIp(req);
    } else if (!record.ipAddress) {
      record.ipAddress = getClientIp(req);
    }

    const updated = await AttendanceModel.findOneAndUpdate(
      { id: record.id },
      { $set: record },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('attendance');

    // Notify admins when a team member checks in late
    if (record.isLate && record.dailyStatus !== 'checked-out' && req.user?.role === 'team') {
      const userName = req.user?.id ? (await UserModel.findById(req.user.id).select('name').lean())?.name : 'Employee';
      const admins = await UserModel.find({ role: { $in: ['admin', 'super-admin'] }, status: 'active' }).select('_id').lean();
      for (const admin of admins) {
        sendPushToUser(String(admin._id), {
          title: 'Late Check-in',
          body: `${userName} checked in late today.`,
          tag: `late-${record.userId}-${record.date}`,
          url: '/'
        }).catch(() => {});
      }
    }

    return res.status(201).json({ attendanceRecord: out });
  } catch (e) {
    return next(e);
  }
});

/**
 * GET /api/attendance/my-summary
 * Returns today's computed time breakdown for the logged-in user.
 * Mirrors computeLiveWorkplaceDisplay() in utils/timeCalc.ts exactly.
 */
attendanceRouter.get('/my-summary', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();

    // Fetch attendance record and user in parallel
    const [record, user] = await Promise.all([
      AttendanceModel.findOne({ userId, date: today, checkOutTime: null })
        .sort({ checkInTime: -1 }).lean() as Promise<any>
        || AttendanceModel.findOne({ userId, date: today })
          .sort({ checkInTime: -1 }).lean() as Promise<any>,
      UserModel.findById(userId)
        .select('browserIsIdle browserIdleForMs lastBrowserHeartbeatAt branch')
        .lean() as Promise<any>,
    ]);

    // Re-run in series if the parallel open-record query returned null
    const rec: any = record ?? await AttendanceModel.findOne({ userId, date: today })
      .sort({ checkInTime: -1 }).lean();

    if (!rec || !rec.checkInTime) return res.json({ summary: null });

    const branchKey = String(rec.branch || (user as any)?.branch || 'Main');
    const bc = await BranchConfigModel.findOne({ $or: [{ id: branchKey }, { name: branchKey }] }).lean() as any;

    // Parse branch times — same defaults as web
    const parseHHMM = (t: string, fallbackMin: number) => {
      const parts = String(t || '').split(':').map(Number);
      return Number.isFinite(parts[0]) ? parts[0] * 60 + (Number.isFinite(parts[1]) ? parts[1] : 0) : fallbackMin;
    };
    const startMin      = parseHHMM(bc?.startTime  || '10:00', 600);
    const endMin        = parseHHMM(bc?.endTime     || '19:00', 1140);
    const lunchStartMin = parseHHMM(bc?.lunchStart  || '13:30', 810);
    const lunchEndMin   = parseHHMM(bc?.lunchEnd    || '14:00', 840);
    const lunchTimeLimit    = Math.max(0, Number(bc?.lunchTimeLimitMinutes)    || 30);
    const teaBreakTimeLimit = Math.max(0, Number(bc?.teaBreakTimeLimitMinutes) || 15);
    const teaAllowMin       = Math.max(0, Number(bc?.teaBreakDurationMinutes)  || 15);

    // --- Break time (wall + capped, same as computeBreakMs) ---
    let allowedBreakMs = 0;
    let excessBreakMs  = 0;
    let lunchWallMs    = 0;
    let teaWallMs      = 0;
    const onBreak = rec.dailyStatus === 'lunch-break' || rec.dailyStatus === 'tea-break';
    const endRef = rec.checkOutTime ? new Date(rec.checkOutTime).getTime() : now;

    for (const b of (rec.breaks || [])) {
      const bStart = new Date(b.startTime).getTime();
      const bEnd   = b.endTime ? new Date(b.endTime).getTime() : endRef;
      if (!Number.isFinite(bStart) || !Number.isFinite(bEnd) || bEnd <= bStart) continue;
      const durMin = Math.floor((bEnd - bStart) / 60000);
      if (b.type === 'lunch') {
        lunchWallMs += bEnd - bStart;
        allowedBreakMs += Math.min(durMin, lunchTimeLimit) * 60000;
        if (durMin > lunchTimeLimit) excessBreakMs += (durMin - lunchTimeLimit) * 60000;
      } else if (b.type === 'tea') {
        teaWallMs += bEnd - bStart;
        allowedBreakMs += Math.min(durMin, teaBreakTimeLimit) * 60000;
        if (durMin > teaBreakTimeLimit) excessBreakMs += (durMin - teaBreakTimeLimit) * 60000;
      }
    }

    // --- Idle time (mirrors computeLiveWorkplaceDisplay exactly) ---
    let displayIdleMs = 0;
    for (const i of (rec.idleIntervals || [])) {
      const iStart = new Date(i.startTime).getTime();
      if (!i.endTime) {
        displayIdleMs += now - iStart;             // open interval — grows live
      } else {
        const iEnd = new Date(i.endTime).getTime();
        if (iEnd > iStart) displayIdleMs += iEnd - iStart;
      }
    }
    const storedIdleMs = (rec.idleMinutes || 0) * 60000;
    if (storedIdleMs > displayIdleMs) displayIdleMs = storedIdleMs;  // floor from stored

    // Add agent-extrapolated idle (same as extrapolateBrowserIdleMs) — but not during breaks
    if (!onBreak && (user as any)?.browserIsIdle) {
      const base = Number((user as any).browserIdleForMs);
      const hbMs = (user as any).lastBrowserHeartbeatAt
        ? new Date((user as any).lastBrowserHeartbeatAt).getTime() : NaN;
      const drift = Number.isFinite(hbMs) && hbMs > 0 ? now - hbMs : 0;
      const agentIdleMs = Number.isFinite(base) && base >= 0
        ? base + (drift > 0 && drift < 2 * 60 * 1000 ? drift : 0)
        : 0;
      if (agentIdleMs > 0) displayIdleMs = Math.max(displayIdleMs, agentIdleMs);
    }

    // --- Session and work time ---
    const checkInMs      = new Date(rec.checkInTime).getTime();
    const totalSessionMs = rec.checkOutTime
      ? new Date(rec.checkOutTime).getTime() - checkInMs
      : now - checkInMs;
    const workMs = Math.max(0, totalSessionMs - allowedBreakMs - displayIdleMs - excessBreakMs);

    // --- Remaining time (mirrors computeLiveWorkplaceDisplay: targetMs - workMs) ---
    const nowDate = new Date(now);
    const y = nowDate.getFullYear(), mo = nowDate.getMonth(), d = nowDate.getDate();
    const shiftStart  = new Date(y, mo, d, Math.floor(startMin / 60),      startMin % 60,      0, 0).getTime();
    const shiftEnd    = new Date(y, mo, d, Math.floor(endMin / 60),        endMin % 60,        0, 0).getTime();
    const lunchStartT = new Date(y, mo, d, Math.floor(lunchStartMin / 60), lunchStartMin % 60, 0, 0).getTime();
    const lunchEndT   = new Date(y, mo, d, Math.floor(lunchEndMin / 60),   lunchEndMin % 60,   0, 0).getTime();
    const workWindowMs = Math.max(0, shiftEnd - shiftStart);
    const lunchBlockMs = Math.max(0, lunchEndT - lunchStartT);
    const teaAllowMs   = teaAllowMin * 60000;
    const targetMs     = Math.max(0, workWindowMs - lunchBlockMs - teaAllowMs);
    const remainingMs  = Math.max(0, targetMs - workMs);

    return res.json({
      summary: {
        shiftMs: Math.max(0, totalSessionMs),
        workMs,
        idleMs: displayIdleMs,
        lunchMs: lunchWallMs,
        breakMs: teaWallMs,
        remainingMs,
        targetMs,
        currentStatus: rec.dailyStatus || 'checked-in',
        checkInTime: rec.checkInTime,
        checkOutTime: rec.checkOutTime || null,
        isCheckedOut: !!rec.checkOutTime,
        branch: rec.branch,
        fetchedAt: now,
      }
    });
  } catch (e) {
    return next(e);
  }
});

attendanceRouter.put('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = req.params.id;
    const patch = req.body ?? {};

    if (req.user?.role === 'team') {
      const existing = await AttendanceModel.findOne({ id }).lean();
      if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
      if (existing.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }

    const existingFull = await AttendanceModel.findOne({ id }).lean();
    if (!existingFull) return res.status(404).json({ error: 'Attendance record not found' });
    const merged: any = { ...(existingFull as any), ...patch };
    if (
      merged.date &&
      merged.userId &&
      merged.checkInTime &&
      (patch.checkInTime != null || patch.date != null || patch.branch != null || patch.userId != null)
    ) {
      const computed = await computeIsLateForRecord({
        attendanceId: id,
        date: merged.date,
        userId: merged.userId,
        checkInTime: merged.checkInTime,
        branch: merged.branch || 'Main',
      });
      if (computed !== undefined) patch.isLate = computed;
    }

    const updated = await AttendanceModel.findOneAndUpdate({ id }, { $set: patch }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Attendance record not found' });
    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('attendance');
    return res.json({ attendanceRecord: out });
  } catch (e) {
    return next(e);
  }
});

