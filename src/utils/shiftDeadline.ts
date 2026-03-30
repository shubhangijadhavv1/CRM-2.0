/**
 * Late mark: compare check-in instant (UTC) to "shift start + grace" on the attendance date
 * in office wall time, then convert to UTC using a fixed offset (default IST UTC+5:30).
 *
 * Set BRANCH_UTC_OFFSET_MINUTES to match your office (e.g. 330 = +5:30, 0 = UTC).
 */

function officeUtcOffsetMs(): number {
  const raw = process.env.BRANCH_UTC_OFFSET_MINUTES;
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(parsed)) return parsed * 60 * 1000;
  return (5 * 60 + 30) * 60 * 1000; // IST
}

/** Parse "HH:mm" or "HH:mm:ss" → { h, m } */
export function parseTimeHM(hhmm: string): { h: number; m: number } | null {
  const parts = String(hhmm || '')
    .trim()
    .split(':')
    .map((x) => Number(x));
  const h = parts[0];
  const m = Number.isFinite(parts[1]) ? parts[1] : 0;
  if (!Number.isFinite(h)) return null;
  return { h, m };
}

/**
 * UTC epoch ms for office-local date `dateYmd` at (shift start + grace minutes).
 * `dateYmd` + start time are interpreted in the office zone (offset env).
 */
export function shiftStartPlusGraceUtcMs(
  dateYmd: string,
  startTimeHHMM: string,
  graceMinutes: number,
): number | null {
  const [ys, mos, ds] = dateYmd.split('-').map((x) => Number(x));
  if (!Number.isFinite(ys) || !Number.isFinite(mos) || !Number.isFinite(ds)) return null;
  const hm = parseTimeHM(startTimeHHMM);
  if (!hm) return null;
  const grace = Math.max(0, Number(graceMinutes) || 0);
  let totalMin = hm.h * 60 + hm.m + grace;
  const dayDelta = Math.floor(totalMin / 1440);
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  const H = Math.floor(totalMin / 60);
  const M = totalMin % 60;
  const offset = officeUtcOffsetMs();
  return Date.UTC(ys, mos - 1, ds + dayDelta, H, M, 0, 0) - offset;
}
