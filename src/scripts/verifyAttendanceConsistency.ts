/**
 * Deterministic consistency checks for attendance metrics engine.
 *
 * Usage: npx tsx src/scripts/verifyAttendanceConsistency.ts
 */
import { computeAttendanceSummary } from '../utils/attendanceMetrics.js';

function assertEqual(name: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

function assertTruthy(name: string, value: unknown) {
  if (!value) throw new Error(`${name} expected truthy`);
}

function run() {
  const cfg = {
    startTime: '10:00',
    endTime: '19:00',
    lunchStart: '13:30',
    lunchEnd: '14:00',
    teaBreakDurationMinutes: 15,
    lunchTimeLimitMinutes: 30,
    teaBreakTimeLimitMinutes: 15,
  };

  const baseDate = '2026-03-31';

  // Scenario 1: web-only active day with idle + lunch.
  const s1 = computeAttendanceSummary({
    record: {
      checkInTime: `${baseDate}T10:00:00.000Z`,
      checkOutTime: null,
      dailyStatus: 'checked-in',
      status: 'present',
      breaks: [{ type: 'lunch', startTime: `${baseDate}T13:30:00.000Z`, endTime: `${baseDate}T13:50:00.000Z` }],
      idleIntervals: [{ startTime: `${baseDate}T11:00:00.000Z`, endTime: `${baseDate}T11:10:00.000Z`, deducted: true }],
      idleMinutes: 10,
      totalWorkMinutes: 0,
      branch: 'Main',
    } as any,
    branchConfig: cfg as any,
    nowMs: new Date(`${baseDate}T14:00:00.000Z`).getTime(),
  });
  assertEqual('s1.lunchMs', s1.lunchMs, 20 * 60000);
  assertEqual('s1.idleMs', s1.idleMs, 10 * 60000);
  assertTruthy('s1.workMs>0', s1.workMs > 0);

  // Scenario 2: mixed web+agent style with tea overflow cap.
  const s2 = computeAttendanceSummary({
    record: {
      checkInTime: `${baseDate}T10:00:00.000Z`,
      checkOutTime: `${baseDate}T18:00:00.000Z`,
      dailyStatus: 'checked-out',
      status: 'present',
      breaks: [{ type: 'tea', startTime: `${baseDate}T16:00:00.000Z`, endTime: `${baseDate}T16:30:00.000Z` }],
      idleIntervals: [],
      idleMinutes: 5,
      totalWorkMinutes: 410,
      branch: 'Main',
    } as any,
    branchConfig: cfg as any,
    nowMs: new Date(`${baseDate}T18:00:00.000Z`).getTime(),
  });
  assertEqual('s2.teaMs', s2.teaMs, 30 * 60000);
  assertEqual('s2.workMsFromStored', s2.workMs, 410 * 60000);

  // Scenario 3: break overlap with open interval.
  const s3 = computeAttendanceSummary({
    record: {
      checkInTime: `${baseDate}T10:00:00.000Z`,
      checkOutTime: null,
      dailyStatus: 'idle',
      status: 'present',
      breaks: [{ type: 'tea', startTime: `${baseDate}T12:00:00.000Z`, endTime: null }],
      idleIntervals: [{ startTime: `${baseDate}T12:10:00.000Z`, endTime: null, deducted: false }],
      idleMinutes: 0,
      totalWorkMinutes: 0,
      branch: 'Main',
    } as any,
    branchConfig: cfg as any,
    nowMs: new Date(`${baseDate}T12:20:00.000Z`).getTime(),
  });
  assertEqual('s3.teaMs', s3.teaMs, 20 * 60000);
  assertEqual('s3.idleMs', s3.idleMs, 10 * 60000);

  // eslint-disable-next-line no-console
  console.log('[verify-attendance-consistency] all scenarios passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
