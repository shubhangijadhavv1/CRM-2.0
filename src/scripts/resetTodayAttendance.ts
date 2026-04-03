/**
 * Reset timed fields for ALL attendance rows for "today" (UTC date, same as heartbeat code).
 * Clears idle, breaks, and stored work minutes; normalizes dailyStatus for open sessions.
 *
 * Usage (from server/): npx tsx src/scripts/resetTodayAttendance.ts
 */
import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { AttendanceModel } from '../models/Attendance.js';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');
  await connectMongo(mongoUri);

  const todayStr = new Date().toISOString().split('T')[0];

  const baseSet = {
    idleIntervals: [] as [],
    idleMinutes: 0,
    breaks: [] as [],
    totalWorkMinutes: 0,
  };

  const open = await AttendanceModel.updateMany(
    { date: todayStr, $or: [{ checkOutTime: null }, { checkOutTime: '' }] },
    { $set: { ...baseSet, dailyStatus: 'checked-in' as const } },
  );
  const closed = await AttendanceModel.updateMany(
    { date: todayStr, checkOutTime: { $nin: [null, ''] } },
    { $set: { ...baseSet, dailyStatus: 'checked-out' as const } },
  );

  // eslint-disable-next-line no-console
  console.log(`[reset-today-attendance] date=${todayStr} openSessionsModified=${open.modifiedCount} closedSessionsModified=${closed.modifiedCount}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
