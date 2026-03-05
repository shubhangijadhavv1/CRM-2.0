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

function normalizeBranch(b: any): any {
  const wp = b.weekendPolicy;
  return {
    ...BRANCH_DEFAULTS,
    ...b,
    id: b.id,
    name: b.name ?? BRANCH_DEFAULTS.name,
    startTime: b.startTime ?? BRANCH_DEFAULTS.startTime,
    endTime: b.endTime ?? BRANCH_DEFAULTS.endTime,
    lunchStart: b.lunchStart ?? BRANCH_DEFAULTS.lunchStart,
    lunchEnd: b.lunchEnd ?? BRANCH_DEFAULTS.lunchEnd,
    weekendPolicy: {
      sundayOff: wp?.sundayOff ?? true,
      saturdaysOff: Array.isArray(wp?.saturdaysOff) ? wp.saturdaysOff : []
    },
    lunchTimeLimitMinutes: Math.max(0, Number(b.lunchTimeLimitMinutes) || 30),
    teaBreakTimeLimitMinutes: Math.max(0, Number(b.teaBreakTimeLimitMinutes) || 15),
    autoLunchBreakThresholdMinutes: Math.max(0, Number(b.autoLunchBreakThresholdMinutes) || 20),
    autoTeaBreakThresholdMinutes: Math.max(0, Number(b.autoTeaBreakThresholdMinutes) || 10),
    lateMarkGraceMinutes: Math.max(0, Number(b.lateMarkGraceMinutes) || 15),
    yearlyPaidLeaves: Math.max(0, Number(b.yearlyPaidLeaves) || 12),
    ipRestrictions: Array.isArray(b.ipRestrictions) ? b.ipRestrictions : [],
    holidays: Array.isArray(b.holidays) ? b.holidays : []
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
        return BranchConfigModel.findOneAndUpdate({ id: normalized.id }, { $set: normalized }, { upsert: true, new: true, setDefaultsOnInsert: true });
      })
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

