import type { AttendanceDoc } from '../models/Attendance.js';
import type { BranchConfigDoc } from '../models/BranchConfig.js';

type BreakItem = AttendanceDoc['breaks'][number];
type IdleItem = AttendanceDoc['idleIntervals'][number];

export type AttendanceSummary = {
  shiftMs: number;
  workMs: number;
  idleMs: number;
  lunchMs: number;
  teaMs: number;
  remainingMs: number;
  targetMs: number;
  currentStatus: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  isCheckedOut: boolean;
  branch: string;
  fetchedAt: number;
};

export type FinalizedAttendance = {
  breaks: BreakItem[];
  idleIntervals: IdleItem[];
  idleMinutes: number;
  totalWorkMinutes: number;
  checkOutTime: string;
  dailyStatus: 'checked-out';
  sessions?: { checkIn: string; checkOut: string | null }[];
};

const DEFAULT_CONFIG = {
  startTime: '10:00',
  endTime: '19:00',
  lunchStart: '13:30',
  lunchEnd: '14:00',
  teaBreakDurationMinutes: 15,
  lunchTimeLimitMinutes: 30,
  teaBreakTimeLimitMinutes: 15,
};

function parseHHMMToMinutes(time: string | undefined, fallback: number): number {
  const [h, m] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(h)) return fallback;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

function getTargetWorkMs(config: Partial<BranchConfigDoc>, status: AttendanceDoc['status'] | undefined, nowMs: number): number {
  const base = new Date(nowMs);
  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();

  const startMin = parseHHMMToMinutes(config.startTime, parseHHMMToMinutes(DEFAULT_CONFIG.startTime, 600));
  const endMin = parseHHMMToMinutes(config.endTime, parseHHMMToMinutes(DEFAULT_CONFIG.endTime, 1140));
  const lunchStartMin = parseHHMMToMinutes(config.lunchStart, parseHHMMToMinutes(DEFAULT_CONFIG.lunchStart, 810));
  const lunchEndMin = parseHHMMToMinutes(config.lunchEnd, parseHHMMToMinutes(DEFAULT_CONFIG.lunchEnd, 840));
  const teaAllowMin = Math.max(0, Number(config.teaBreakDurationMinutes) || DEFAULT_CONFIG.teaBreakDurationMinutes);

  const shiftStartMs = new Date(y, mo, d, Math.floor(startMin / 60), startMin % 60, 0, 0).getTime();
  const shiftEndMs = new Date(y, mo, d, Math.floor(endMin / 60), endMin % 60, 0, 0).getTime();
  const lunchStartMs = new Date(y, mo, d, Math.floor(lunchStartMin / 60), lunchStartMin % 60, 0, 0).getTime();
  const lunchEndMs = new Date(y, mo, d, Math.floor(lunchEndMin / 60), lunchEndMin % 60, 0, 0).getTime();

  const shiftWindowMs = Math.max(0, shiftEndMs - shiftStartMs);
  const lunchWindowMs = Math.max(0, lunchEndMs - lunchStartMs);
  const baseTargetMs = Math.max(0, shiftWindowMs - lunchWindowMs - teaAllowMin * 60000);
  if (status === 'half-day') return Math.floor(baseTargetMs / 2);
  return baseTargetMs;
}

function computeBreakTotals(
  breaks: BreakItem[] | undefined,
  nowMs: number,
  lunchLimitMinutes: number,
  teaLimitMinutes: number,
  isOnBreak: boolean = false,
): { lunchWallMs: number; teaWallMs: number; allowedBreakMs: number; excessBreakMs: number } {
  let lunchWallMs = 0;
  let teaWallMs = 0;
  let allowedBreakMs = 0;
  let excessBreakMs = 0;

  (breaks || []).forEach((b) => {
    const start = new Date(b.startTime).getTime();
    // Only use nowMs for open breaks when status confirms employee is on break.
    // Prevents break timer running after break ends but before server closes the entry.
    const end = b.endTime
      ? new Date(b.endTime).getTime()
      : isOnBreak ? nowMs : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    const durationMs = end - start;
    if (b.type === 'lunch') {
      lunchWallMs += durationMs;
      const capMs = Math.max(0, lunchLimitMinutes) * 60000;
      allowedBreakMs += Math.min(durationMs, capMs);
      if (durationMs > capMs) excessBreakMs += durationMs - capMs;
    } else if (b.type === 'tea') {
      teaWallMs += durationMs;
      const capMs = Math.max(0, teaLimitMinutes) * 60000;
      allowedBreakMs += Math.min(durationMs, capMs);
      if (durationMs > capMs) excessBreakMs += durationMs - capMs;
    }
  });

  return { lunchWallMs, teaWallMs, allowedBreakMs, excessBreakMs };
}

