import { AttendanceModel, type AttendanceDoc } from '../models/Attendance.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { shiftStartPlusGraceUtcMs } from './shiftDeadline.js';
import { mergeBreaks, mergeIdleIntervals, computeAttendanceSummary, finalizeAttendanceRecord } from './attendanceMetrics.js';
import { emitInvalidate } from '../realtime/invalidate.js';

/** Returns the today string in local IST (UTC+5:30) precisely. */
export const getLocalTodayStr = (): string => {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
};

/**
 * Ensures there is only ONE attendance record for a user on a specific date.
 * Strictly avoids merging across different dates to prevent "24-hour" carry-over.
 */
export const resolveMasterRecord = async (userId: string, date: string): Promise<AttendanceDoc | null> => {
  const rows = await AttendanceModel.find({ userId, date }).sort({ checkInTime: 1 }).lean();
  
  // Filtering for same-day check-in only (security/drift filter)
  const todayRows = rows.filter(r => r.checkInTime && r.checkInTime.startsWith(date));
  if (todayRows.length === 0) return null;
  if (todayRows.length === 1) return todayRows[0] as AttendanceDoc;

  // Multiple records exist for the same day — merge them into one canonical view.
  // We use the oldest record for check-in and the most recently updated for status fields.
  const latest = [...todayRows].sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())[0];
  const first = todayRows[0];

  const sessions = todayRows.flatMap(r => (r as any).sessions || []);
  const breaks = todayRows.flatMap(r => r.breaks || []);
  const idleIntervals = todayRows.flatMap(r => r.idleIntervals || []);

  const merged: any = {
    ...latest,
    checkInTime: first.checkInTime,
    sessions: sessions.length > 0 ? sessions : undefined,
    breaks,
    idleIntervals,
    // We don't merge checkOutTime here to avoid marking an open record as closed 
    // unless the "latest" one is also closed.
  };

  return merged as AttendanceDoc;
};

export const resolveCanonicalOpenSession = async (userId: string, date: string): Promise<AttendanceDoc | null> => {
  const master = await resolveMasterRecord(userId, date);
  if (!master || master.checkOutTime !== null) return null;
  return master;
};

export const getLatestAttendanceForDate = async (userId: string, date: string): Promise<AttendanceDoc | null> => {
  return resolveMasterRecord(userId, date);
};

export const isSameDay = (d1: Date | number | string, d2: Date | number | string): boolean => {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
};

/** Earliest check-in instant for user+date (optionally excluding one attendance id). */
export async function earliestCheckInMs(
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

export async function computeIsLateForRecord(params: {
  attendanceId?: string;
  date: string;
  userId: string;
  checkInTime: string;
  branch: string;
}): Promise<boolean | undefined> {
  const k = String(params.branch || 'Main').trim() || 'Main';
  const bc = await BranchConfigModel.findOne({ $or: [{ id: k }, { name: k }] }).lean() as any;
  if (!bc?.startTime) return undefined;
  
  const expectedMs = shiftStartPlusGraceUtcMs(
    params.date,
    String(bc.startTime),
    Number(bc.lateMarkGraceMinutes) || 0,
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

export async function maybeAutoCheckout(record: AttendanceDoc, nowMs: number): Promise<AttendanceDoc | null> {
  if (!record || record.dailyStatus === 'checked-out') return null;

  const branchId = String(record.branch || 'Main');
  const branchConfig = await BranchConfigModel.findOne({ $or: [{ id: branchId }, { name: branchId }] }).lean() as any;

  const summary = computeAttendanceSummary({
    record: record as any,
    branchConfig,
    nowMs
  });

  // Auto-checkout if work target reached
  if (summary.targetMs > 0 && summary.workMs >= summary.targetMs) {
    const finalized = finalizeAttendanceRecord({
      record: record as any,
      branchConfig,
      nowMs
    });
    const updated = await AttendanceModel.findOneAndUpdate(
      { id: record.id },
      { $set: finalized },
      { new: true }
    ).lean() as any;
    emitInvalidate('attendance');
    return updated;
  }

  return null;
}

