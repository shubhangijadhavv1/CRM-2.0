import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { UserModel } from '../models/User.js';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { emitInvalidate } from '../realtime/invalidate.js';

export const authRouter = Router();

type PendingTwoFactorSetup = {
  secret: string;
  expiresAt: number;
};

type VerifiedLoginTicket = {
  userId: string;
  email: string;
  expiresAt: number;
};

const pendingTwoFactorSetups = new Map<string, PendingTwoFactorSetup>();
const verifiedLoginTickets = new Map<string, VerifiedLoginTicket>();
const PENDING_SETUP_TTL_MS = 10 * 60 * 1000;
const LOGIN_TICKET_TTL_MS = 10 * 60 * 1000;

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
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
    twoFactorEnabledAt: u.twoFactorEnabledAt instanceof Date ? u.twoFactorEnabledAt.toISOString() : u.twoFactorEnabledAt,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function signToken(userId: string, role: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Object.assign(new Error('JWT_SECRET missing'), { status: 500 });
  return jwt.sign({ role }, secret, { subject: userId, expiresIn: '7d' });
}

function normalizeIpToken(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'unknown') return '';

  // Strip IPv4 port, e.g. "1.2.3.4:53124"
  let candidate = raw;
  if (candidate.includes('.') && candidate.includes(':') && !candidate.includes('::')) {
    candidate = candidate.split(':')[0].trim();
  }

  // Handle bracketed IPv6 with optional port, e.g. "[2001:db8::1]:443"
  if (candidate.startsWith('[') && candidate.includes(']')) {
    candidate = candidate.slice(1, candidate.indexOf(']')).trim();
  }

  // Convert IPv4-mapped IPv6, e.g. "::ffff:110.225.251.134"
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);

  // Normalize localhost IPv6 token
  if (candidate === '::1') candidate = '127.0.0.1';

  return isIP(candidate) ? candidate : '';
}

function parseIpCandidates(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => parseIpCandidates(v));
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeIpToken(part))
    .filter(Boolean);
}

function parseForwardedHeader(value: unknown): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  // RFC 7239 examples: for=203.0.113.195;proto=https;by=203.0.113.43
  //                    for="[2001:db8:cafe::17]:4711"
  const matches = raw.match(/for=(?:"?\[?)([^;\],"]+)/gi) || [];
  return matches
    .map((m) => m.replace(/^for=/i, '').replace(/^"/, '').replace(/"$/, '').trim())
    .map((token) => normalizeIpToken(token))
    .filter(Boolean);
}

function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') return true;

  // IPv4 private/link-local ranges
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  const m172 = ip.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // Common local/unique IPv6 prefixes
  if (/^(fc|fd)/i.test(ip)) return true; // unique local
  if (/^fe80:/i.test(ip)) return true; // link-local

  return false;
}

function getClientIp(req: any) {
  const headers = req.headers || {};
  const candidates = [
    ...parseIpCandidates(headers['cf-connecting-ip']),
    ...parseIpCandidates(headers['true-client-ip']),
    ...parseForwardedHeader(headers['forwarded']),
    ...parseIpCandidates(headers['x-forwarded-for']),
    ...parseIpCandidates(headers['x-client-ip']),
    ...parseIpCandidates(headers['x-real-ip']),
    ...parseIpCandidates((req as any).ips),
    ...parseIpCandidates(req.ip),
    ...parseIpCandidates(req.socket?.remoteAddress)
  ];

  const deduped = Array.from(new Set(candidates.filter(Boolean)));
  const firstPublic = deduped.find((ip) => !isPrivateOrLoopbackIp(ip));
  if (firstPublic) return firstPublic;
  return deduped[0] || '';
}

authRouter.get('/ip-debug', (req, res) => {
  const headers = req.headers || {};
  return res.json({
    resolvedIp: getClientIp(req),
    reqIp: req.ip || '',
    reqIps: (req as any).ips || [],
    socketRemoteAddress: req.socket?.remoteAddress || '',
    headers: {
      cfConnectingIp: headers['cf-connecting-ip'] || '',
      trueClientIp: headers['true-client-ip'] || '',
      forwarded: headers['forwarded'] || '',
      xForwardedFor: headers['x-forwarded-for'] || '',
      xClientIp: headers['x-client-ip'] || '',
      xRealIp: headers['x-real-ip'] || ''
    }
  });
});

async function validateUserIpForTeamOnly(user: any, req: any): Promise<string | null> {
  // IP verification only for team users (not super-admin, admin, team-lead)
  if (user.role !== 'team') return null;
  const ip = getClientIp(req);
  const userAllow = Array.isArray((user as any).allowedIps) ? (user as any).allowedIps : [];
  const normalizedUserAllow = userAllow.map((s: any) => String(s).trim()).filter(Boolean);
  if (normalizedUserAllow.length > 0 && !normalizedUserAllow.includes(ip)) {
    return `Login blocked: Your IP (${ip}) is not whitelisted. Contact Super Admin to add your IP.`;
  }
  return null;
}

function normalizeEmail(input: unknown) {
  return String(input || '').toLowerCase().trim();
}

function normalizeOtpToken(input: unknown) {
  return String(input || '').replace(/\s+/g, '').trim();
}

function cleanupTwoFactorState() {
  const now = Date.now();
  for (const [email, item] of pendingTwoFactorSetups.entries()) {
    if (item.expiresAt <= now) pendingTwoFactorSetups.delete(email);
  }
  for (const [ticket, item] of verifiedLoginTickets.entries()) {
    if (item.expiresAt <= now) verifiedLoginTickets.delete(ticket);
  }
}

