import mongoose, { Schema } from 'mongoose';

export type UserRole = 'super-admin' | 'admin' | 'team';

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  jobTitle?: string;
  branch?: string;
  allowedModules: string[];
  allowedWorkModes?: ('office' | 'wfh')[];
  status: 'active' | 'inactive';
  loginLocked?: boolean;
  privacyModeEnabled?: boolean;
  idleTrackingEnabled?: boolean;
  avatar?: string;
  allowedIps?: string[]; // per-user allowlist (exact match), enforced on login if set

  // Browser extension activity signals (browser-wide, not OS-wide)
  lastBrowserActivityAt?: Date;
  lastBrowserHeartbeatAt?: Date;
  browserIsIdle?: boolean;
  browserIdleForMs?: number;
  browserLastReason?: string;
  browserCrmOrigin?: string;
  browserExtensionVersion?: string;
}

const UserSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['super-admin', 'admin', 'team'] },
    jobTitle: { type: String },
    branch: { type: String },
    allowedModules: { type: [String], default: [] },
    allowedWorkModes: { type: [String], default: ['office', 'wfh'] },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    loginLocked: { type: Boolean, default: false },
    privacyModeEnabled: { type: Boolean, default: false },
    idleTrackingEnabled: { type: Boolean, default: true },
    avatar: { type: String },
    allowedIps: { type: [String], default: [] },

    lastBrowserActivityAt: { type: Date, default: null },
    lastBrowserHeartbeatAt: { type: Date, default: null },
    browserIsIdle: { type: Boolean, default: false },
    browserIdleForMs: { type: Number, default: 0 },
    browserLastReason: { type: String, default: '' },
    browserCrmOrigin: { type: String, default: '' },
    browserExtensionVersion: { type: String, default: '' }
  },
  { timestamps: true }
);

export const UserModel = mongoose.model<UserDoc>('User', UserSchema);

