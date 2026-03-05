import bcrypt from 'bcryptjs';
import { UserModel } from '../models/User.js';
import { TaskModel } from '../models/Task.js';
import { ProjectModel } from '../models/Project.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { NoticeModel } from '../models/Notice.js';
import { LeaveModel } from '../models/Leave.js';
import { BehaviorModel } from '../models/Behavior.js';

/**
 * Seeds the DB once so the existing UI has real data immediately.
 * Safe to call multiple times; it only seeds if the collections are empty.
 */
export async function seedIfEmpty() {
  const [userCount, taskCount, projectCount, branchCount, noticeCount, leaveCount, behaviorCount] =
    await Promise.all([
      UserModel.estimatedDocumentCount(),
      TaskModel.estimatedDocumentCount(),
      ProjectModel.estimatedDocumentCount(),
      BranchConfigModel.estimatedDocumentCount(),
      NoticeModel.estimatedDocumentCount(),
      LeaveModel.estimatedDocumentCount(),
      BehaviorModel.estimatedDocumentCount()
    ]);

  // 1) Seed core users/projects/tasks only if missing
  if (userCount === 0 || taskCount === 0 || projectCount === 0) {
    const passwordHashAdmin123 = await bcrypt.hash('admin123', 10);
    const passwordHashPassword = await bcrypt.hash('password', 10);

    if (userCount === 0) {
      await UserModel.insertMany([
        {
          name: 'Super Admin',
          email: 'super@nexus.com',
          passwordHash: passwordHashAdmin123,
          role: 'super-admin',
          branch: 'Pune',
          jobTitle: 'System Administrator',
          allowedModules: ['all'],
          allowedWorkModes: ['office', 'wfh'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: false,
          idleTrackingEnabled: true
        },
        {
          name: 'Project Manager',
          email: 'pm@nexus.com',
          passwordHash: passwordHashPassword,
          role: 'admin',
          branch: 'Pune',
          branches: ['Pune'],
          jobTitle: 'Project Manager',
          allowedModules: ['dashboard', 'projects', 'tasks', 'checklist', 'team', 'attendance', 'performance', 'live-workplace', 'notice-board', 'policy-generator', 'domain-monitoring'],
          allowedWorkModes: ['office', 'wfh'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: false,
          idleTrackingEnabled: true
        },
        {
          name: 'Team Lead (Pune & Mumbai)',
          email: 'tlead@nexus.com',
          passwordHash: passwordHashPassword,
          role: 'team-lead',
          branch: 'Pune',
          branches: ['Pune', 'Mumbai'],
          jobTitle: 'Team Lead',
          allowedModules: ['dashboard', 'projects', 'tasks', 'checklist', 'team', 'attendance', 'performance', 'live-workplace', 'notice-board', 'policy-generator', 'domain-monitoring'],
          allowedWorkModes: ['office', 'wfh'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: false,
          idleTrackingEnabled: true
        },
        {
          name: 'Mike Ross',
          email: 'mike@nexus.com',
          passwordHash: passwordHashPassword,
          role: 'team',
          branch: 'Mumbai',
          jobTitle: 'Laravel Expert',
          allowedModules: ['dashboard', 'projects', 'tasks', 'checklist', 'attendance', 'performance', 'notice-board', 'policy-generator', 'domain-monitoring'],
          allowedWorkModes: ['office', 'wfh'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: true,
          idleTrackingEnabled: true
        },
        {
          name: 'Sarah Jenkins',
          email: 'sarah@nexus.com',
          passwordHash: passwordHashPassword,
          role: 'team',
          branch: 'Pune',
          jobTitle: 'Full Stack Dev',
          allowedModules: ['dashboard', 'tasks', 'projects', 'checklist', 'attendance', 'performance', 'notice-board', 'policy-generator', 'domain-monitoring'],
          allowedWorkModes: ['office'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: false,
          idleTrackingEnabled: true
        },
        {
          name: 'Jessica Pearson',
          email: 'jessica@nexus.com',
          passwordHash: passwordHashPassword,
          role: 'team',
          branch: 'Pune',
          jobTitle: 'Frontend Lead',
          allowedModules: ['dashboard', 'checklist', 'tasks', 'projects', 'notice-board', 'policy-generator', 'domain-monitoring'],
          allowedWorkModes: ['office', 'wfh'],
          status: 'active',
          loginLocked: false,
          privacyModeEnabled: false,
          idleTrackingEnabled: true
        }
      ]);
    }

    // Minimal seed projects + tasks (enough for UI to work immediately).
    if (projectCount === 0) {
      await ProjectModel.insertMany([
        {
          name: 'Alpha E-com Store',
          url: 'https://alpha-store.com',
          category: 'E-commerce',
          subcategory: 'Shopify',
          assignee: 'Sarah Jenkins',
          priority: 'High',
          status: 'Development',
          startDate: '2023-10-01',
          endDate: '2023-12-15',
          websiteType: 'Shopify',
          server: 'AWS',
          type: 'live',
          qaProgress1: 80,
          qaProgress2: 45
        },
        {
          name: 'Beta Corporate Site',
          url: 'https://beta-corp.net',
          category: 'Corporate',
          subcategory: 'Finance',
          assignee: 'Mike Ross',
          priority: 'Medium',
          status: 'Design',
          startDate: '2023-11-05',
          endDate: '2024-01-20',
          websiteType: 'WordPress',
          server: 'DigitalOcean',
          type: 'live',
          qaProgress1: 20,
          qaProgress2: 0
        }
      ]);
    }

    if (taskCount === 0) {
      const usersNow = await UserModel.find().lean();
      const byEmail = new Map(usersNow.map((u: any) => [u.email, String(u._id)]));
      const projectsNow = await ProjectModel.find().lean();
      const projectIdByName = new Map(projectsNow.map((p: any) => [p.name, String(p._id)]));

      await TaskModel.insertMany([
        {
          title: 'Fix Checkout Bug',
          description: 'Cart total not updating on mobile.',
          projectId: projectIdByName.get('Alpha E-com Store') || '',
          projectName: 'Alpha E-com Store',
          assigneeId: byEmail.get('mike@nexus.com')!,
          assigneeName: 'Mike Ross',
          assignerId: byEmail.get('super@nexus.com')!,
          status: 'in-progress',
          priority: 'High',
          difficulty: 'Hard',
          dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          dueTime: undefined,
          timeTracked: 3600,
          timerStartedAt: Date.now() - 1800000
        },
        {
          title: 'Design Hero Banner',
          description: 'Create 3 variations.',
          projectId: projectIdByName.get('Beta Corporate Site') || '',
          projectName: 'Beta Corporate Site',
          assigneeId: byEmail.get('sarah@nexus.com')!,
          assigneeName: 'Sarah Jenkins',
          assignerId: byEmail.get('super@nexus.com')!,
          status: 'todo',
          priority: 'Medium',
          difficulty: 'Medium',
          dueDate: new Date(Date.now() + 172800000).toISOString().split('T')[0],
          dueTime: undefined,
          timeTracked: 0,
          timerStartedAt: null
        }
      ]);
    }
  }

  // 2) Seed module collections if missing (safe to run after initial deploy)
  if (branchCount === 0) await BranchConfigModel.insertMany([
    {
      id: 'Pune',
      name: 'Pune Branch',
      startTime: '10:00',
      endTime: '18:00',
      lunchStart: '13:30',
      lunchEnd: '14:00',
      teaBreakDurationMinutes: 15,
      lateMarkGraceMinutes: 15,
      ipRestrictions: [],
      yearlyPaidLeaves: 12,
      weekendPolicy: { sundayOff: true, saturdaysOff: [1, 2, 3] },
      holidays: [
        { date: '2023-12-25', name: 'Christmas' },
        { date: '2024-01-26', name: 'Republic Day' }
      ]
    },
    {
      id: 'Mumbai',
      name: 'Mumbai Branch',
      startTime: '09:30',
      endTime: '18:30',
      lunchStart: '13:00',
      lunchEnd: '14:00',
      teaBreakDurationMinutes: 15,
      lateMarkGraceMinutes: 10,
      ipRestrictions: [],
      yearlyPaidLeaves: 15,
      weekendPolicy: { sundayOff: true, saturdaysOff: [2, 4] },
      holidays: [{ date: '2023-12-25', name: 'Christmas' }]
    }
  ]);

  if (noticeCount === 0) await NoticeModel.insertMany([
    {
      id: 'n1',
      title: 'System Maintenance',
      content: 'Server maintenance scheduled for Saturday 10 PM. Expect downtime.',
      type: 'warning',
      targetAudience: 'all',
      date: new Date().toISOString().split('T')[0],
      createdBy: 'Super Admin',
      readBy: []
    },
    {
      id: 'n2',
      title: 'Pune Office Holiday',
      content: 'Office will be closed this Friday for local festivities.',
      type: 'info',
      targetAudience: 'branch',
      targetValue: 'Pune',
      date: new Date().toISOString().split('T')[0],
      createdBy: 'HR',
      readBy: []
    }
  ]);

  // For behavior/leaves seeding, we need user ids even on existing DBs.
  const usersNow = await UserModel.find().lean();
  const byEmailNow = new Map(usersNow.map((u: any) => [u.email, String(u._id)]));
  const superId = byEmailNow.get('super@nexus.com');
  const pmId = byEmailNow.get('pm@nexus.com');
  const mikeId = byEmailNow.get('mike@nexus.com');
  const sarahId = byEmailNow.get('sarah@nexus.com');

  if (behaviorCount === 0 && superId && pmId && mikeId && sarahId) {
    await BehaviorModel.insertMany([
      {
        id: 'b1',
        userId: mikeId,
        loggedByUserId: superId,
        date: '2023-10-15',
        type: 'positive',
        category: 'Teamwork',
        description: 'Helped junior devs debug critical issue late at night.',
        impactScore: 10
      },
      {
        id: 'b2',
        userId: mikeId,
        loggedByUserId: pmId,
        date: '2023-10-20',
        type: 'negative',
        category: 'Punctuality',
        description: 'Late to daily standup 3 days in a row.',
        impactScore: -5
      },
      {
        id: 'b3',
        userId: sarahId,
        loggedByUserId: superId,
        date: '2023-10-10',
        type: 'positive',
        category: 'Code Quality',
        description: 'Refactored legacy module reducing load time by 40%.',
        impactScore: 15
      }
    ]);
  }

  if (leaveCount === 0 && mikeId && sarahId) {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    await LeaveModel.insertMany([
      {
        id: 'l1',
        userId: sarahId,
        userName: 'Sarah Jenkins',
        type: 'sick',
        startDate: new Date(year, month, 5).toISOString().split('T')[0],
        endDate: new Date(year, month, 5).toISOString().split('T')[0],
        reason: 'Medical appointment',
        status: 'approved'
      },
      {
        id: 'l2',
        userId: mikeId,
        userName: 'Mike Ross',
        type: 'casual',
        startDate: new Date(year, month, 12).toISOString().split('T')[0],
        endDate: new Date(year, month, 13).toISOString().split('T')[0],
        reason: 'Personal Trip',
        status: 'approved'
      }
    ]);
  }
}

