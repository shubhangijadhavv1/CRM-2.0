import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel } from '../models/User.js';
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

/** YYYY-MM-DD: only load attendance/behavior from this date onward (smaller payload). Override with BOOTSTRAP_HISTORY_DAYS (60–1095). */
function getBootstrapHistoryMinDate(): string {
  const raw = process.env.BOOTSTRAP_HISTORY_DAYS;
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) ? Math.max(60, Math.min(1095, parsed)) : 548;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

bootstrapRouter.use(requireAuth);
bootstrapRouter.use(requireDb);

bootstrapRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const isTeam = req.user?.role === 'team';
    const minDate = getBootstrapHistoryMinDate();

    const attendanceQuery = isTeam
      ? { userId: req.user!.id, date: { $gte: minDate } }
      : { date: { $gte: minDate } };
    const behaviorQuery = isTeam
      ? { userId: req.user!.id, date: { $gte: minDate } }
      : { date: { $gte: minDate } };

    // Tasks are loaded via GET /api/tasks so bootstrap stays smaller and faster to serialize.
    const [usersRaw, projectsRaw, attendanceRaw, leavesRaw, behaviorRaw, noticesRaw, branchConfigsRaw, projectConfigRaw, checklistTemplatesRaw, checklistProgressRaw, appSettingsRaw, notificationsRaw] = await Promise.all([
      UserModel.find().select('-passwordHash -twoFactorSecret').lean(),
      ProjectModel.find().lean(),
      AttendanceModel.find(attendanceQuery).lean(),
      LeaveModel.find(isTeam ? { userId: req.user!.id } : {}).lean(),
      BehaviorModel.find(behaviorQuery).lean(),
      NoticeModel.find().sort({ date: -1 }).limit(400).lean(),
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
      const dateFields = ['lastBrowserActivityAt', 'lastBrowserHeartbeatAt', 'lastAgentLoginAt', 'lastAgentLogoutAt', 'createdAt', 'updatedAt'];
      dateFields.forEach((field: string) => {
        if (safe[field] instanceof Date) safe[field] = safe[field].toISOString();
      });
      if (Array.isArray(safe.documents)) {
        safe.documents = safe.documents.map((d: any) => {
          const docId = d.id || (d._id != null ? String(d._id) : '');
          return { id: docId, label: d.label, fileName: d.fileName, fileUrl: d.fileUrl, uploadDate: d.uploadDate };
        });
      }
      return safe;
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
          out.agentPolicy = (appSettingsRaw as any).agentPolicy || {
            screenshotEnabled: true,
            screenshotIntervalSec: 300,
            urlTrackingEnabled: true,
            windowTrackingEnabled: true,
            trackKeyboard: true,
            trackMouse: true,
            idleAlertMinutes: 20,
            blockedKeywords: [],
            retentionDays: 7
          };
          return out;
        })()
      : {
          key: 'default',
          forceNotificationPrompt: true,
          geminiApiKeySet: false,
          agentPolicy: {
            screenshotEnabled: true,
            screenshotIntervalSec: 300,
            urlTrackingEnabled: true,
            windowTrackingEnabled: true,
            trackKeyboard: true,
            trackMouse: true,
            idleAlertMinutes: 20,
            blockedKeywords: [],
            retentionDays: 7
          }
        };

    const notifications = (notificationsRaw || []).map((d: any) => {
      const out: any = { ...d };
      delete out._id;
      delete out.__v;
      return out;
    });

    return res.json({
      users,
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
