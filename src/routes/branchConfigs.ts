import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const branchConfigsRouter = Router();

branchConfigsRouter.use(requireAuth);
branchConfigsRouter.use(requireDb);

branchConfigsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await BranchConfigModel.find().lean();
    const branchConfigs = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ branchConfigs });
  } catch (e) {
    return next(e);
  }
});

const BRANCH_DEFAULTS: Record<string, any> = {
  name: 'Branch',
  startTime: '09:00',
  endTime: '18:00',
  lunchStart: '13:00',
  lunchEnd: '14:00',
  teaBreakDurationMinutes: 15,
  lunchTimeLimitMinutes: 30,
  teaBreakTimeLimitMinutes: 15,
  autoLunchBreakThresholdMinutes: 20,
  autoTeaBreakThresholdMinutes: 10,
  lateMarkGraceMinutes: 15,
  ipRestrictions: [],
  yearlyPaidLeaves: 12,
  weekendPolicy: { sundayOff: true, saturdaysOff: [] },
  holidays: []
};

/** Only schema fields — no createdAt/updatedAt/_id from client (avoids Mongoose $set cast errors). */
function normalizeBranch(b: any): Record<string, unknown> {
  const wp = b?.weekendPolicy;
  const id = String(b?.id || '').trim();
  const holidaysRaw = Array.isArray(b?.holidays) ? b.holidays : [];
  const holidays = holidaysRaw
    .map((h: any) => ({
      date: String(h?.date || '').trim(),
      name: String(h?.name || '').trim(),
    }))
    .filter((h: { date: string; name: string }) => h.date.length > 0 && h.name.length > 0);

  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    id,
    name: String(b?.name ?? BRANCH_DEFAULTS.name).trim() || BRANCH_DEFAULTS.name,
    startTime: String(b?.startTime ?? BRANCH_DEFAULTS.startTime),
    endTime: String(b?.endTime ?? BRANCH_DEFAULTS.endTime),
    lunchStart: String(b?.lunchStart ?? BRANCH_DEFAULTS.lunchStart),
    lunchEnd: String(b?.lunchEnd ?? BRANCH_DEFAULTS.lunchEnd),
    teaBreakDurationMinutes: Math.max(
      0,
      num(b?.teaBreakDurationMinutes, BRANCH_DEFAULTS.teaBreakDurationMinutes),
    ),
    lunchTimeLimitMinutes: Math.max(0, num(b?.lunchTimeLimitMinutes, 30)),
    teaBreakTimeLimitMinutes: Math.max(0, num(b?.teaBreakTimeLimitMinutes, 15)),
    autoLunchBreakThresholdMinutes: Math.max(0, num(b?.autoLunchBreakThresholdMinutes, 20)),
    autoTeaBreakThresholdMinutes: Math.max(0, num(b?.autoTeaBreakThresholdMinutes, 10)),
    lateMarkGraceMinutes: Math.max(0, num(b?.lateMarkGraceMinutes, 15)),
    yearlyPaidLeaves: Math.max(0, num(b?.yearlyPaidLeaves, 12)),
    ipRestrictions: Array.isArray(b?.ipRestrictions)
      ? b.ipRestrictions.map((x: any) => String(x).trim()).filter(Boolean)
      : [],
    weekendPolicy: {
      sundayOff: wp?.sundayOff !== false,
      saturdaysOff: Array.isArray(wp?.saturdaysOff)
        ? wp.saturdaysOff.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
        : [],
    },
    holidays,
  };
}

// Replace all branch configs (simplifies client-side editing UX)
branchConfigsRouter.put('/', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const list = req.body?.branchConfigs;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'branchConfigs array is required' });
    if (list.length === 0) return res.status(400).json({ error: 'At least one branch is required. You cannot delete all branches.' });

    const ids = list.map((b: any) => b.id).filter(Boolean);
    if (ids.length !== list.length) return res.status(400).json({ error: 'Each branch config must include id' });

    // Upsert each (normalize so required fields are never missing), then delete those missing from the submitted list
    await Promise.all(
      list.map((b: any) => {
        const normalized = normalizeBranch(b);
        return BranchConfigModel.findOneAndUpdate(
          { id: normalized.id as string },
          { $set: normalized },
          { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
        );
      }),
    );
    await BranchConfigModel.deleteMany({ id: { $nin: ids } });

    const docs = await BranchConfigModel.find().lean();
    const branchConfigs = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });

    emitInvalidate('branch-configs');
    return res.json({ branchConfigs });
  } catch (e) {
    return next(e);
  }
});

