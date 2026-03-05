import type { NextFunction, Request, Response } from 'express';

export function notFound(req: Request, res: Response) {
  res.status(404).json({ error: 'Not Found', path: req.path });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message =
    typeof err?.message === 'string' ? err.message : 'Internal Server Error';

  if (process.env.NODE_ENV !== 'test') {
    // Keep logs small but useful
    // eslint-disable-next-line no-console
    console.error('[api:error]', { status, message, path: req.path });
  }

  res.status(status).json({ error: message });
}

