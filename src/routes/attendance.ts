import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AttendanceModel } from '../models/Attendance.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { sendPushToUser } from '../realtime/webpush.js';
import { UserModel } from '../models/User.js';
import { shiftStartPlusGraceUtcMs } from '../utils/shiftDeadline.js';
import { computeAttendanceSummary, mergeBreaks, mergeIdleIntervals } from '../utils/attendanceMetrics.js';
import * as attendanceUtils from '../utils/attendanceSession.js';

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

// ... (other functions) ...

function isAllowedDailyStatusTransition(from: string | undefined, to: string | undefined, payload?: any): boolean {
  if (!from || !to || from === to) return true;
  // Allow re-check-in: checked-out → checked-in only when sessions array is being extended
  if (from === 'checked-out') {
    if (to === 'checked-in' && payload?.sessions && Array.isArray(payload.sessions) && payload.sessions.length > 1) return true;
    return false;
  }
  if (from === 'checked-in') return ['idle', 'lunch-break', 'tea-break', 'checked-out', 'background'].includes(to);
  if (from === 'idle') return ['checked-in', 'checked-out', 'background'].includes(to);
  if (from === 'background') return ['checked-in', 'idle', 'checked-out'].includes(to);
  if (from === 'lunch-break' || from === 'tea-break') return ['checked-in', 'checked-out'].includes(to);
  return false;
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

    // 1. Guard: Ensure the ID matches the date in the database (prevent cross-day drift)
    const existingById = await AttendanceModel.findOne({ id: record.id }).lean() as any;
    if (existingById && existingById.date !== record.date) {
      return res.status(400).json({
        error: `Session ID drift detected. Record ${record.id} belongs to ${existingById.date}, but you sent ${record.date}.`
      });
    }

    // 2. Guard: Ensure the primary checkInTime matches the record date
    if (record.checkInTime && !record.checkInTime.startsWith(record.date)) {
      return res.status(400).json({
        error: `Fatal date mismatch: checkInTime (${record.checkInTime}) does not match record date (${record.date}).`
      });
    }

    // 3. Resolve Master Record (today's canonical record for this user)
    if (record.userId && record.date && record.checkOutTime == null) {
      const canonical = await attendanceUtils.resolveMasterRecord(String(record.userId), String(record.date));
      if (canonical && canonical.id !== record.id) {
        // Force the client to use the existing canonical ID for today
        record.id = canonical.id;
        record.checkInTime = canonical.checkInTime || record.checkInTime;
        // 1. Merge and Deduplicate Sessions by merging overlaps
        const canonicalSessions = Array.isArray(canonical.sessions) ? canonical.sessions : [];
        const recordsessions = Array.isArray(record.sessions) ? record.sessions : [];

        const allSessions = [...canonicalSessions, ...recordsessions]
          .filter(s => s.checkIn && s.checkIn.startsWith(record.date))
          .map(s => ({
            in: new Date(s.checkIn).getTime(),
            out: s.checkOut ? new Date(s.checkOut).getTime() : Date.now()
          }))
          .sort((a, b) => a.in - b.in);

        const merged: any[] = [];
        allSessions.forEach(curr => {
          const prev = merged[merged.length - 1];
          if (!prev || curr.in > prev.out + 60000) { // 1 min gap allowed
            merged.push(curr);
          } else {
            prev.out = Math.max(prev.out, curr.out);
          }
        });
        record.sessions = merged.map(m => ({
          checkIn: new Date(m.in).toISOString(),
          checkOut: (m.out >= Date.now() - 30000) ? null : new Date(m.out).toISOString()
        }));

        // 2. Merge and Deduplicate Breaks
        const canonicalBreaks = Array.isArray(canonical.breaks) ? canonical.breaks : [];
        const incomingBreaks = Array.isArray(record.breaks) ? record.breaks : [];
        const breakMap = new Map();
        canonicalBreaks.forEach(b => { if (b.startTime) breakMap.set(b.startTime, b); });
        incomingBreaks.forEach(b => {
          if (b.startTime && b.startTime.startsWith(record.date)) {
            const existing = breakMap.get(b.startTime);
            if (!existing || (!existing.endTime && b.endTime)) {
              breakMap.set(b.startTime, b);
            }
          }
        });
        record.breaks = Array.from(breakMap.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));

        // 3. Merge and Deduplicate Idle Intervals
        const canonicalIdle = Array.isArray(canonical.idleIntervals) ? canonical.idleIntervals : [];
        const incomingIdle = Array.isArray(record.idleIntervals) ? record.idleIntervals : [];
        const idleMap = new Map();
        canonicalIdle.forEach(i => { if (i.startTime) idleMap.set(i.startTime, i); });
        incomingIdle.forEach(i => {
          if (i.startTime && i.startTime.startsWith(record.date)) {
            const existing = idleMap.get(i.startTime);
            if (!existing || (!existing.endTime && i.endTime)) {
              idleMap.set(i.startTime, i);
            }
          }
        });
        record.idleIntervals = Array.from(idleMap.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));

        record.idleMinutes = Math.max(Number(canonical.idleMinutes || 0), Number(record.idleMinutes || 0));
        record.totalWorkMinutes = Math.max(Number(canonical.totalWorkMinutes || 0), Number(record.totalWorkMinutes || 0));
      }
    }

    // 4. Final session scrubbing: NEVER allow yesterday's sessions in today's record
    if (Array.isArray(record.sessions)) {
      record.sessions = record.sessions.filter((s: any) => s.checkIn && s.checkIn.startsWith(record.date));
    }

    // --- Server-authoritative late-mark (branch id OR name; office offset via BRANCH_UTC_OFFSET_MINUTES) ---
    if (record.date && record.userId && record.checkInTime) {
      const checkInMs = new Date(record.checkInTime).getTime();
      if (!Number.isFinite(checkInMs)) return res.status(400).json({ error: 'Invalid checkInTime' });
      const branchKey = record.branch || 'Main';
      const computed = await attendanceUtils.computeIsLateForRecord({
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

    const existing = await AttendanceModel.findOne({ id: record.id }).lean();
    const isReCheckIn = existing?.checkOutTime && record.checkOutTime == null &&
      record.dailyStatus === 'checked-in' &&
      Array.isArray(record.sessions) && record.sessions.length > 1;
    if (existing?.checkOutTime && record.checkOutTime == null && !isReCheckIn) {
      return res.status(409).json({ error: 'Cannot reopen a checked-out session through attendance upsert.' });
    }
    if (existing?.dailyStatus && record.dailyStatus && !isAllowedDailyStatusTransition(existing.dailyStatus, record.dailyStatus, record)) {
      record.dailyStatus = existing.dailyStatus;
    }
    if (existing && !existing.checkOutTime && record.checkOutTime == null) {
      // Protect cumulative same-day totals from stale client snapshots that send smaller values.
      record.idleMinutes = Math.max(Number(existing.idleMinutes || 0), Number(record.idleMinutes || 0));
      record.totalWorkMinutes = Math.max(Number(existing.totalWorkMinutes || 0), Number(record.totalWorkMinutes || 0));
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
        }).catch(() => { });
      }
    }

    return res.status(201).json({ attendanceRecord: out });
  } catch (e) {
    return next(e);
  }
});

