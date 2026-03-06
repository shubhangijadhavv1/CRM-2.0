import './config/env.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
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
import { policyTemplatesRouter } from './routes/policyTemplates.js';
import { aiRouter } from './routes/ai.js';
import { errorHandler, notFound } from './middleware/error.js';
import mongoose from 'mongoose';
import { ensureInitialSuperAdmin } from './config/initialSuperAdmin.js';
import { initIo } from './realtime/io.js';
import { configureWebPush } from './realtime/webpush.js';

const app = express();
const httpServer = createServer(app);

// Required for correct client IP when behind a proxy (nginx/cloudflare/vercel).
// In localhost dev, this still works (req.ip will be 127.0.0.1/::1).
app.set('trust proxy', true);


app.use(express.json({ limit: '10mb' }));

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5174';
const allowedOrigins = new Set([
  clientOrigin,
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://0.0.0.0:5174',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://0.0.0.0:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://0.0.0.0:5174',
  'http://127.0.0.1:5175',
  'http://localhost:5175',
  'http://0.0.0.0:5175'
]);
// Allow any host on common dev ports (3000, 5170–5179)
const devPortRegex = /^https?:\/\/[^/]+:(3000|517[0-9])$/;
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (origin.startsWith('chrome-extension://')) return cb(null, true);
      if (devPortRegex.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  }),
  helmet({
      contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
  })
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildPath = path.resolve(__dirname, 'dist');
app.use(express.static(buildPath));

const downloadDirectories = [
  process.env.DOWNLOADS_DIR,
  path.resolve(process.cwd(), 'public', 'downloads'),
  path.resolve(process.cwd(), 'desktop-agent', 'release'),
  path.resolve(process.cwd(), '..', 'desktop-agent', 'release'),
  path.resolve(__dirname, '..', 'desktop-agent', 'release'),
  path.resolve(__dirname, '..', '..', 'desktop-agent', 'release')
].filter((value): value is string => Boolean(value));

function pickLatestFile(regex: RegExp, preferredNameRegex?: RegExp) {
  const matches: { fullPath: string; fileName: string; mtimeMs: number }[] = [];
  for (const dir of downloadDirectories) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!regex.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      matches.push({ fullPath, fileName: entry.name, mtimeMs: stat.mtimeMs });
    }
  }

  if (!matches.length) return null;
  const preferred = preferredNameRegex
    ? matches.filter((item) => preferredNameRegex.test(item.fileName))
    : matches;
  const source = preferred.length ? preferred : matches;
  source.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return source[0];
}

app.get('/api/downloads/mac', (_req, res) => {
  const externalUrl = process.env.DOWNLOAD_MAC_URL?.trim();
  if (externalUrl) return res.redirect(externalUrl);

  const file = pickLatestFile(/\.dmg$/i, /nexus|agent|crm/i);
  if (!file) return res.status(404).json({ error: 'Mac installer not found on server.' });
  return res.download(file.fullPath, file.fileName);
});

app.get('/api/downloads/windows', (_req, res) => {
  const externalUrl = process.env.DOWNLOAD_WINDOWS_URL?.trim();
  if (externalUrl) return res.redirect(externalUrl);

  const file = pickLatestFile(/\.exe$/i, /setup|nexus|agent|crm/i);
  if (!file) return res.status(404).json({ error: 'Windows installer not found on server.' });
  return res.download(file.fullPath, file.fileName);
});






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
app.use('/api/policy-templates', policyTemplatesRouter);
app.use('/api/ai', aiRouter);

app.use(notFound);
app.use(errorHandler);

// SPA fallback: any non-API route should return index.html
app.get('/*', (_req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

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
