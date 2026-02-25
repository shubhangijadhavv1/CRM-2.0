import { Router } from 'express';
import { requireAuth, type AuthedRequest, requireRole } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { LeaveModel } from '../models/Leave.js';
import { UserModel } from '../models/User.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';
import { sendPushToUser } from '../realtime/webpush.js';

export const leavesRouter = Router();

leavesRouter.use(requireAuth);
leavesRouter.use(requireDb);

leavesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user?.role;
    const q: any = {};
    if (role === 'team') {
      q.userId = req.user!.id;
    } else if (role === 'admin') {
      const me = await UserModel.findById(req.user!.id).select('branch').lean();
      if (me?.branch) {
        const userIdsInBranch = await UserModel.find({ branch: me.branch }).select('_id').lean();
        q.userId = { $in: userIdsInBranch.map((u: any) => String(u._id)) };
      }
    }
    const docs = await LeaveModel.find(q).lean();
    const leaves = docs.map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });
    return res.json({ leaves });
  } catch (e) {
    return next(e);
  }
});

leavesRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const leave = req.body ?? {};
    if (!leave.id) return res.status(400).json({ error: 'id is required' });

    if (req.user?.role === 'team') {
      leave.userId = req.user.id;
      const user = await UserModel.findById(req.user.id).lean();
      if (user) leave.userName = user.name;
      leave.status = 'pending';
    }

    const created = await LeaveModel.findOneAndUpdate(
      { id: leave.id },
      { $setOnInsert: leave },
      { upsert: true, new: true }
    ).lean();

    const out: any = { ...created };
    delete out._id;
    delete out.__v;
    emitInvalidate('leaves');

    // Notify admins about new leave request
    if (req.user?.role === 'team') {
      const admins = await UserModel.find({ role: { $in: ['admin', 'super-admin'] }, status: 'active' }).select('_id').lean();
      for (const admin of admins) {
        sendPushToUser(String(admin._id), {
          title: 'New Leave Request',
          body: `${leave.userName || 'Employee'} requested ${leave.type || 'leave'} (${leave.startDate || ''})`,
          tag: `leave-${leave.id}`,
          url: '/'
        }).catch(() => {});
      }
    }

    return res.status(201).json({ leave: out });
  } catch (e) {
    return next(e);
  }
});

// Admins can approve/reject
leavesRouter.put('/:id', requireRole(['admin', 'super-admin']), async (req, res, next) => {
  try {
    const updated = await LeaveModel.findOneAndUpdate({ id: req.params.id }, { $set: req.body ?? {} }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Leave not found' });
    const out: any = { ...updated };
    delete out._id;
    delete out.__v;
    emitInvalidate('leaves');

    // Notify the employee about leave approval/rejection
    const leaveData = out as any;
    if (leaveData.status === 'approved' || leaveData.status === 'rejected') {
      const statusLabel = leaveData.status === 'approved' ? 'Approved' : 'Rejected';
      const partial = leaveData.status === 'approved' && Array.isArray(leaveData.approvedDays) && leaveData.approvedDays.length > 0;
      const message = partial
        ? `Your leave request: ${leaveData.approvedDays.length} day(s) approved (${leaveData.approvedDays.slice(0, 3).join(', ')}${leaveData.approvedDays.length > 3 ? '...' : ''}).`
        : `Your ${leaveData.type || 'leave'} request has been ${statusLabel.toLowerCase()}.`;
      emitNotify(String(leaveData.userId), {
        id: `leave-${statusLabel.toLowerCase()}-${leaveData.id}`,
        title: partial ? 'Leave partially approved' : `Leave ${statusLabel}`,
        message,
        type: leaveData.status === 'approved' ? 'success' : 'alert',
        time: new Date().toISOString()
      });
    }

    return res.json({ leave: out });
  } catch (e) {
    return next(e);
  }
});

