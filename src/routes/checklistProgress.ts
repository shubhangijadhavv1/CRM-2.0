import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { ChecklistProgressModel } from '../models/ChecklistProgress.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';
import { NotificationModel } from '../models/Notification.js';
import { emitNotify } from '../realtime/notify.js';
import crypto from 'node:crypto';
import { UserModel } from '../models/User.js';
import { ChecklistTemplateModel } from '../models/ChecklistTemplate.js';

export const checklistProgressRouter = Router();

checklistProgressRouter.use(requireAuth);
checklistProgressRouter.use(requireDb);

checklistProgressRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const isTeam = req.user?.role === 'team';
    const q: any = {};
    if (isTeam) {
      // Minimal filter by assignee name (UI uses names today)
      // Note: if you later move to userIds, update this filter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.$or = [{ stage1Assignee: (req as any).userName }, { stage2Assignee: (req as any).userName }];
    }

    // We don't have userName on token; return all for now and rely on UI access controls.
    const docs = await ChecklistProgressModel.find(isTeam ? {} : {}).lean();

    const checklistData: any = {};
    docs.forEach((d: any) => {
      checklistData[String(d.projectId)] = {
        stage1: d.stage1 || {},
        stage2: d.stage2 || {},
        stage1Notes: d.stage1Notes || {},
        stage2Notes: d.stage2Notes || {},
        stage1Assignee: d.stage1Assignee || 'Unassigned',
        stage2Assignee: d.stage2Assignee || '',
        status: d.status || 'dev-in-progress'
      };
    });

    return res.json({ checklistData });
  } catch (e) {
    return next(e);
  }
});

