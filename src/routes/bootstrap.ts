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
import { getLocalTodayStr } from '../utils/attendanceSession.js';

export const bootstrapRouter = Router();

/** YYYY-MM-DD: only load attendance/behavior from this date onward (smaller payload). Override with BOOTSTRAP_HISTORY_DAYS (60–1095). */
function getBootstrapHistoryMinDate(): string {
  const raw = process.env.BOOTSTRAP_HISTORY_DAYS;
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) ? Math.max(7, Math.min(1095, parsed)) : 30;
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

async function getCoreData(userId: string) {
  const todayStr = getLocalTodayStr();
  const [usersRaw, projectsRaw, branchConfigsRaw, projectConfigRaw, checklistTemplatesRaw, appSettingsRaw, attendanceTodayRaw] = await Promise.all([
    UserModel.find().select('-passwordHash -twoFactorSecret').lean(),
    ProjectModel.find().lean(),
    BranchConfigModel.find().lean(),
    ProjectConfigModel.findOne({ key: 'default' }).lean(),
    ChecklistTemplateModel.findOne({ key: 'default' }).lean(),
    AppSettingsModel.findOne({ key: 'default' }).lean(),
    AttendanceModel.find({ date: todayStr }).lean()
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
      safe.documents = safe.documents.map((d: any) => ({
        id: d.id || (d._id != null ? String(d._id) : ''),
        label: d.label,
        fileName: d.fileName,
        fileUrl: d.fileUrl,
        uploadDate: d.uploadDate
      }));
    }
    return safe;
  });

  const projects = projectsRaw.map((p: any) => {
    const out: any = { ...p, id: String(p._id) };
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

  const projectConfig = projectConfigRaw ? { ...projectConfigRaw } : null;
  if (projectConfig) {
    delete (projectConfig as any)._id;
    delete (projectConfig as any).__v;
  }

  const checklistTemplates = checklistTemplatesRaw ? (checklistTemplatesRaw as any).templates || {} : {};

  const appSettings = appSettingsRaw
    ? {
      key: appSettingsRaw.key,
      forceNotificationPrompt: appSettingsRaw.forceNotificationPrompt,
      geminiApiKeySet: Boolean(appSettingsRaw.geminiApiKey && String(appSettingsRaw.geminiApiKey).trim().length > 0),
      agentPolicy: (appSettingsRaw as any).agentPolicy || {
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
    }
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

  const attendanceRecords = attendanceTodayRaw.map((r: any) => {
    const out: any = { ...r, id: String(r._id) };
    delete out._id;
    delete out.__v;
    return out;
  });

  return { users, projects, branchConfigs, projectConfig, checklistTemplates, appSettings, attendanceRecords };
}

async function getHistoryData(userId: string, role: string) {
  const isTeam = role === 'team';
  const minDate = getBootstrapHistoryMinDate();
  const todayStr = getLocalTodayStr();
  // Exclude today since it's already in core
  const attendanceQuery = isTeam 
    ? { userId, date: { $gte: minDate, $lt: todayStr } } 
    : { date: { $gte: minDate, $lt: todayStr } };
    
  const behaviorQuery = isTeam ? { userId, date: { $gte: minDate } } : { date: { $gte: minDate } };

  const [attendanceRaw, leavesRaw, behaviorRaw, noticesRaw, checklistProgressRaw, notificationsRaw] = await Promise.all([
    // Optimization: Skip heavy intervals/sessions for historical data to reduce payload size
    AttendanceModel.find(attendanceQuery).select('-idleIntervals -sessions -breaks').lean(),
    LeaveModel.find(isTeam ? { userId } : {}).lean(),
    BehaviorModel.find(behaviorQuery).lean(),
    NoticeModel.find().sort({ date: -1 }).limit(100).lean(),
    ChecklistProgressModel.find().lean(),
    NotificationModel.find({ userId }).sort({ createdAt: -1 }).limit(50).lean()
  ]);

  const attendanceRecords = attendanceRaw.map((r: any) => {
    const out: any = { ...r, id: String(r._id) };
    delete out._id;
    delete out.__v;
    return out;
  });

  const leaves = leavesRaw.map((l: any) => {
    const out: any = { ...l, id: String(l._id) };
    delete out._id;
    delete out.__v;
    return out;
  });

  const behaviorRecords = behaviorRaw.map((b: any) => {
    const out: any = { ...b, id: String(b._id) };
    delete out._id;
    delete out.__v;
    return out;
  });

  const notices = noticesRaw.map((n: any) => {
    const out: any = { ...n, id: String(n._id) };
    delete out._id;
    delete out.__v;
    return out;
  });

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

  const notifications = notificationsRaw.map((n: any) => {
    const out: any = { ...n, id: String(n._id) };
    delete out._id;
    delete out.__v;
    if (out.link && out.link._id) {
      out.link.id = String(out.link._id);
      delete out.link._id;
    }
    return out;
  });

  return { attendanceRecords, leaves, behaviorRecords, notices, checklistData, notifications };
}


// Split endpoints for faster initial load
bootstrapRouter.get('/core', async (req: AuthedRequest, res, next) => {
  try {
    const data = await getCoreData(req.user!.id);
    return res.json(data);
  } catch (e) {
    return next(e);
  }
});

bootstrapRouter.get('/history', async (req: AuthedRequest, res, next) => {
  try {
    const data = await getHistoryData(req.user!.id, req.user!.role);
    return res.json(data);
  } catch (e) {
    return next(e);
  }
});

// Legacy endpoint (combined) - optimized with Promise.all on the two sub-tasks
bootstrapRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const [core, history] = await Promise.all([
      getCoreData(req.user!.id),
      getHistoryData(req.user!.id, req.user!.role)
    ]);
    return res.json({ ...core, ...history });
  } catch (e) {
    return next(e);
  }
});
