import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

function tryLoadDotenv() {
  // Prefer a non-dot local file (gitignored via *.local) to avoid dotfile tooling issues.
  const localEnvPath = path.resolve(process.cwd(), 'env.local');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath });
    return;
  }
  // Fallback to standard dotenv behavior (.env) if present.
  dotenv.config();
}

function ensureJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) return;

  const secretFile = path.resolve(process.cwd(), 'jwt.secret.local');
  if (fs.existsSync(secretFile)) {
    const s = fs.readFileSync(secretFile, 'utf8').trim();
    if (s) {
      process.env.JWT_SECRET = s;
      return;
    }
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, generated + '\n', { encoding: 'utf8', flag: 'w' });
  process.env.JWT_SECRET = generated;
}

function ensureMongoUri() {
  if (process.env.MONGO_URI && process.env.MONGO_URI.trim()) return;

  const uriFile = path.resolve(process.cwd(), 'mongo.uri.local');
  if (fs.existsSync(uriFile)) {
    const uri = fs.readFileSync(uriFile, 'utf8').trim();
    if (uri) process.env.MONGO_URI = uri;
  }
}

function ensureVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return;

  const vapidFile = path.resolve(process.cwd(), 'vapid.keys.local');
  if (fs.existsSync(vapidFile)) {
    try {
      const raw = fs.readFileSync(vapidFile, 'utf8').trim();
      const parsed = JSON.parse(raw);
      if (parsed.publicKey && parsed.privateKey) {
        process.env.VAPID_PUBLIC_KEY = parsed.publicKey;
        process.env.VAPID_PRIVATE_KEY = parsed.privateKey;
        return;
      }
    } catch { /* regenerate */ }
  }

  // Auto-generate VAPID keys using web-push
  try {
    const esmRequire = createRequire(import.meta.url);
    const webpush = esmRequire('web-push');
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(keys, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    console.log('[Env] Generated VAPID keys → vapid.keys.local');
  } catch {
    console.warn('[Env] web-push not available — VAPID keys not generated');
  }
}

// Run once at import time.
tryLoadDotenv();
ensureJwtSecret();
ensureMongoUri();
ensureVapidKeys();

