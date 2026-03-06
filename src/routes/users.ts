import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel, type UserRole } from '../models/User.js';
import { emitInvalidate } from '../realtime/invalidate.js';
import { getBranchesForUser } from '../utils/userBranches.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);
usersRouter.use(requireDb);
usersRouter.use(requireRole(['admin', 'super-admin', 'team-lead']));

function toSafeUser(doc: any) {
  const u: any = { ...doc, id: String(doc._id) };
  delete u._id;
  delete u.__v;
  delete u.passwordHash;
  delete u.twoFactorSecret;
  // Serialize Date fields to ISO strings for JSON consistency
  const dateFields = ['lastBrowserActivityAt', 'lastBrowserHeartbeatAt', 'lastAgentLoginAt', 'lastAgentLogoutAt', 'createdAt', 'updatedAt'];
  dateFields.forEach(field => {
    if (u[field] instanceof Date) u[field] = u[field].toISOString();
  });
  // Normalize documents[]: ensure id field and don't leak Mongo _id
  if (Array.isArray(u.documents)) {
    u.documents = u.documents.map((d: any) => {
      const docId = d.id || (d._id != null ? String(d._id) : '');
      return { id: docId, label: d.label, fileName: d.fileName, fileUrl: d.fileUrl, uploadDate: d.uploadDate };
    });
  }
  return u;
}

function canManageTarget(actorRole: UserRole, targetRole: UserRole) {
  if (actorRole === 'super-admin') return true;
  // admin and team-lead can manage team users (branch filtering applied in GET)
  if (targetRole === 'team') return actorRole === 'admin' || actorRole === 'team-lead';
  return false;
}

usersRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    let docs = await UserModel.find().sort({ createdAt: -1 }).lean();
    // If admin or team-lead, hide super-admin from list and filter by branch(es)
    if (req.user!.role === 'admin' || req.user!.role === 'team-lead') {
      const meDoc = await UserModel.findById(req.user!.id).lean();
      const meBranches = getBranchesForUser(meDoc as any);
      docs = docs.filter((d: any) => d.role !== 'super-admin');
      if (meBranches.length > 0) {
        docs = docs.filter((d: any) => {
          const userBranches = getBranchesForUser(d);
          return userBranches.some((b: string) => meBranches.includes(b));
        });
      }
    }
    const users = docs.map(toSafeUser);
    return res.json({ users });
  } catch (e) {
    return next(e);
  }
});

usersRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body ?? {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const role = (body.role as UserRole) || 'team';

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

    if ((req.user!.role === 'admin' || req.user!.role === 'team-lead') && role !== 'team') {
      return res.status(403).json({ error: 'Admins and team leads can only create team users' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const allowedIps =
      req.user!.role === 'super-admin'
        ? Array.from(new Set((body.allowedIps || []).map((s: any) => String(s).trim()).filter(Boolean)))
        : [];

    const branch = body.branch || 'Main';
    const branches = Array.isArray(body.branches) ? body.branches.filter((b: any) => b != null && String(b).trim()) : undefined;

    const created = await UserModel.create({
      name,
      email,
      passwordHash,
      role,
      jobTitle: body.jobTitle || '',
      branch,
      branches: branches?.length ? branches : undefined,
      allowedModules: role === 'super-admin' ? ['all'] : (body.allowedModules || []),
      allowedWorkModes: body.allowedWorkModes?.length ? body.allowedWorkModes : ['office', 'wfh'],
      status: body.status === 'inactive' ? 'inactive' : 'active',
      loginLocked: Boolean(body.loginLocked),
      privacyModeEnabled: Boolean(body.privacyModeEnabled),
      idleTrackingEnabled: body.idleTrackingEnabled !== undefined ? Boolean(body.idleTrackingEnabled) : true,
      avatar: body.avatar,
      allowedIps,
      mobile: body.mobile || '',
      address: body.address || '',
      bankDetails: body.bankDetails || undefined,
      documents: body.documents || undefined
    });
    emitInvalidate('users');
    return res.status(201).json({ user: toSafeUser(created.toObject()) });
  } catch (e: any) {
    if (e?.code === 11000) return res.status(409).json({ error: 'Email already exists' });
    return next(e);
  }
});

usersRouter.put('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const existing = await UserModel.findById(id).lean();
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (!canManageTarget(req.user!.role, existing.role)) return res.status(403).json({ error: 'Forbidden' });

    // Admin/team-lead can only update users in their branch(es)
    if (req.user!.role === 'admin' || req.user!.role === 'team-lead') {
      const meDoc = await UserModel.findById(req.user!.id).lean();
      const meBranches = getBranchesForUser(meDoc as any);
      if (meBranches.length > 0) {
        const targetBranches = getBranchesForUser(existing as any);
        if (!targetBranches.some((b: string) => meBranches.includes(b))) {
          return res.status(403).json({ error: 'You can only manage users in your branch(es)' });
        }
      }
    }

    if (String(existing._id) === req.user!.id && req.body?.role && req.user!.role !== 'super-admin') {
      return res.status(403).json({ error: 'Cannot change your own role' });
    }

    const patch: any = { ...(req.body ?? {}) };
    delete patch.id;
    delete patch._id;

    // Reset 2FA for team users (admin/super-admin only)
    if (patch.resetTwoFactor) {
      if (req.user!.role !== 'super-admin' && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Only admin/super-admin can reset 2FA' });
      }
      if (existing.role !== 'team') {
        return res.status(400).json({ error: '2FA reset is only allowed for team users' });
      }
      patch.twoFactorEnabled = false;
      patch.twoFactorSecret = '';
      patch.twoFactorEnabledAt = null;
    }
    delete patch.resetTwoFactor;

    // Password update
    if (patch.password) {
      if (String(patch.password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
      patch.passwordHash = await bcrypt.hash(String(patch.password), 10);
    }
    delete patch.password;

    // Admin and team-lead restrictions
    if (req.user!.role === 'admin' || req.user!.role === 'team-lead') {
      delete patch.role;
      delete patch.idleTrackingEnabled; // only super-admin can manage this
      delete patch.allowedIps; // only super-admin can manage per-user IP allowlist
    }
    // Allow branches for any role that can update (super-admin can set it; admin/team-lead patch is applied)
    if (patch.branches !== undefined) {
      patch.branches = Array.isArray(patch.branches) ? patch.branches.filter((b: any) => b != null && String(b).trim()) : undefined;
      if (patch.branches?.length === 0) patch.branches = undefined;
    }

    // super-admin always has all
    if (existing.role === 'super-admin') {
      patch.allowedModules = ['all'];
    }

    if (req.user!.role === 'super-admin' && patch.allowedIps) {
      patch.allowedIps = Array.from(new Set((patch.allowedIps || []).map((s: any) => String(s).trim()).filter(Boolean)));
    }

    const updated = await UserModel.findByIdAndUpdate(id, patch, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'User not found' });
    emitInvalidate('users');
    return res.json({ user: toSafeUser(updated) });
  } catch (e) {
    return next(e);
  }
});

usersRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (id === req.user!.id) return res.status(400).json({ error: 'You cannot delete yourself' });
    const existing = await UserModel.findById(id).lean();
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (!canManageTarget(req.user!.role, existing.role)) return res.status(403).json({ error: 'Forbidden' });
    if (req.user!.role === 'admin' || req.user!.role === 'team-lead') {
      const meDoc = await UserModel.findById(req.user!.id).lean();
      const meBranches = getBranchesForUser(meDoc as any);
      if (meBranches.length > 0) {
        const targetBranches = getBranchesForUser(existing as any);
        if (!targetBranches.some((b: string) => meBranches.includes(b))) {
          return res.status(403).json({ error: 'You can only manage users in your branch(es)' });
        }
      }
    }
    await UserModel.findByIdAndDelete(id);
    emitInvalidate('users');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});
