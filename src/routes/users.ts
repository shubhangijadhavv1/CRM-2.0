import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { UserModel, type UserRole } from '../models/User.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);
usersRouter.use(requireDb);
usersRouter.use(requireRole(['admin', 'super-admin']));

function toSafeUser(doc: any) {
  const u: any = { ...doc, id: String(doc._id) };
  delete u._id;
  delete u.__v;
  delete u.passwordHash;
  return u;
}

function canManageTarget(actorRole: UserRole, targetRole: UserRole) {
  if (actorRole === 'super-admin') return true;
  // admins can only manage team users
  return targetRole === 'team';
}

usersRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const docs = await UserModel.find().sort({ createdAt: -1 }).lean();
    const users = docs.map(toSafeUser);
    // If admin, hide super-admin users from the list for safety.
    const filtered = req.user!.role === 'admin' ? users.filter((u: any) => u.role !== 'super-admin') : users;
    return res.json({ users: filtered });
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

    if (req.user!.role === 'admin' && role !== 'team') {
      return res.status(403).json({ error: 'Admins can only create team users' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const allowedIps =
      req.user!.role === 'super-admin'
        ? Array.from(new Set((body.allowedIps || []).map((s: any) => String(s).trim()).filter(Boolean)))
        : [];

    const created = await UserModel.create({
      name,
      email,
      passwordHash,
      role,
      jobTitle: body.jobTitle || '',
      branch: body.branch || 'Main',
      allowedModules: role === 'super-admin' ? ['all'] : (body.allowedModules || []),
      allowedWorkModes: body.allowedWorkModes?.length ? body.allowedWorkModes : ['office', 'wfh'],
      status: body.status === 'inactive' ? 'inactive' : 'active',
      loginLocked: Boolean(body.loginLocked),
      privacyModeEnabled: Boolean(body.privacyModeEnabled),
      idleTrackingEnabled: body.idleTrackingEnabled !== undefined ? Boolean(body.idleTrackingEnabled) : true,
      avatar: body.avatar,
      allowedIps
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

    if (String(existing._id) === req.user!.id && req.body?.role && req.user!.role !== 'super-admin') {
      return res.status(403).json({ error: 'Cannot change your own role' });
    }

    const patch: any = { ...(req.body ?? {}) };

    // Password update
    if (patch.password) {
      if (String(patch.password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
      patch.passwordHash = await bcrypt.hash(String(patch.password), 10);
    }
    delete patch.password;

    // Admin restrictions
    if (req.user!.role === 'admin') {
      delete patch.role;
      delete patch.idleTrackingEnabled; // only super-admin can manage this
      delete patch.allowedIps; // only super-admin can manage per-user IP allowlist
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
    await UserModel.findByIdAndDelete(id);
    emitInvalidate('users');
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

