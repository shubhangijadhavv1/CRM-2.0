import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models/User.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const authRouter = Router();

/** Build a JSON-serializable user object (dates → ISO strings) so login/me never throw on res.json(). */
function toSafeUser(user: any): Record<string, unknown> {
  const u = user as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: String(u._id ?? u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    jobTitle: u.jobTitle,
    branch: u.branch,
    branches: u.branches,
    allowedModules: u.allowedModules,
    allowedWorkModes: u.allowedWorkModes,
    status: u.status,
    loginLocked: u.loginLocked,
    privacyModeEnabled: u.privacyModeEnabled,
    idleTrackingEnabled: u.idleTrackingEnabled,
    avatar: u.avatar,
    allowedIps: u.allowedIps,
    mobile: u.mobile,
    address: u.address,
    bankDetails: u.bankDetails,
    documents: u.documents,
    lastBrowserActivityAt: u.lastBrowserActivityAt instanceof Date ? u.lastBrowserActivityAt.toISOString() : u.lastBrowserActivityAt,
    lastBrowserHeartbeatAt: u.lastBrowserHeartbeatAt instanceof Date ? u.lastBrowserHeartbeatAt.toISOString() : u.lastBrowserHeartbeatAt,
    browserIsIdle: u.browserIsIdle,
    browserIdleForMs: u.browserIdleForMs,
    browserLastReason: u.browserLastReason,
    browserCrmOrigin: u.browserCrmOrigin,
    browserExtensionVersion: u.browserExtensionVersion,
    lastAgentLoginAt: u.lastAgentLoginAt instanceof Date ? u.lastAgentLoginAt.toISOString() : u.lastAgentLoginAt,
    lastAgentLogoutAt: u.lastAgentLogoutAt instanceof Date ? u.lastAgentLogoutAt.toISOString() : u.lastAgentLogoutAt,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function signToken(userId: string, role: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_SECRET missing'), { status: 500 });
  return jwt.sign({ role }, secret, { subject: userId, expiresIn: '7d' });
}

function getClientIp(req: any) {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : String(xff || '');
  const ip = (raw.split(',')[0]?.trim() || req.ip || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

authRouter.post('/login', requireDb, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await UserModel.findOne({ email: String(email).toLowerCase().trim() }).lean();
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account is inactive.' });
    if (user.loginLocked) return res.status(403).json({ error: 'Login Locked: You have already logged out today. Request Admin for unlock.' });

    const hash = (user as any).passwordHash;
    if (!hash || typeof hash !== 'string') return res.status(500).json({ error: 'Server misconfiguration: user account missing password. Contact admin.' });

    const ok = await bcrypt.compare(String(password), hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    // --- IP restriction (per-user first, then branch allowlist for all non-super-admins) ---
    if (user.role !== 'super-admin') {
      const ip = getClientIp(req);

      const userAllow = Array.isArray((user as any).allowedIps) ? (user as any).allowedIps : [];
      const normalizedUserAllow = userAllow.map((s: any) => String(s).trim()).filter(Boolean);
      if (normalizedUserAllow.length > 0) {
        if (!normalizedUserAllow.includes(ip)) {
          return res.status(403).json({ error: `Login blocked: Your IP (${ip}) is not whitelisted. Contact Super Admin to add your IP.` });
        }
      } else {
        const branchId = (user as any).branch || ((user as any).branches && (user as any).branches[0]) || 'Main';
        const bc = await BranchConfigModel.findOne({ id: branchId }).lean();
        const allow = (bc as any)?.ipRestrictions || [];
        if (Array.isArray(allow) && allow.length > 0) {
          const normalizedAllow = allow.map((s: any) => String(s).trim()).filter(Boolean);
          if (!normalizedAllow.includes(ip)) {
            return res.status(403).json({ error: `Login blocked: Your IP (${ip}) is not whitelisted for branch "${(bc as any)?.name || branchId}". Go to Settings > Branches to add your IP.` });
          }
        }
      }
    }

    const token = signToken(String(user._id), user.role);
    const safeUser = toSafeUser(user);
    return res.json({ token, user: safeUser });
  } catch (e: any) {
    const msg = e?.message && typeof e.message === 'string' ? e.message : 'Login failed.';
    return res.status(typeof e?.status === 'number' ? e.status : 500).json({ error: msg });
  }
});

authRouter.get('/me', requireAuth, requireDb, async (req: AuthedRequest, res, next) => {
  try {
    const user = await UserModel.findById(req.user!.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: toSafeUser(user) });
  } catch (e) {
    return next(e);
  }
});

// Update own profile (any authenticated user) – used by Edit Profile / Profile Settings
// Super-admin / admin only: get a token as a staff user (impersonation / "Staff Login")
authRouter.post('/login-as', requireAuth, requireRole(['super-admin', 'admin']), requireDb, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.body?.userId;
    if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'userId is required' });

    const target = await UserModel.findById(userId).lean();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role !== 'team') return res.status(403).json({ error: 'Can only log in as staff (team) users' });
    if (target.status !== 'active') return res.status(403).json({ error: 'User account is inactive' });

    const token = signToken(String(target._id), target.role);
    return res.json({ token, user: toSafeUser(target) });
  } catch (e) {
    return next(e);
  }
});

authRouter.put('/me', requireAuth, requireDb, async (req: AuthedRequest, res, next) => {
  try {
    const id = req.user!.id;
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    const allowed = ['name', 'jobTitle', 'mobile', 'address', 'avatar', 'bankDetails', 'documents'];
    for (const key of allowed) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.password !== undefined) {
      const newPassword = String(body.password);
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      const currentPassword = body.currentPassword;
      if (currentPassword === undefined || currentPassword === '') return res.status(400).json({ error: 'Current password is required to set a new password' });
      const user = await UserModel.findById(id).lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      const ok = await bcrypt.compare(String(currentPassword), (user as any).passwordHash);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
      patch.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    const updated = await UserModel.findByIdAndUpdate(id, patch, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'User not found' });
    emitInvalidate('users');
    return res.json({ user: toSafeUser(updated) });
  } catch (e) {
    return next(e);
  }
});

