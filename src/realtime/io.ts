import type { Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import jwt from 'jsonwebtoken';

type AuthUser = { id: string; role: 'super-admin' | 'admin' | 'team' };

let io: IOServer | null = null;

export function initIo(httpServer: HttpServer, clientOrigins: string | string[]) {
  io = new IOServer(httpServer, {
    cors: {
      origin: clientOrigins,
      credentials: true
    }
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth as any)?.token ||
        (socket.handshake.headers?.authorization || '').split(' ')[1];
      if (!token) return next(new Error('unauthorized'));
      const secret = process.env.JWT_SECRET;
      if (!secret) return next(new Error('server_misconfigured'));
      const decoded = jwt.verify(token, secret) as any;
      (socket.data as any).user = { id: String(decoded.sub), role: decoded.role } satisfies AuthUser;
      return next();
    } catch (err: any) {
      console.warn('[socket] unauthorized connection attempt:', err.message);
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // join per-user room so we can target in future
    const user = (socket.data as any).user as AuthUser | undefined;
    if (user?.id) {
      socket.join(`user:${user.id}`);
      // Super-admins and admins join the 'admins' room for instant user-status broadcasts
      if (user.role === 'super-admin' || user.role === 'admin') {
        socket.join('admins');
      }
    }
  });

  return io;
}

export function getIo() {
  return io;
}

/** Emit a lightweight user-status update to all admins instantly (no full refetch needed). */
export function emitUserStatus(payload: {
  userId: string;
  browserIsIdle: boolean;
  browserIdleForMs: number;
  lastBrowserActivityAt: string;
  lastBrowserHeartbeatAt: string;
}) {
  if (!io) return;
  io.to('admins').emit('user-status', payload);
}