export function mergeBreaks(existing: BreakItem[] | undefined, incoming: BreakItem[] | undefined): BreakItem[] {
  const merged = [...(existing || []), ...(incoming || [])];
  const seen = new Set<string>();
  const out: BreakItem[] = [];
  for (const b of merged) {
    const key = `${b.type}|${b.startTime}|${b.endTime || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...b });
  }
  return out.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export function mergeIdleIntervals(existing: IdleItem[] | undefined, incoming: IdleItem[] | undefined): IdleItem[] {
  const merged = [...(existing || []), ...(incoming || [])];
  const seen = new Set<string>();
  const out: IdleItem[] = [];
  for (const i of merged) {
    const key = `${i.startTime}|${i.endTime || ''}|${i.deducted ? '1' : '0'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...i });
  }
  return out.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export function closeOpenIntervals(idleIntervals: IdleItem[] | undefined, nowIso: string): IdleItem[] {
  return (idleIntervals || []).map((i) => (i.endTime ? { ...i } : { ...i, endTime: nowIso, deducted: true }));
}

export function closeOpenBreaks(breaks: BreakItem[] | undefined, nowIso: string): BreakItem[] {
  return (breaks || []).map((b) => (b.endTime ? { ...b } : { ...b, endTime: nowIso }));
}

export function computeIdleMs(
  record: Pick<AttendanceDoc, 'checkInTime' | 'idleIntervals' | 'idleMinutes'>,
  nowMs: number,
): number {
  const checkInMs = record.checkInTime ? new Date(record.checkInTime).getTime() : 0;
  const streakMap = new Map<number, number | null>();

  (record.idleIntervals || []).forEach((i) => {
    const rawStart = new Date(i.startTime).getTime();
    const start = checkInMs > 0 ? Math.max(rawStart, checkInMs) : rawStart;
    const end = i.endTime ? new Date(i.endTime).getTime() : null;
    const existing = streakMap.get(start);
    if (existing === undefined) {
      streakMap.set(start, end);
      return;
    }
    if (existing === null) return;
    if (end === null || end > existing) streakMap.set(start, end);
  });

  let latestOpenStart = -1;
  streakMap.forEach((end, start) => {
    if (end === null && start > latestOpenStart) latestOpenStart = start;
  });

  let idleMs = 0;
  streakMap.forEach((end, start) => {
    if (end === null) {
      if (start === latestOpenStart) idleMs += Math.max(0, nowMs - start);
      return;
    }
    if (end > start) idleMs += end - start;
  });

  const hasIntervals = (record.idleIntervals || []).length > 0;
  if (!hasIntervals) idleMs = Math.max(idleMs, (record.idleMinutes || 0) * 60000);
  const sessionMs = checkInMs > 0 ? Math.max(0, nowMs - checkInMs) : 0;
  if (sessionMs > 0) idleMs = Math.min(idleMs, sessionMs);
  return Math.max(0, idleMs);
}

/**
 * Compute total worked time across all sessions (handles re-check-in on same day).
 * Each session is [checkIn, checkOut]. Open session uses nowMs as end.
 * Falls back to (endRefMs - checkInMs) for records without sessions array.
 */
