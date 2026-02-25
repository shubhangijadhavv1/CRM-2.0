import { getIo } from './io.js';

export function emitInvalidate(scope: string) {
  const io = getIo();
  if (!io) return;
  io.emit('invalidate', { scope, ts: Date.now() });
}

