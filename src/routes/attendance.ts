import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AttendanceModel } from '../models/Attendance.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { sendPushToUser } from '../realtime/webpush.js';
import { UserModel } from '../models/User.js';

export const attendanceRouter = Router();

attendanceRouter.use(requireAuth);
attendanceRouter.use(requireDb);

function getClientIp(req: any) {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : String(xff || '');
  const ip = (raw.split(',')[0]?.trim() || req.ip || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
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

    // --- Server-authoritative late-mark + basic validation ---
    // If a check-in time is present, compute late based on branch config and earliest check-in for that user+date.
    if (record.date && record.userId && record.checkInTime) {
      const checkInMs = new Date(record.checkInTime).getTime();
      if (!Number.isFinite(checkInMs)) return res.status(400).json({ error: 'Invalid checkInTime' });

      // Best-effort: find branch schedule
      const branchId = record.branch || 'Main';
      const bc = await BranchConfigModel.findOne({ id: branchId }).lean();
      if (bc?.startTime) {
        const [h, m] = String(bc.startTime).split(':').map(Number);
        const expectedStart = new Date(`${record.date}T00:00:00`);
        expectedStart.setHours(h, m + (bc.lateMarkGraceMinutes || 0), 0, 0);
        const expectedMs = expectedStart.getTime();

        const existing = await AttendanceModel.find({ userId: record.userId, date: record.date, checkInTime: { $ne: null } })
          .select({ checkInTime: 1 })
          .lean();
        const earliestExistingMs = existing
          .map((r: any) => new Date(r.checkInTime).getTime())
          .filter((t: number) => Number.isFinite(t))
          .reduce((min: number, t: number) => Math.min(min, t), Number.POSITIVE_INFINITY);
        const earliestMs = Math.min(earliestExistingMs, checkInMs);
        record.isLate = Number.isFinite(expectedMs) ? earliestMs > expectedMs : !!record.isLate;
      }
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

attendanceRouter.put('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = req.params.id;
    const patch = req.body ?? {};

    if (req.user?.role === 'team') {
      const existing = await AttendanceModel.findOne({ id }).lean();
      if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
      if (existing.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
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

