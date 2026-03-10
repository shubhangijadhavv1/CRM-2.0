import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { TaskModel } from '../models/Task.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';
import { sendPushToUser } from '../realtime/webpush.js';
import { UserModel } from '../models/User.js';
import { NotificationModel } from '../models/Notification.js';
import { getBranchesForUser, userCanAccessBranch } from '../utils/userBranches.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);
tasksRouter.use(requireDb);

tasksRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const q: any = {};
    if (req.user?.role === 'team') {
      q.$or = [{ assigneeId: req.user!.id }, { assignerId: req.user!.id }];
    } else if (req.user?.role === 'admin' || req.user?.role === 'team-lead') {
      const me = await UserModel.findById(req.user.id).lean();
      const branches = getBranchesForUser(me);
      if (branches.length > 0) q.branch = { $in: branches };
    } else if (req.user?.role === 'super-admin') {
      const branch = String((req.query as any)?.branch || '').trim();
      if (branch) q.branch = branch;
    }
    const docs = await TaskModel.find(q).lean();
    const tasks = docs.map((d: any) => {
      const t: any = { ...d, id: String(d._id) };
      delete t._id;
      delete t.__v;
      if (t.assignerId != null) t.assignerId = String(t.assignerId);
      if (t.completedAt instanceof Date) t.completedAt = t.completedAt.toISOString();
      return t;
    });
    return res.json({ tasks });
  } catch (e) {
    return next(e);
  }
});

tasksRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const data: any = req.body ?? {};
    if (!data.assigneeId) return res.status(400).json({ error: 'assigneeId is required' });

    // Team members can assign tasks to others; creator still tracked via assignerId.

    // Derive assigneeName + branch from user
    const assignee = await UserModel.findById(String(data.assigneeId)).lean();
    if (!assignee) return res.status(400).json({ error: 'Invalid assigneeId' });
    data.assigneeName = data.assigneeName || assignee.name;
    data.branch = assignee.branch || '';

    // Admin and team-lead can only create tasks within their branch(es)
    if (req.user?.role === 'admin' || req.user?.role === 'team-lead') {
      const me = await UserModel.findById(req.user.id).lean();
      if (!userCanAccessBranch(me, data.branch)) {
        return res.status(403).json({ error: 'You can only create tasks within your branch(es)' });
      }
    }

    // Creator is always the current user (only they can delete this task later)
    data.assignerId = req.user!.id;

    const created = await TaskModel.create(data);
    const t: any = created.toObject();
    t.id = String(t._id);
    delete t._id;
    delete t.__v;
    if (t.assignerId != null) t.assignerId = String(t.assignerId);
    emitInvalidate('tasks');

    if (String(data.assigneeId) !== String(req.user!.id)) {
      const notifPayload = {
        id: `task-new-${t.id}`,
        title: 'New Task Assigned',
        message: `"${t.title || 'Untitled'}" has been assigned to you.`,
        type: 'alert' as const,
        time: new Date().toISOString()
      };
      emitNotify(String(data.assigneeId), notifPayload);
      NotificationModel.create({ ...notifPayload, userId: String(data.assigneeId), read: false }).catch(() => {});
    }

    // Notify all admins, team-leads & super-admins about new tasks (except the creator)
    const admins = await UserModel.find({
      role: { $in: ['admin', 'team-lead', 'super-admin'] },
      _id: { $ne: req.user!.id },
      status: 'active'
    }).lean();
    const creator = await UserModel.findById(req.user!.id).select('name').lean();
    const creatorName = String((creator as any)?.name || '').trim() || 'Someone';
    for (const admin of admins) {
      const adminNotif = {
        title: 'New Task Created',
        body: `${creatorName} created "${t.title || 'Untitled'}" for ${data.assigneeName || 'a team member'}.`,
        tag: `task-created-${t.id}`,
        url: '/'
      };
      sendPushToUser(String(admin._id), adminNotif).catch(() => {});
    }

    return res.status(201).json({ task: t });
  } catch (e) {
    return next(e);
  }
});

tasksRouter.put('/:id', async (req, res, next) => {
  try {
    const patch: any = req.body ?? {};

    const existing = await TaskModel.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    // Team permissions:
    // - creator (assigner) can update and reassign
    // - assignee (non-creator) can update, but cannot reassign
    if ((req as any).user?.role === 'team') {
      const myId = String((req as any).user.id);
      const isCreator = myId === String((existing as any).assignerId);
      const isAssignee = myId === String((existing as any).assigneeId);
      if (!isCreator && !isAssignee) return res.status(403).json({ error: 'Forbidden' });

      if (!isCreator) {
        delete patch.assigneeId;
        delete patch.assigneeName;
        delete patch.branch;
      }
    }

    // Admin/team-lead can only update tasks in their branch(es)
    if ((req as any).user?.role === 'admin' || (req as any).user?.role === 'team-lead') {
      const me = await UserModel.findById((req as any).user.id).lean();
      if (!userCanAccessBranch(me, (existing as any).branch)) {
        return res.status(403).json({ error: 'You can only manage tasks within your branch(es)' });
      }
    }

    // If reassigned, update derived fields
    if (patch.assigneeId) {
      const assignee = await UserModel.findById(String(patch.assigneeId)).lean();
      if (!assignee) return res.status(400).json({ error: 'Invalid assigneeId' });
      patch.assigneeName = patch.assigneeName || assignee.name;
      patch.branch = assignee.branch || '';

      if ((req as any).user?.role === 'admin' || (req as any).user?.role === 'team-lead') {
        const me = await UserModel.findById((req as any).user.id).lean();
        if (!userCanAccessBranch(me, patch.branch)) {
          return res.status(403).json({ error: 'You can only manage tasks within your branch(es)' });
        }
      }
    }

    // Set completedAt when status is set to 'done'; clear when status leaves 'done'
    if (patch.status !== undefined) {
      if (patch.status === 'done') {
        patch.completedAt = new Date();
      } else if ((existing as any).status === 'done') {
        patch.completedAt = null;
      }
    }

    const updated = await TaskModel.findByIdAndUpdate(req.params.id, patch, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    const t: any = { ...updated, id: String(updated._id) };
    delete t._id;
    delete t.__v;
    if (t.completedAt instanceof Date) t.completedAt = t.completedAt.toISOString();
    emitInvalidate('tasks');

    if (patch.assigneeId && String(patch.assigneeId) !== String((existing as any).assigneeId)) {
      const notifPayload = {
        id: `task-assign-${t.id}-${Date.now()}`,
        title: 'Task Reassigned to You',
        message: `"${t.title || 'Untitled'}" has been assigned to you.`,
        type: 'alert' as const,
        time: new Date().toISOString()
      };
      emitNotify(String(patch.assigneeId), notifPayload);
      NotificationModel.create({ ...notifPayload, userId: String(patch.assigneeId), read: false }).catch(() => {});
    }

    return res.json({ task: t });
  } catch (e) {
    return next(e);
  }
});

tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const task = await TaskModel.findById(req.params.id).lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // Only the user who created the task (assigner) or super-admin can delete it
    const isCreator = String((req as any).user?.id) === String((task as any).assignerId);
    const isSuperAdmin = (req as any).user?.role === 'super-admin';
    if (!isCreator && !isSuperAdmin) {
      return res.status(403).json({ error: 'Only the person who created the task can delete it' });
    }
    await TaskModel.findByIdAndDelete(req.params.id);
    emitInvalidate('tasks');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});