export function computeTotalSessionMs(
  record: Pick<AttendanceDoc, 'checkInTime' | 'checkOutTime' | 'sessions'>,
  endRefMs: number,
): number {
  const sessions = (record as any).sessions as Array<{ checkIn: string; checkOut: string | null }> | undefined;
  if (sessions && sessions.length > 0) {
    let total = 0;
    for (const s of sessions) {
      const sIn = new Date(s.checkIn).getTime();
      const sOut = s.checkOut ? new Date(s.checkOut).getTime() : endRefMs;
      if (Number.isFinite(sIn) && Number.isFinite(sOut) && sOut > sIn) {
        total += sOut - sIn;
      }
    }
    return Math.max(0, total);
  }
  // Legacy: no sessions array — use single checkIn→endRef span
  const checkInMs = record.checkInTime ? new Date(record.checkInTime).getTime() : 0;
  if (!checkInMs || !Number.isFinite(checkInMs)) return 0;
  return Math.max(0, endRefMs - checkInMs);
}

export function computeAttendanceSummary(params: {
  record: Pick<AttendanceDoc, 'checkInTime' | 'checkOutTime' | 'dailyStatus' | 'status' | 'breaks' | 'idleIntervals' | 'idleMinutes' | 'totalWorkMinutes' | 'branch'>;
  branchConfig?: Partial<BranchConfigDoc> | null;
  nowMs?: number;
}): AttendanceSummary {
  const nowMs = params.nowMs ?? Date.now();
  const cfg = params.branchConfig || {};
  const checkInMs = params.record.checkInTime ? new Date(params.record.checkInTime).getTime() : 0;
  const checkOutMs = params.record.checkOutTime ? new Date(params.record.checkOutTime).getTime() : 0;
  const isCheckedOut = Boolean(params.record.checkOutTime || params.record.dailyStatus === 'checked-out');
  const endRefMs = checkOutMs || nowMs;

  if (!checkInMs || !Number.isFinite(checkInMs)) {
    return {
      shiftMs: 0,
      workMs: 0,
      idleMs: 0,
      lunchMs: 0,
      teaMs: 0,
      remainingMs: 0,
      targetMs: 0,
      currentStatus: 'checked-out',
      checkInTime: null,
      checkOutTime: params.record.checkOutTime || null,
      isCheckedOut,
      branch: params.record.branch || '',
      fetchedAt: nowMs,
    };
  }

  const lunchLimit = Math.max(0, Number(cfg.lunchTimeLimitMinutes) || DEFAULT_CONFIG.lunchTimeLimitMinutes);
  const teaLimit = Math.max(0, Number(cfg.teaBreakTimeLimitMinutes) || DEFAULT_CONFIG.teaBreakTimeLimitMinutes);
  const isOnBreak = params.record.dailyStatus === 'lunch-break' || params.record.dailyStatus === 'tea-break';
  const breakTotals = computeBreakTotals(params.record.breaks, endRefMs, lunchLimit, teaLimit, isOnBreak);
  // shiftMs = total time from first check-in to now (wall clock including gaps between sessions)
  const shiftMs = Math.max(0, endRefMs - checkInMs);
  // totalSessionMs = actual time spent clocked in (sum of all sessions, excludes gaps between sessions)
  const totalSessionMs = computeTotalSessionMs(params.record as any, endRefMs);

  if (isCheckedOut) {
    const targetMs = getTargetWorkMs(cfg, params.record.status, endRefMs);
    const storedWorkMs = Math.max(0, Number(params.record.totalWorkMinutes || 0) * 60000);
    const storedIdleMs = Math.max(0, Number(params.record.idleMinutes || 0) * 60000);
    const derivedIdleMs = computeIdleMs(params.record, endRefMs);
    const hasIntervals = (params.record.idleIntervals || []).length > 0;
    const idleMs = hasIntervals
      ? derivedIdleMs
      : Math.max(derivedIdleMs, storedIdleMs);
    const recomputedWorkMs = Math.max(0, totalSessionMs - breakTotals.allowedBreakMs - idleMs - breakTotals.excessBreakMs);
    const workMs = storedWorkMs > 0 ? Math.min(storedWorkMs, totalSessionMs) : recomputedWorkMs;
    return {
      shiftMs,
      workMs,
      idleMs,
      lunchMs: breakTotals.lunchWallMs,
      teaMs: breakTotals.teaWallMs,
      // Session is already closed; reports should show no pending remaining time.
      remainingMs: 0,
      targetMs,
      currentStatus: 'checked-out',
      checkInTime: params.record.checkInTime || null,
      checkOutTime: params.record.checkOutTime || null,
      isCheckedOut: true,
      branch: params.record.branch || '',
      fetchedAt: nowMs,
    };
  }

  // When on break, freeze work/idle at break start time so work doesn't reduce during break.
  let idleRefMs = endRefMs;
  let workRefMs = endRefMs;
  if (isOnBreak) {
    const openBreak = [...(params.record.breaks || [])].reverse().find(b => !b.endTime);
    if (openBreak) {
      const bStartMs = new Date(openBreak.startTime).getTime();
      if (Number.isFinite(bStartMs) && bStartMs > checkInMs) {
        idleRefMs = bStartMs;
        workRefMs = bStartMs;
      }
    }
  }
  const frozenSessionMs = isOnBreak ? computeTotalSessionMs(params.record as any, workRefMs) : totalSessionMs;
  const frozenBreakTotals = isOnBreak
    ? computeBreakTotals(params.record.breaks, workRefMs, lunchLimit, teaLimit)
    : breakTotals;
  const idleMs = computeIdleMs(params.record, idleRefMs);
  const computedWorkMs = Math.max(0, frozenSessionMs - frozenBreakTotals.allowedBreakMs - idleMs - frozenBreakTotals.excessBreakMs);
  const storedWorkMs = Math.max(0, Number(params.record.totalWorkMinutes || 0) * 60000);
  // Keep running work total monotonic during active session; never jump backward to zero.
  const workMs = Math.max(computedWorkMs, storedWorkMs);
  const targetMs = getTargetWorkMs(cfg, params.record.status, endRefMs);
  return {
    shiftMs,
    workMs,
    idleMs,
    lunchMs: breakTotals.lunchWallMs,
    teaMs: breakTotals.teaWallMs,
    remainingMs: Math.max(0, targetMs - workMs),
    targetMs,
    currentStatus: params.record.dailyStatus || 'checked-in',
    checkInTime: params.record.checkInTime || null,
    checkOutTime: params.record.checkOutTime || null,
    isCheckedOut: false,
    branch: params.record.branch || '',
    fetchedAt: nowMs,
  };
}

