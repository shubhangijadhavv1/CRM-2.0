import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel } from '../models/User.js';
import { TaskModel } from '../models/Task.js';
import { ProjectModel } from '../models/Project.js';
import { AttendanceModel } from '../models/Attendance.js';
import { LeaveModel } from '../models/Leave.js';
import { BehaviorModel } from '../models/Behavior.js';
import { NoticeModel } from '../models/Notice.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { ProjectConfigModel } from '../models/ProjectConfig.js';
import { ChecklistTemplateModel } from '../models/ChecklistTemplate.js';
import { ChecklistProgressModel } from '../models/ChecklistProgress.js';
import { AppSettingsModel } from '../models/AppSettings.js';
import { NotificationModel } from '../models/Notification.js';

export const bootstrapRouter = Router();

bootstrapRouter.use(requireAuth);
bootstrapRouter.use(requireDb);

bootstrapRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const isTeam = req.user?.role === 'team';
    const isAdmin = req.user?.role === 'admin';
    const isSuperAdmin = req.user?.role === 'super-admin';

    const me = await UserModel.findById(req.user!.id).lean();
    const myBranch = (me as any)?.branch || '';

    const taskQuery: any = {};
    if (isTeam) taskQuery.assigneeId = req.user!.id;
    else if (isAdmin && myBranch) taskQuery.branch = myBranch;
    // super-admin sees all tasks

    const [usersRaw, tasksRaw, projectsRaw, attendanceRaw, leavesRaw, behaviorRaw, noticesRaw, branchConfigsRaw, projectConfigRaw, checklistTemplatesRaw, checklistProgressRaw, appSettingsRaw, notificationsRaw] = await Promise.all([
      UserModel.find().lean(),
      TaskModel.find(taskQuery).lean(),
      ProjectModel.find().lean(),
      AttendanceModel.find(isTeam ? { userId: req.user!.id } : {}).lean(),
      LeaveModel.find(isTeam ? { userId: req.user!.id } : {}).lean(),
      BehaviorModel.find(isTeam ? { userId: req.user!.id } : {}).lean(),
      NoticeModel.find().sort({ date: -1 }).lean(),
      BranchConfigModel.find().lean(),
      ProjectConfigModel.findOne({ key: 'default' }).lean(),
      ChecklistTemplateModel.findOne({ key: 'default' }).lean(),
      ChecklistProgressModel.find().lean(),
      AppSettingsModel.findOne({ key: 'default' }).lean(),
      NotificationModel.find({ userId: req.user!.id }).sort({ createdAt: -1 }).lean()
    ]);

    const users = usersRaw.map((u: any) => {
      const safe: any = { ...u, id: String(u._id) };
      delete safe._id;
      delete safe.__v;
      delete safe.passwordHash;
      return safe;
    });

    const tasks = tasksRaw.map((t: any) => {
      const out: any = { ...t, id: String(t._id) };
      delete out._id;
      delete out.__v;
      return out;
    });

    const projects = projectsRaw.map((p: any) => {
      const out: any = { ...p, id: String(p._id) };
      delete out._id;
      delete out.__v;
      return out;
    });

    const attendanceRecords = attendanceRaw.map((r: any) => {
      const out: any = { ...r };
      delete out._id;
      delete out.__v;
      return out;
    });

    const leaves = leavesRaw.map((l: any) => {
      const out: any = { ...l };
      delete out._id;
      delete out.__v;
      return out;
    });

    const behaviorRecords = behaviorRaw.map((b: any) => {
      const out: any = { ...b };
      delete out._id;
      delete out.__v;
      return out;
    });

    const notices = noticesRaw.map((n: any) => {
      const out: any = { ...n };
      delete out._id;
      delete out.__v;
      return out;
    });

    const branchConfigs = branchConfigsRaw.map((bc: any) => {
      const out: any = { ...bc };
      delete out._id;
      delete out.__v;
      return out;
    });

    const projectConfig = projectConfigRaw
      ? (() => {
          const out: any = { ...projectConfigRaw };
          delete out._id;
          delete out.__v;
          return out;
        })()
      : null;

    const checklistTemplates = checklistTemplatesRaw ? (checklistTemplatesRaw as any).templates || {} : {};
    const checklistData: any = {};
    (checklistProgressRaw || []).forEach((d: any) => {
      checklistData[String(d.projectId)] = {
        stage1: d.stage1 || {},
        stage2: d.stage2 || {},
        stage1Notes: d.stage1Notes || {},
        stage2Notes: d.stage2Notes || {},
        stage1Assignee: d.stage1Assignee || 'Unassigned',
        stage2Assignee: d.stage2Assignee || '',
        stage2AssigneeId: d.stage2AssigneeId || '',
        status: d.status || 'dev-in-progress'
      };
    });

    const appSettings = appSettingsRaw
      ? (() => {
          const out: any = { key: appSettingsRaw.key, forceNotificationPrompt: appSettingsRaw.forceNotificationPrompt };
          out.geminiApiKeySet = Boolean(appSettingsRaw.geminiApiKey && String(appSettingsRaw.geminiApiKey).trim().length > 0);
          return out;
        })()
      : { key: 'default', forceNotificationPrompt: true, geminiApiKeySet: false };

    const notifications = (notificationsRaw || []).map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });

    return res.json({
      users,
      tasks,
      projects,
      attendanceRecords,
      leaves,
      behaviorRecords,
      notices,
      branchConfigs,
      projectConfig,
      checklistTemplates,
      checklistData,
      appSettings,
      notifications
    });
  } catch (e) {
    return next(e);
  }
});