/**
 * POST /api/attendance/:id/break/start
 * Body: { type: "lunch" | "tea" }
 * Atomically adds a break entry and sets dailyStatus.
 */
attendanceRouter.post('/:id/break/start', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.params;
    const type = req.body?.type;

    if (type !== 'lunch' && type !== 'tea') {
      return res.status(400).json({ error: 'type must be "lunch" or "tea"' });
    }

    const existing = await AttendanceModel.findOne({ id }).lean() as any;
    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

    if (req.user?.role === 'team' && existing.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const allowed = ['checked-in', 'idle', 'background'];
    if (!allowed.includes(existing.dailyStatus)) {
      return res.status(409).json({ error: `Cannot start break from status: ${existing.dailyStatus}` });
    }

    const alreadyHas = (existing.breaks || []).some((b: any) => b.type === type);
    if (alreadyHas) {
      return res.status(409).json({ error: `${type} break already taken today` });
    }

    const nowIso = new Date().toISOString();
    const newBreak = { type, startTime: nowIso, endTime: null };
    const newStatus = type === 'lunch' ? 'lunch-break' : 'tea-break';

    const updated = await AttendanceModel.findOneAndUpdate(
      { id },
      {
        $set: { dailyStatus: newStatus },
        $push: { breaks: newBreak },
      },
      { new: true }
    ).lean() as any;

    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('attendance');

    return res.status(200).json({ attendanceRecord: out });
  } catch (e) {
    return next(e);
  }
});

/**
 * POST /api/attendance/:id/break/end
 * Closes the open break entry and sets dailyStatus back to checked-in.
 */
