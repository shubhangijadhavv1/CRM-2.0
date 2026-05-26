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
  currentStatus: string = '',
): { lunchWallMs: number; teaWallMs: number; allowedBreakMs: number; excessBreakMs: number } {
  let lunchWallMs = 0;
  let teaWallMs = 0;
  let allowedBreakMs = 0;
  let excessBreakMs = 0;

  const rawBreaks = (breaks || []).filter(b => b.startTime).map(b => {
    const bStart = new Date(b.startTime).getTime();
    const isThisBreakActive = !b.endTime && isOnBreak && currentStatus === (b.type === 'lunch' ? 'lunch-break' : 'tea-break');
    const bEnd = b.endTime ? new Date(b.endTime).getTime() : (isThisBreakActive ? nowMs : bStart);
    return { type: b.type, start: bStart, end: bEnd };
  }).filter(b => b.end > b.start).sort((a, b) => a.start - b.start);

  // Group by type and merge
  const lunchRanges: { start: number; end: number }[] = [];
  const teaRanges: { start: number; end: number }[] = [];

  rawBreaks.forEach(curr => {
    const list = curr.type === 'lunch' ? lunchRanges : teaRanges;
    const prev = list[list.length - 1];
    if (!prev || curr.start > prev.end) {
      list.push({ start: curr.start, end: curr.end });
    } else {
      prev.end = Math.max(prev.end, curr.end);
    }
  });

  lunchRanges.forEach(r => {
    const durationMs = r.end - r.start;
    lunchWallMs += durationMs;
    const capMs = Math.max(0, lunchLimitMinutes) * 60000;
    allowedBreakMs += Math.min(durationMs, capMs);
    if (durationMs > capMs) excessBreakMs += durationMs - capMs;
  });

  teaRanges.forEach(r => {
    const durationMs = r.end - r.start;
    teaWallMs += durationMs;
    const capMs = Math.max(0, teaLimitMinutes) * 60000;
    allowedBreakMs += Math.min(durationMs, capMs);
    if (durationMs > capMs) excessBreakMs += durationMs - capMs;
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
  record: Pick<AttendanceDoc, 'checkInTime' | 'idleIntervals' | 'idleMinutes' | 'sessions'>,
  nowMs: number,
): number {
  // Strict same-day check: Session must start on the same date as the parent record
  const parentDate = (record as any).date || (record.checkInTime ? record.checkInTime.split('T')[0] : '');
  const rawSessions = ((record as any).sessions || [])
    .filter((s: any) => s.checkIn && s.checkIn.startsWith(parentDate))
    .map((s: any) => ({
      in: new Date(s.checkIn).getTime(),
      out: s.checkOut ? new Date(s.checkOut).getTime() : nowMs
    }))
    .sort((a, b) => a.in - b.in);

  const mergedSessions: { in: number, out: number }[] = [];
  rawSessions.forEach(curr => {
    const prev = mergedSessions[mergedSessions.length - 1];
    if (!prev || curr.in > prev.out) {
      mergedSessions.push(curr);
    } else {
      prev.out = Math.max(prev.out, curr.out);
    }
  });

  const firstSessionTime = mergedSessions.length > 0 ? mergedSessions[0].in : 0;
  const checkInMs = (record.checkInTime && record.checkInTime.startsWith(parentDate)) 
    ? new Date(record.checkInTime).getTime() 
    : firstSessionTime;

  const streakMap = new Map<number, number | null>();

  (record.idleIntervals || [])
    .filter(i => i.startTime && i.startTime.startsWith(parentDate)) // Only trust today's idle
    .forEach((i) => {
    const rawStart = new Date(i.startTime).getTime();
    const start = checkInMs > 0 ? Math.max(rawStart, checkInMs) : rawStart;
    const end = i.endTime ? new Date(i.endTime).getTime() : null;
    const existing = streakMap.get(start);
    if (existing === undefined || end === null || (existing !== null && end > existing)) {
      streakMap.set(start, end);
    }
  });

  let idleMs = 0;
  streakMap.forEach((end, start) => {
    const iEnd = end === null ? nowMs : end;

    // Only count idle that falls within an active work session
    mergedSessions.forEach(s => {
      const overlapStart = Math.max(start, s.in);
      const overlapEnd = Math.min(iEnd, s.out);
      
      if (overlapEnd > overlapStart) {
        idleMs += (overlapEnd - overlapStart);
      }
    });

    // Fallback for missing sessions array
    if (mergedSessions.length === 0) {
      const overlapStart = Math.max(start, checkInMs);
      const overlapEnd = Math.min(iEnd, nowMs);
      if (overlapEnd > overlapStart) idleMs += (overlapEnd - overlapStart);
    }
  });

  // Rule: Trust the recomputed interval duration. 
  // Stored idleMinutes is only used if intervals array is completely missing.
  if (record.idleIntervals && record.idleIntervals.length > 0) {
     return Math.max(0, idleMs);
  }
  return Math.max(idleMs, (record.idleMinutes || 0) * 60000);
}

/**
 * Compute total worked time across all sessions (handles re-check-in on same day).
 * Each session is [checkIn, checkOut]. Open session uses nowMs as end.
 * Falls back to (endRefMs - checkInMs) for records without sessions array.
 */
/**
 * Compute total worked time across all sessions (handles re-check-in on same day).
 * Each session is [checkIn, checkOut]. Open session uses nowMs as end.
 */
export function computeTotalSessionMs(
  record: Pick<AttendanceDoc, 'checkInTime' | 'checkOutTime' | 'sessions'>,
  endRefMs: number,
): number {
  const sessions = (record as any).sessions as Array<{ checkIn: string; checkOut: string | null }>;
  if (Array.isArray(sessions) && sessions.length > 0) {
    const parentDate = (record as any).date || (record.checkInTime ? record.checkInTime.split('T')[0] : '');

    // Convert sessions to ranges and filter by date
    const ranges: Array<{ start: number; end: number }> = [];
    for (const s of sessions) {
      if (!s.checkIn) continue;
      if (parentDate && !s.checkIn.startsWith(parentDate)) continue;

      const sIn = new Date(s.checkIn).getTime();
      const sOut = s.checkOut ? new Date(s.checkOut).getTime() : endRefMs;
      
      if (Number.isFinite(sIn) && Number.isFinite(sOut) && sOut >= sIn) {
        ranges.push({ start: sIn, end: sOut });
      }
    }

    if (ranges.length === 0) return 0;

    // Sort by start time
    ranges.sort((a, b) => a.start - b.start);

    // Merge overlapping ranges to prevent double-counting
    const merged: Array<{ start: number; end: number }> = [];
    for (const curr of ranges) {
      const prev = merged[merged.length - 1];
      if (!prev || curr.start > prev.end) {
        merged.push(curr);
      } else {
        prev.end = Math.max(prev.end, curr.end);
      }
    }

    // Sum the durations of the merged ranges
    const totalMs = merged.reduce((sum, r) => sum + (r.end - r.start), 0);
    return Math.max(0, totalMs);
  }

  // Fallback: if sessions array missing, use checkInTime -> endRefMs
  if (record.checkInTime) {
    const sIn = new Date(record.checkInTime).getTime();
    if (Number.isFinite(sIn) && endRefMs >= sIn) {
      // Check if surprisingly large (over 20 hours is suspicious for a single session fallback)
      const duration = endRefMs - sIn;
      if (duration > 20 * 60 * 60 * 1000) return 0; 
      
      return duration;
    }
  }
  
  return 0;
}

export function computeAttendanceSummary(params: {
  record: Pick<AttendanceDoc, 'checkInTime' | 'checkOutTime' | 'dailyStatus' | 'status' | 'breaks' | 'idleIntervals' | 'idleMinutes' | 'totalWorkMinutes' | 'branch' | 'sessions'>;
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
  const breakTotals = computeBreakTotals(params.record.breaks, endRefMs, lunchLimit, teaLimit, isOnBreak, params.record.dailyStatus || '');
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
    const workMs = (params.record as any).sessions?.length > 0
      ? recomputedWorkMs
      : Math.max(recomputedWorkMs, storedWorkMs);
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
    ? computeBreakTotals(params.record.breaks, workRefMs, lunchLimit, teaLimit, false, '')
    : breakTotals;
  const idleMs = computeIdleMs(params.record, idleRefMs);
  const computedWorkMs = Math.max(0, frozenSessionMs - frozenBreakTotals.allowedBreakMs - idleMs - frozenBreakTotals.excessBreakMs);
  // Hard cap on stored work time to 16 hours to prevent impossible "24-48h" carry-over from corrupted records.
  const storedWorkMs = Math.min(
    16 * 60 * 60 * 1000,
    Math.max(0, Number(params.record.totalWorkMinutes || 0) * 60000)
  );
  
  // Rule: If we have a sessions array, trust the computed value.
  const workMs = (params.record as any).sessions?.length > 0
    ? Math.max(computedWorkMs, 0) 
    : Math.max(computedWorkMs, storedWorkMs);

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
  
  // Close existing open breaks and idle intervals
  const closedBreaks = closeOpenBreaks(params.record.breaks, nowIso);
  const closedIdle = closeOpenIntervals(params.record.idleIntervals, nowIso);
  
  // Close the open session in sessions array (if present)
  const rawSessions = (params.record as any).sessions as Array<{ checkIn: string; checkOut: string | null }> | undefined;
  const sessionsToMerge = rawSessions
    ? rawSessions.map((s) => s.checkOut === null ? { ...s, checkOut: nowIso } : s)
    : (params.record.checkInTime ? [{ checkIn: params.record.checkInTime, checkOut: nowIso }] : []);

  // CANONICAL MERGE: Eliminate all overlaps and duplicates before final save.
  const parentDate = (params.record as any).date || (params.record.checkInTime ? params.record.checkInTime.split('T')[0] : '');
  const ranges = sessionsToMerge
    .filter(s => s.checkIn && (!parentDate || s.checkIn.startsWith(parentDate)))
    .map(s => ({ in: new Date(s.checkIn).getTime(), out: new Date(s.checkOut!).getTime() }))
    .filter(r => r.out > r.in)
    .sort((a,b) => a.in - b.in);

  const mergedSessions: Array<{ checkIn: string; checkOut: string }> = [];
  if (ranges.length > 0) {
    let current = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].in <= current.out) {
        current.out = Math.max(current.out, ranges[i].out);
      } else {
        mergedSessions.push({ checkIn: new Date(current.in).toISOString(), checkOut: new Date(current.out).toISOString() });
        current = ranges[i];
      }
    }
    mergedSessions.push({ checkIn: new Date(current.in).toISOString(), checkOut: new Date(current.out).toISOString() });
  }

  const summary = computeAttendanceSummary({
    record: {
      ...params.record,
      checkOutTime: nowIso,
      breaks: closedBreaks,
      idleIntervals: closedIdle,
      dailyStatus: 'checked-out',
      totalWorkMinutes: 0,
      sessions: mergedSessions,
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
    sessions: mergedSessions,
  };
}
