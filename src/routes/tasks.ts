import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { TaskModel } from '../models/Task.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';
import { sendPushToUser } from '../realtime/webpush.js';
import { UserModel } from '../models/User.js';
import { NotificationModel } from '../models/Notification.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);
tasksRouter.use(requireDb);

tasksRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const q: any = {};
    if (req.user?.role === 'team') {
      q.assigneeId = req.user!.id;
    } else if (req.user?.role === 'admin') {
      const me = await UserModel.findById(req.user.id).lean();
      if (me?.branch) q.branch = me.branch;
    } else if (req.user?.role === 'super-admin') {
      const branch = String((req.query as any)?.branch || '').trim();
      if (branch) q.branch = branch;
    }
    const docs = await TaskModel.find(q).lean();
    const tasks = docs.map((d: any) => ({ ...d, id: String(d._id) }));
    tasks.forEach((t: any) => {
      delete t._id;
      delete t.__v;
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

    // Team can only create tasks for themselves
    if (req.user?.role === 'team' && String(data.assigneeId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Staff can only create tasks assigned to themselves' });
    }

    // Derive assigneeName + branch from user
    const assignee = await UserModel.findById(String(data.assigneeId)).lean();
    if (!assignee) return res.status(400).json({ error: 'Invalid assigneeId' });
    data.assigneeName = data.assigneeName || assignee.name;
    data.branch = assignee.branch || '';

    // Admin can only create tasks within their branch
    if (req.user?.role === 'admin') {
      const me = await UserModel.findById(req.user.id).lean();
      if (me?.branch && data.branch && me.branch !== data.branch) {
        return res.status(403).json({ error: 'Admins can only manage tasks within their branch' });
      }
    }

    const created = await TaskModel.create(data);
    const t: any = created.toObject();
    t.id = String(t._id);
    delete t._id;
    delete t.__v;
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

    // Notify all admins & super-admins about new tasks (except the creator)
    const admins = await UserModel.find({
      role: { $in: ['admin', 'super-admin'] },
      _id: { $ne: req.user!.id },
      status: 'active'
    }).lean();
    const creatorName = req.user?.name || 'Someone';
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

    // Team can only update their own tasks and cannot reassign
    if ((req as any).user?.role === 'team') {
      if (String((req as any).user.id) !== String((existing as any).assigneeId)) return res.status(403).json({ error: 'Forbidden' });
      delete patch.assigneeId;
      delete patch.assigneeName;
      delete patch.branch;
    }

    // If reassigned, update derived fields
    if (patch.assigneeId) {
      const assignee = await UserModel.findById(String(patch.assigneeId)).lean();
      if (!assignee) return res.status(400).json({ error: 'Invalid assigneeId' });
      patch.assigneeName = patch.assigneeName || assignee.name;
      patch.branch = assignee.branch || '';

      if ((req as any).user?.role === 'admin') {
        const me = await UserModel.findById((req as any).user.id).lean();
        if (me?.branch && patch.branch && me.branch !== patch.branch) {
          return res.status(403).json({ error: 'Admins can only manage tasks within their branch' });
        }
      }
    }

    const updated = await TaskModel.findByIdAndUpdate(req.params.id, patch, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    const t: any = { ...updated, id: String(updated._id) };
    delete t._id;
    delete t.__v;
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
    const deleted = await TaskModel.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    emitInvalidate('tasks');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

