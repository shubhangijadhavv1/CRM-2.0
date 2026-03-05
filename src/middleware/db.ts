import type { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import type { AuthedRequest } from './auth.js';

export function requireDb(_req: AuthedRequest, res: Response, next: NextFunction) {
  // 1 = connected
  if (mongoose.connection.readyState === 1) return next();
  return res.status(503).json({ error: 'Database not connected. Set MONGO_URI and restart the server.' });
}

