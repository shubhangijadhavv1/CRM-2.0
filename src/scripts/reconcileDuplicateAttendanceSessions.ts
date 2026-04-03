/**
 * Reconcile duplicate attendance rows by user/day.
 *
 * Strategy:
 * - Pick canonical row with latest valid check-in.
 * - Merge break + idle intervals from all rows.
 * - Recompute canonical totals using shared metrics engine.
 * - Close all non-canonical rows as checked-out.
 *
 * Usage: npx tsx src/scripts/reconcileDuplicateAttendanceSessions.ts
 */
import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { AttendanceModel } from '../models/Attendance.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { computeAttendanceSummary, mergeBreaks, mergeIdleIntervals } from '../utils/attendanceMetrics.js';

type AnyAttendance = any;

function sortByCanonicalPriority(rows: AnyAttendance[]): AnyAttendance[] {
  return [...rows].sort((a, b) => {
    const aIn = a.checkInTime ? new Date(a.checkInTime).getTime() : 0;
    const bIn = b.checkInTime ? new Date(b.checkInTime).getTime() : 0;
    if (aIn !== bIn) return bIn - aIn;
    const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bUpdated - aUpdated;
  });
}

async function reconcileOneGroup(rows: AnyAttendance[]): Promise<{ canonicalId: string; closedCount: number }> {
  const ordered = sortByCanonicalPriority(rows);
  const canonical = ordered[0];
  const rest = ordered.slice(1);
  const branchKey = String(canonical.branch || 'Main');
  const branchConfig = await BranchConfigModel.findOne({ $or: [{ id: branchKey }, { name: branchKey }] }).lean();

  let mergedBreaks = canonical.breaks || [];
  let mergedIdleIntervals = canonical.idleIntervals || [];
  for (const r of rest) {
    mergedBreaks = mergeBreaks(mergedBreaks, r.breaks || []);
    mergedIdleIntervals = mergeIdleIntervals(mergedIdleIntervals, r.idleIntervals || []);
  }

  const checkOutTime = canonical.checkOutTime || null;
  const nowMs = checkOutTime ? new Date(checkOutTime).getTime() : Date.now();
  const summary = computeAttendanceSummary({
    record: {
      ...canonical,
      breaks: mergedBreaks,
      idleIntervals: mergedIdleIntervals,
      checkOutTime,
      dailyStatus: checkOutTime ? 'checked-out' : canonical.dailyStatus || 'checked-in',
    },
    branchConfig: branchConfig || undefined,
    nowMs,
  });

  await AttendanceModel.findOneAndUpdate(
    { id: canonical.id },
    {
      $set: {
        breaks: mergedBreaks,
        idleIntervals: mergedIdleIntervals,
        idleMinutes: Math.floor(summary.idleMs / 60000),
        totalWorkMinutes: Math.floor(summary.workMs / 60000),
        dailyStatus: checkOutTime ? 'checked-out' : (canonical.dailyStatus || 'checked-in'),
      },
    },
    { new: false },
  );

  if (rest.length > 0) {
    await AttendanceModel.updateMany(
      { id: { $in: rest.map((r) => r.id) } },
      { $set: { dailyStatus: 'checked-out', checkOutTime: new Date().toISOString() } },
    );
  }

  return { canonicalId: canonical.id, closedCount: rest.length };
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');
  await connectMongo(mongoUri);

  const docs = await AttendanceModel.find({})
    .select({ id: 1, userId: 1, date: 1, checkInTime: 1, checkOutTime: 1, dailyStatus: 1, breaks: 1, idleIntervals: 1, branch: 1, totalWorkMinutes: 1, idleMinutes: 1, updatedAt: 1 })
    .lean();

  const groups = new Map<string, AnyAttendance[]>();
  for (const row of docs as AnyAttendance[]) {
    const key = `${row.userId}|${row.date}`;
    const arr = groups.get(key) || [];
    arr.push(row);
    groups.set(key, arr);
  }

  let touchedGroups = 0;
  let closedRows = 0;
  for (const [, rows] of groups) {
    if (rows.length <= 1) continue;
    const out = await reconcileOneGroup(rows);
    if (out.closedCount > 0) {
      touchedGroups += 1;
      closedRows += out.closedCount;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[reconcile-duplicate-attendance] groupsReconciled=${touchedGroups} duplicateRowsClosed=${closedRows}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
