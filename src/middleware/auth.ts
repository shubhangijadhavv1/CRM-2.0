import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type AuthUser = {
  id: string;
  role: 'super-admin' | 'admin' | 'team-lead' | 'team';
};

declare global {
  // eslint-disable-next-line no-var
  var __authUserBrand: never;
}

export type AuthedRequest = Request & { user?: AuthUser };

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'Server misconfigured (JWT_SECRET missing)' });

  try {
    const decoded = jwt.verify(token, secret) as any;
    req.user = { id: String(decoded.sub), role: decoded.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(roles: AuthUser['role'][]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    return next();
  };
}