attendanceRouter.post('/:id/break/end', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.params;

    const existing = await AttendanceModel.findOne({ id }).lean() as any;
    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

    if (req.user?.role === 'team' && existing.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (existing.dailyStatus !== 'lunch-break' && existing.dailyStatus !== 'tea-break') {
      return res.status(409).json({ error: `Not currently on break (status: ${existing.dailyStatus})` });
    }

    const nowIso = new Date().toISOString();

    const updated = await AttendanceModel.findOneAndUpdate(
      { id },
      {
        $set: {
          dailyStatus: 'checked-in',
          'breaks.$[openBreak].endTime': nowIso,
        },
      },
      {
        arrayFilters: [{ 'openBreak.endTime': null }],
        new: true,
      }
    ).lean() as any;

    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('attendance');

    return res.status(200).json({ attendanceRecord: out });
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
    const today = attendanceUtils.getLocalTodayStr();
    const now = Date.now();
    const rec: any = await attendanceUtils.resolveMasterRecord(userId, today);

    if (!rec || !rec.checkInTime) {
      return res.json({ summary: null });
    }

    const branchKey = String(rec.branch || 'Main');
    const bc = await BranchConfigModel.findOne({ $or: [{ id: branchKey }, { name: branchKey }] }).lean() as any;
    // Sanitize in case of legacy drift in DB
    const sanitizedRec = {
      ...rec,
      idleMinutes: (rec.checkInTime && rec.checkInTime.startsWith(today)) ? rec.idleMinutes : 0,
      totalWorkMinutes: (rec.checkInTime && rec.checkInTime.startsWith(today)) ? rec.totalWorkMinutes : 0,
    };

    // Auto-repair: If record has checkInTime but NO sessions, re-create the session to fix the display.
    if ((!rec.sessions || rec.sessions.length === 0) && rec.checkInTime && rec.checkInTime.startsWith(today)) {
      const repairedSessions = [{
        checkIn: rec.checkInTime,
        checkOut: rec.checkOutTime || (rec.dailyStatus === 'checked-out' ? rec.updatedAt : null)
      }];
      await AttendanceModel.findOneAndUpdate({ id: rec.id }, { $set: { sessions: repairedSessions } });
      rec.sessions = repairedSessions;
    }

    let summary = computeAttendanceSummary({
      record: sanitizedRec,
      branchConfig: bc || undefined,
      nowMs: now,
    });

    // Final safety: if summary is missing core fields or is zero despite being checked in, 
    // calculate a basic 'wall-clock' shift to ensure the agent shows SOMETHING.
    if (sanitizedRec.checkInTime && sanitizedRec.checkInTime.startsWith(today)) {
      const checkInMs = new Date(sanitizedRec.checkInTime).getTime();
      const wallShiftMs = Math.max(0, now - checkInMs);
      if ((summary.shiftMs || 0) < 60000) summary.shiftMs = wallShiftMs;
      // If workMs is 0, estimate it as shiftMs - idle (roughly)
      if ((summary.workMs || 0) < 60000) summary.workMs = Math.max(0, wallShiftMs - (summary.idleMs || 0));
    }

    return res.json({
      summary: { ...summary, breakMs: summary.teaMs }
    });
  } catch (e) {
    return next(e);
  }
});

attendanceRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { id } = req.params;
    const doc = await AttendanceModel.findOne({ id }).lean() as any;
    if (!doc) return res.status(404).json({ error: 'Attendance record not found' });
    if (req.user?.role === 'team' && doc.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const out: any = { ...doc };
    delete out._id;
    delete out.__v;
    return res.json({ attendanceRecord: out });
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
    if ((existingFull as any).checkOutTime && patch.checkOutTime == null) {
      return res.status(409).json({ error: 'Cannot reopen a checked-out session.' });
    }
    const merged: any = { ...(existingFull as any), ...patch };
    if (patch.dailyStatus && !isAllowedDailyStatusTransition((existingFull as any).dailyStatus, patch.dailyStatus)) {
      patch.dailyStatus = (existingFull as any).dailyStatus;
    }
    if (!(existingFull as any).checkOutTime && patch.checkOutTime == null) {
      // Do not allow stale updates to reduce running daily totals mid-session.
      if (patch.idleMinutes != null) {
        patch.idleMinutes = Math.max(Number((existingFull as any).idleMinutes || 0), Number(patch.idleMinutes || 0));
      }
      if (patch.totalWorkMinutes != null) {
        patch.totalWorkMinutes = Math.max(Number((existingFull as any).totalWorkMinutes || 0), Number(patch.totalWorkMinutes || 0));
      }
    }
    if (
      merged.date &&
      merged.userId &&
      merged.checkInTime &&
      (patch.checkInTime != null || patch.date != null || patch.branch != null || patch.userId != null)
    ) {
      const computed = await attendanceUtils.computeIsLateForRecord({
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

    if ((out as any).userId && (out as any).date && !out.checkOutTime) {
      await resolveCanonicalOpenSession(String((out as any).userId), String((out as any).date));
    }
    emitInvalidate('attendance');
    return res.json({ attendanceRecord: out });
  } catch (e) {
    return next(e);
  }
});

