import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { UserModel } from '../models/User.js';
import { AppSettingsModel } from '../models/AppSettings.js';

function credentialsPath() {
  return path.resolve(process.cwd(), 'superadmin.credentials.local');
}

export async function ensureInitialSuperAdmin() {
  const userCount = await UserModel.estimatedDocumentCount();
  if (userCount > 0) return;

  const email = process.env.INITIAL_SUPERADMIN_EMAIL?.trim() || 'superadmin@local';
  const password =
    process.env.INITIAL_SUPERADMIN_PASSWORD?.trim() ||
    crypto.randomBytes(12).toString('base64url');

  const passwordHash = await bcrypt.hash(password, 10);

  await UserModel.create({
    name: 'Super Admin',
    email,
    passwordHash,
    role: 'super-admin',
    branch: 'Main',
    jobTitle: 'System Administrator',
    allowedModules: ['all'],
    allowedWorkModes: ['office', 'wfh'],
    status: 'active',
    loginLocked: false,
    privacyModeEnabled: false,
    idleTrackingEnabled: true
  });

  // Default org setting: prompt notification permission for staff in new browsers
  await AppSettingsModel.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default', forceNotificationPrompt: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  // Persist to a local file (gitignored by *.local) so you can retrieve it after restarts.
  fs.writeFileSync(
    credentialsPath(),
    `SUPERADMIN_EMAIL=${email}\nSUPERADMIN_PASSWORD=${password}\n`,
    'utf8'
  );
}

