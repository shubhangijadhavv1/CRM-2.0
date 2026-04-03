import { AttendanceModel, type AttendanceDoc } from '../models/Attendance.js';
import { mergeBreaks, mergeIdleIntervals } from './attendanceMetrics.js';

export async function resolveCanonicalOpenSession(userId: string, date: string): Promise<AttendanceDoc | null> {
  const openRows = await AttendanceModel.find({ userId, date, checkOutTime: null })
    .sort({ checkInTime: -1, updatedAt: -1 })
    .lean();

  if (!openRows || openRows.length === 0) return null;
  const canonical = openRows[0] as AttendanceDoc;
  if (openRows.length === 1) return canonical;

  let mergedBreaks = canonical.breaks || [];
  let mergedIdleIntervals = canonical.idleIntervals || [];
  let mergedIdleMinutes = Number(canonical.idleMinutes || 0);
  let mergedWorkMinutes = Number(canonical.totalWorkMinutes || 0);

  const duplicateIds: string[] = [];
  for (let i = 1; i < openRows.length; i++) {
    const dup = openRows[i] as AttendanceDoc;
    duplicateIds.push(String(dup.id));
    mergedBreaks = mergeBreaks(mergedBreaks, dup.breaks || []);
    mergedIdleIntervals = mergeIdleIntervals(mergedIdleIntervals, dup.idleIntervals || []);
    mergedIdleMinutes = Math.max(mergedIdleMinutes, Number(dup.idleMinutes || 0));
    mergedWorkMinutes = Math.max(mergedWorkMinutes, Number(dup.totalWorkMinutes || 0));
  }

  await AttendanceModel.findOneAndUpdate(
    { id: canonical.id },
    {
      $set: {
        breaks: mergedBreaks,
        idleIntervals: mergedIdleIntervals,
        idleMinutes: mergedIdleMinutes,
        totalWorkMinutes: mergedWorkMinutes,
      },
    },
    { new: false },
  );

  const closeTs = new Date().toISOString();
  await AttendanceModel.updateMany(
    { id: { $in: duplicateIds } },
    { $set: { checkOutTime: closeTs, dailyStatus: 'checked-out' } },
  );

  const refreshed = await AttendanceModel.findOne({ id: canonical.id }).lean();
  return (refreshed as AttendanceDoc) || canonical;
}

export async function getLatestAttendanceForDate(userId: string, date: string): Promise<AttendanceDoc | null> {
  const row = await AttendanceModel.findOne({ userId, date })
    .sort({ checkInTime: -1, updatedAt: -1 })
    .lean();
  return (row as AttendanceDoc) || null;
}