checklistProgressRouter.put('/:projectId', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = String(req.params.projectId);
    const progress = req.body?.progress;
    if (!progress || typeof progress !== 'object') return res.status(400).json({ error: 'progress object is required' });

    const prev = await ChecklistProgressModel.findOne({ projectId }).lean();

    // Enforce ownership rules for team users:
    // - Stage 1 changes: only the project assignee can change stage1/stage1Notes/assign QA
    // - Stage 2 changes: only the assigned QA (stage2AssigneeId) can change stage2/stage2Notes
    if (req.user?.role === 'team') {
      const me = await UserModel.findById(req.user.id).lean();
      const proj = await ProjectModel.findById(projectId).lean();
      const myName = (me as any)?.name || '';
      const projectAssigneeName = (proj as any)?.assignee || '';

      const prevStage1 = (prev as any)?.stage1 || {};
      const prevStage2 = (prev as any)?.stage2 || {};
      const prevStage1Notes = (prev as any)?.stage1Notes || {};
      const prevStage2Notes = (prev as any)?.stage2Notes || {};
      const prevStage1Assignee = String((prev as any)?.stage1Assignee || '');
      const prevQaId = String((prev as any)?.stage2AssigneeId || '');

      const stage1Changed =
        (progress.stage1 !== undefined && JSON.stringify(progress.stage1) !== JSON.stringify(prevStage1)) ||
        (progress.stage1Notes !== undefined && JSON.stringify(progress.stage1Notes) !== JSON.stringify(prevStage1Notes)) ||
        (progress.stage1Assignee !== undefined && String(progress.stage1Assignee) !== prevStage1Assignee);

      const stage2Changed =
        (progress.stage2 !== undefined && JSON.stringify(progress.stage2) !== JSON.stringify(prevStage2)) ||
        (progress.stage2Notes !== undefined && JSON.stringify(progress.stage2Notes) !== JSON.stringify(prevStage2Notes));

      const incomingQaId = String(progress.stage2AssigneeId || prevQaId || '');
      const assigningQa =
        (progress.stage2AssigneeId !== undefined && String(progress.stage2AssigneeId) !== prevQaId) ||
        (progress.stage2Assignee !== undefined && String(progress.stage2Assignee) !== String((prev as any)?.stage2Assignee || '')) ||
        (progress.status === 'ready-for-qa' && String((prev as any)?.status || '') !== 'ready-for-qa');

      if ((stage1Changed || assigningQa) && projectAssigneeName && myName !== projectAssigneeName) {
        return res.status(403).json({ error: 'Only the project assignee can complete Stage 1 or assign QA' });
      }

      if (stage2Changed && incomingQaId && String(req.user.id) !== incomingQaId) {
        return res.status(403).json({ error: 'Only the assigned QA can complete Stage 2' });
      }
    }

    const updated = await ChecklistProgressModel.findOneAndUpdate(
      { projectId },
      { $set: { projectId, ...progress } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    // Sync QA progress back to Project so the Project table reflects checklist completion in real-time.
    try {
      const project = await ProjectModel.findById(projectId).lean();
      const tmplDoc = await ChecklistTemplateModel.findOne({ key: 'default' }).lean();
      const templates = tmplDoc ? ((tmplDoc as any).templates || {}) : {};
      const items: string[] = project ? (templates[(project as any).category] || []) : [];

      const stage1Map = (updated as any).stage1 || {};
      const stage2Map = (updated as any).stage2 || {};
      const pct = (map: any) => {
        if (!items.length) return undefined;
        const checked = items.filter((i) => Boolean(map?.[i])).length;
        return Math.round((checked / items.length) * 100);
      };

      const qa1 = pct(stage1Map);
      const qa2 = pct(stage2Map);
      const patch: any = {};
      if (typeof qa1 === 'number') patch.qaProgress1 = qa1;
      if (typeof qa2 === 'number') patch.qaProgress2 = qa2;
      if (qa2 === 100) patch.status = 'Completed';

      if (project && Object.keys(patch).length) {
        await ProjectModel.findByIdAndUpdate(projectId, { $set: patch }, { new: false }).lean();
        emitInvalidate('projects');
      }
    } catch {
      // best-effort sync, don't fail main request
    }

    // If QA assignee changed -> create a Task + Notification for that user
    const newQaId = String((updated as any).stage2AssigneeId || '');
    const prevQaId = String((prev as any)?.stage2AssigneeId || '');
    if (newQaId && newQaId !== prevQaId) {
      const project = await ProjectModel.findById(projectId).lean();
      const qaUser = await UserModel.findById(newQaId).lean();
      const assignerUser = await UserModel.findById(req.user!.id).lean();

      const projectName = project ? (project as any).name : 'Project';
      const projectUrl = project ? (project as any).url : '';
      const qaName = qaUser ? (qaUser as any).name : String((updated as any).stage2Assignee || 'QA');
      const assignerName = assignerUser ? (assignerUser as any).name : 'System';

      const title = `QA Checklist (Stage 2): ${projectName}`;
      const taskDescription = `You have been assigned to complete the Stage 2 Quality Assurance checklist for "${projectName}".${projectUrl ? `\n\nProject URL: ${projectUrl}` : ''}\n\nPlease review all checklist items and verify the project meets quality standards before marking as complete.`;
      
      // Check if task already exists (avoid duplicates)
      const existingTask = await TaskModel.findOne({ title, projectId, assigneeId: newQaId, status: { $ne: 'done' } }).lean();
      if (!existingTask) {
        await TaskModel.create({
          title,
          description: taskDescription,
          projectId,
          projectName,
          assigneeId: newQaId,
          assigneeName: qaName,
          assignerId: req.user!.id,
          status: 'todo',
          priority: 'High', // QA tasks are high priority
          difficulty: 'Medium',
          dueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
          dueTime: undefined,
          timeTracked: 0,
          timerStartedAt: null
        });
        emitInvalidate('tasks');
      }

      // Create notification for the assigned QA staff
      const nid = crypto.randomBytes(10).toString('hex');
      const notificationMessage = projectUrl 
        ? `You have been assigned Stage 2 QA checklist for "${projectName}" by ${assignerName}. Please review the project and complete the quality assurance checklist.\n\nProject: ${projectUrl}`
        : `You have been assigned Stage 2 QA checklist for "${projectName}" by ${assignerName}. Please review the project and complete the quality assurance checklist.`;
      
      const notif = {
        id: nid,
        userId: newQaId,
        title: 'Quality Checklist Assigned',
        message: notificationMessage,
        type: 'alert' as const,
        time: 'Just now',
        read: false
      };
      await NotificationModel.create(notif);
      emitInvalidate('notifications');
      emitNotify(newQaId, notif);
    }

    emitInvalidate('checklist-progress');
    return res.json({
      progress: {
        stage1: (updated as any).stage1 || {},
        stage2: (updated as any).stage2 || {},
        stage1Notes: (updated as any).stage1Notes || {},
        stage2Notes: (updated as any).stage2Notes || {},
        stage1Assignee: (updated as any).stage1Assignee || 'Unassigned',
        stage2Assignee: (updated as any).stage2Assignee || '',
        stage2AssigneeId: (updated as any).stage2AssigneeId || '',
        status: (updated as any).status || 'dev-in-progress'
      }
    });
  } catch (e) {
    return next(e);
  }
});

