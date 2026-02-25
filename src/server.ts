import './config/env.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo } from './config/db.js';
import { authRouter } from './routes/auth.js';
import { tasksRouter } from './routes/tasks.js';
import { projectsRouter } from './routes/projects.js';
import { bootstrapRouter } from './routes/bootstrap.js';
import { projectConfigRouter } from './routes/projectConfig.js';
import { attendanceRouter } from './routes/attendance.js';
import { leavesRouter } from './routes/leaves.js';
import { noticesRouter } from './routes/notices.js';
import { behaviorRouter } from './routes/behavior.js';
import { branchConfigsRouter } from './routes/branchConfigs.js';
import { usersRouter } from './routes/users.js';
import { checklistTemplatesRouter } from './routes/checklistTemplates.js';
import { checklistProgressRouter } from './routes/checklistProgress.js';
import { appSettingsRouter } from './routes/appSettings.js';
import { notificationsRouter } from './routes/notifications.js';
import { domainMonitoringRouter } from './routes/domainMonitoring.js';
import { activityRouter } from './routes/activity.js';
import { pushRouter } from './routes/pushSubscription.js';
import { errorHandler, notFound } from './middleware/error.js';
import mongoose from 'mongoose';
import { ensureInitialSuperAdmin } from './config/initialSuperAdmin.js';
import { initIo } from './realtime/io.js';
import { configureWebPush } from './realtime/webpush.js';

const app = express();
const httpServer = createServer(app);
app.use(
  helmet({
    // Disable CSP so Tailwind CDN and inline scripts in index.html work.
    // (Do NOT call helmet() again later with defaults or it will re-enable CSP.)
    contentSecurityPolicy: false,
  })
);

// Resolve frontend build path (your Vite build is at server/src/dist)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildPath = path.resolve(__dirname, 'dist');

// Required for correct client IP when behind a proxy (nginx/cloudflare/vercel).
// In localhost dev, this still works (req.ip will be 127.0.0.1/::1).
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5173';
const allowedOrigins = new Set([
  clientOrigin,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://0.0.0.0:5173'
]);
// In production we can safely allow all origins for the HTTP API because
// auth is handled via Bearer tokens, not cookies.
app.use(
  cors({
    origin: '*'
  })
);
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/project-config', projectConfigRouter);
app.use('/api/bootstrap', bootstrapRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/leaves', leavesRouter);
app.use('/api/notices', noticesRouter);
app.use('/api/behavior', behaviorRouter);
app.use('/api/branch-configs', branchConfigsRouter);
app.use('/api/users', usersRouter);
app.use('/api/checklist-templates', checklistTemplatesRouter);
app.use('/api/checklist-progress', checklistProgressRouter);
app.use('/api/app-settings', appSettingsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/domain-monitoring', domainMonitoringRouter);
app.use('/api/activity', activityRouter);
app.use('/api/push', pushRouter);

// Serve the React/Vite frontend build (DigitalOcean / single-server deploy)
// Static assets from "dist"
app.use(express.static(buildPath));

// SPA fallback: any non-API route should return index.html
app.get('/*', (_req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

app.use(notFound);
app.use(errorHandler);

async function start() {
  const port = Number(process.env.PORT || 5001);
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    // Start anyway so the API can return a clear error rather than crashing.
    // eslint-disable-next-line no-console
    console.warn('[api] MONGO_URI not set. Server will start, but DB-backed routes will fail.');
    mongoose.set('bufferCommands', false);
  } else {
    await connectMongo(mongoUri);
    // eslint-disable-next-line no-console
    console.log('[api] MongoDB connected');
    await ensureInitialSuperAdmin();
  }

  initIo(httpServer, [...allowedOrigins]);
  configureWebPush();

  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] failed to start', err);
  process.exit(1);
});