export function finalizeAttendanceRecord(params: {
  record: Pick<AttendanceDoc, 'checkInTime' | 'breaks' | 'idleIntervals' | 'idleMinutes' | 'status' | 'dailyStatus' | 'branch'>;
  branchConfig?: Partial<BranchConfigDoc> | null;
  nowMs?: number;
}): FinalizedAttendance {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const closedBreaks = closeOpenBreaks(params.record.breaks, nowIso);
  const closedIdle = closeOpenIntervals(params.record.idleIntervals, nowIso);
  // Close the open session in sessions array (if present)
  const rawSessions = (params.record as any).sessions as Array<{ checkIn: string; checkOut: string | null }> | undefined;
  const closedSessions = rawSessions
    ? rawSessions.map((s) => s.checkOut === null ? { ...s, checkOut: nowIso } : s)
    : undefined;
  const summary = computeAttendanceSummary({
    record: {
      ...params.record,
      checkOutTime: nowIso,
      breaks: closedBreaks,
      idleIntervals: closedIdle,
      dailyStatus: 'checked-out',
      totalWorkMinutes: 0,
      ...(closedSessions ? { sessions: closedSessions } : {}),
    },
    branchConfig: params.branchConfig,
    nowMs,
  });

  return {
    breaks: closedBreaks,
    idleIntervals: closedIdle,
    idleMinutes: Math.floor(summary.idleMs / 60000),
    totalWorkMinutes: Math.floor(summary.workMs / 60000),
    checkOutTime: nowIso,
    dailyStatus: 'checked-out',
    ...(closedSessions ? { sessions: closedSessions } : {}),
  };
}