function issueLoginTicket(userId: string, email: string) {
  cleanupTwoFactorState();
  const ticket = randomBytes(24).toString('hex');
  verifiedLoginTickets.set(ticket, {
    userId,
    email,
    expiresAt: Date.now() + LOGIN_TICKET_TTL_MS
  });
  return ticket;
}

authRouter.post('/2fa/challenge', requireDb, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await UserModel.findOne({ email }).lean();
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account is inactive.' });
    if (user.loginLocked) return res.status(403).json({ error: 'Login Locked: You have already logged out today. Request Admin for unlock.' });

    const hash = (user as any).passwordHash;
    if (!hash || typeof hash !== 'string') return res.status(500).json({ error: 'Server misconfiguration: user account missing password. Contact admin.' });
    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    const ipError = await validateUserIpForTeamOnly(user, req);
    if (ipError) return res.status(403).json({ error: ipError });

    const role = String((user as any).role || '');
    if ((user as any).twoFactorEnabled && (user as any).twoFactorSecret) {
      return res.json({ requiresSetup: false, role });
    }

    const generated = speakeasy.generateSecret({
      name: `GCD-CRM (${email})`
    });

    pendingTwoFactorSetups.set(email, {
      secret: generated.base32,
      expiresAt: Date.now() + PENDING_SETUP_TTL_MS
    });

    const qrCode = await qrcode.toDataURL(generated.otpauth_url || '');
    return res.json({
      requiresSetup: true,
      role,
      qrCode,
      secret: generated.base32
    });
  } catch (e: any) {
    const msg = e?.message && typeof e.message === 'string' ? e.message : 'Failed to initialize 2FA.';
    return res.status(500).json({ error: msg });
  }
});

authRouter.post('/2fa/setup/verify', requireDb, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const token = normalizeOtpToken(req.body?.token);
    if (!email || !token) return res.status(400).json({ error: 'Email and OTP are required' });

    cleanupTwoFactorState();
    const pending = pendingTwoFactorSetups.get(email);
    if (!pending) return res.status(400).json({ error: '2FA setup has expired. Please generate QR again.' });

    const verified = speakeasy.totp.verify({
      secret: pending.secret,
      encoding: 'base32',
      token,
      window: 1
    });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP' });

    const updated = await UserModel.findOneAndUpdate(
      { email },
      {
        $set: {
          twoFactorEnabled: true,
          twoFactorSecret: pending.secret,
          twoFactorEnabledAt: new Date()
        }
      },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'User not found' });

    pendingTwoFactorSetups.delete(email);
    const loginTicket = issueLoginTicket(String((updated as any)._id), email);
    return res.json({ verified: true, loginTicket });
  } catch (e: any) {
    const msg = e?.message && typeof e.message === 'string' ? e.message : 'Failed to verify OTP.';
    return res.status(500).json({ error: msg });
  }
});

authRouter.post('/2fa/verify', requireDb, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const token = normalizeOtpToken(req.body?.token);
    if (!email || !token) return res.status(400).json({ error: 'Email and OTP are required' });

    const user = await UserModel.findOne({ email }).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!(user as any).twoFactorEnabled || !(user as any).twoFactorSecret) {
      return res.status(400).json({ error: '2FA is not set up for this account.' });
    }

    const verified = speakeasy.totp.verify({
      secret: String((user as any).twoFactorSecret),
      encoding: 'base32',
      token,
      window: 1
    });
    if (!verified) return res.status(400).json({ error: 'Invalid OTP' });

    const loginTicket = issueLoginTicket(String((user as any)._id), email);
    return res.json({ verified: true, loginTicket });
  } catch (e: any) {
    const msg = e?.message && typeof e.message === 'string' ? e.message : 'Failed to verify OTP.';
    return res.status(500).json({ error: msg });
  }
});

authRouter.post('/login', requireDb, async (req, res, next) => {
  try {
    const { email, password, loginTicket } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const normalizedEmail = normalizeEmail(email);
    const user = await UserModel.findOne({ email: normalizedEmail }).lean();
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account is inactive.' });
    if (user.loginLocked) return res.status(403).json({ error: 'Login Locked: You have already logged out today. Request Admin for unlock.' });
    const role = String((user as any).role || '');
    const requiresOtpForRole = role === 'admin' || role === 'team';
    if (requiresOtpForRole) {
      if (!(user as any).twoFactorEnabled || !(user as any).twoFactorSecret) {
        return res.status(401).json({ error: '2FA setup is required before login.' });
      }

      cleanupTwoFactorState();
      const ticket = typeof loginTicket === 'string' ? loginTicket.trim() : '';
      const ticketPayload = ticket ? verifiedLoginTickets.get(ticket) : null;
      if (!ticketPayload || ticketPayload.userId !== String((user as any)._id) || ticketPayload.email !== normalizedEmail) {
        return res.status(401).json({ error: '2FA verification required before login.' });
      }
      verifiedLoginTickets.delete(ticket);
    }

    const hash = (user as any).passwordHash;
    if (!hash || typeof hash !== 'string') return res.status(500).json({ error: 'Server misconfiguration: user account missing password. Contact admin.' });

    const ok = await bcrypt.compare(String(password), hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    const ipError = await validateUserIpForTeamOnly(user, req);
    if (ipError) return res.status(403).json({ error: ipError });

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
