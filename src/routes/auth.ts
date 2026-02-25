import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models/User.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';

export const authRouter = Router();

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

    const ok = await bcrypt.compare(String(password), user.passwordHash);
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
        const branchId = (user as any).branch || 'Main';
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
    const safeUser = { ...user, id: String(user._id) };
    // @ts-expect-error - remove sensitive fields
    delete safeUser._id;
    // @ts-expect-error - remove sensitive fields
    delete safeUser.passwordHash;

    return res.json({ token, user: safeUser });
  } catch (e) {
    return next(e);
  }
});

authRouter.get('/me', requireAuth, requireDb, async (req: AuthedRequest, res, next) => {
  try {
    const user = await UserModel.findById(req.user!.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safeUser = { ...user, id: String(user._id) };
    // @ts-expect-error - remove sensitive fields
    delete safeUser._id;
    // @ts-expect-error - remove sensitive fields
    delete safeUser.passwordHash;
    return res.json({ user: safeUser });
  } catch (e) {
    return next(e);
  }
});

