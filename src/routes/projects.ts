import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { NotificationModel } from '../models/Notification.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { emitNotify } from '../realtime/notify.js';
import crypto from 'node:crypto';

export const projectsRouter = Router();

projectsRouter.use(requireAuth);
projectsRouter.use(requireDb);

async function notifyAssigneeProjectAssigned(assigneeName: string, projectName: string, projectType: string, creatorId: string) {
  const name = (assigneeName || '').trim();
  if (!name) return;
  // Find user by assignee name (exact or case-insensitive)
  let assigneeUser = await UserModel.findOne({ name, status: 'active' }).lean();
  if (!assigneeUser) {
    assigneeUser = await UserModel.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: 'active' }).lean();
  }
  if (!assigneeUser) return;
  const assigneeId = String(assigneeUser._id);
  if (assigneeId === String(creatorId)) return;

  const typeLabel = projectType === 'demo' ? 'Demo project' : 'Project';
  const nid = crypto.randomBytes(10).toString('hex');
  const notif = {
    id: nid,
    userId: assigneeId,
    title: `${typeLabel} assigned to you`,
    message: `You have been assigned to "${projectName}".`,
    type: 'alert' as const,
    time: 'Just now',
    read: false
  };
  await NotificationModel.create(notif).catch(() => {});
  emitInvalidate('notifications');
  emitNotify(assigneeId, notif);
}

projectsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await ProjectModel.find().lean();
    const projects = docs.map((d: any) => ({ ...d, id: String(d._id) }));
    projects.forEach((p: any) => {
      delete p._id;
      delete p.__v;
    });
    return res.json({ projects });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body ?? {};
    const created = await ProjectModel.create(data);
    const p: any = created.toObject();
    p.id = String(p._id);
    delete p._id;
    delete p.__v;
    emitInvalidate('projects');

    const assigneeName = (data.assignee || '').trim();
    if (assigneeName && req.user?.id) {
      await notifyAssigneeProjectAssigned(assigneeName, p.name || 'Project', data.type || 'live', String(req.user.id));
    }

    return res.status(201).json({ project: p });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.put('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const prev = await ProjectModel.findById(req.params.id).lean();
    const updated = await ProjectModel.findByIdAndUpdate(req.params.id, req.body ?? {}, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Project not found' });
    const p: any = { ...updated, id: String(updated._id) };
    delete p._id;
    delete p.__v;
    emitInvalidate('projects');

    const newAssignee = (req.body?.assignee ?? (updated as any).assignee ?? '').trim();
    const prevAssignee = (prev as any)?.assignee ?? '';
    if (newAssignee && newAssignee !== prevAssignee && req.user?.id) {
      await notifyAssigneeProjectAssigned(newAssignee, p.name || 'Project', (updated as any).type || 'live', String(req.user.id));
    }

    return res.json({ project: p });
  } catch (e) {
    return next(e);
  }
});

projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await ProjectModel.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: 'Project not found' });
    emitInvalidate('projects');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

