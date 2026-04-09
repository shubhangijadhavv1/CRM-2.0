import mongoose, { Schema } from 'mongoose';

export type UserRole = 'super-admin' | 'admin' | 'team-lead' | 'team';

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  jobTitle?: string;
  branch?: string;
  branches?: string[]; // Multiple branches (team-lead/admin); if set, overrides single branch for scope
  allowedModules: string[];
  allowedWorkModes?: ('office' | 'wfh')[];
  status: 'active' | 'inactive';
  loginLocked?: boolean;
  privacyModeEnabled?: boolean;
  idleTrackingEnabled?: boolean;
  screenshotEnabled?: boolean; // per-user override: true=force on, false=force off, undefined=follow global policy
  avatar?: string;
  allowedIps?: string[]; // per-user allowlist (exact match), enforced on login if set

  // Extended profile (persisted in MongoDB)
  mobile?: string;
  address?: string;
  bankDetails?: {
    accountName?: string;
    accountNumber?: string;
    bankName?: string;
    ifscCode?: string;
    branchName?: string;
    upiId?: string;
  };
  documents?: Array<{
    id: string;
    label: string;
    fileName: string;
    fileUrl: string;
    uploadDate: string;
  }>;

  // Browser extension activity signals (browser-wide, not OS-wide)
  lastBrowserActivityAt?: Date;
  lastBrowserHeartbeatAt?: Date;
  browserIsIdle?: boolean;
  browserIdleForMs?: number;
  browserLastReason?: string;
  browserCrmOrigin?: string;
  browserExtensionVersion?: string;
  // Desktop agent: explicit login/logout for real-time CRM display
  lastAgentLoginAt?: Date;
  lastAgentLogoutAt?: Date;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string;
  twoFactorEnabledAt?: Date | null;
}

const UserSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['super-admin', 'admin', 'team-lead', 'team'] },
    jobTitle: { type: String },
    branch: { type: String },
    branches: { type: [String], default: undefined },
    allowedModules: { type: [String], default: [] },
    allowedWorkModes: { type: [String], default: ['office', 'wfh'] },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    loginLocked: { type: Boolean, default: false },
    privacyModeEnabled: { type: Boolean, default: false },
    idleTrackingEnabled: { type: Boolean, default: true },
    screenshotEnabled: { type: Boolean }, // no default — absence means "follow global policy"
    avatar: { type: String },
    allowedIps: { type: [String], default: [] },

    mobile: { type: String, default: '' },
    address: { type: String, default: '' },
    bankDetails: {
      type: {
        accountName: String,
        accountNumber: String,
        bankName: String,
        ifscCode: String,
        branchName: String,
        upiId: String
      },
      default: undefined
    },
    documents: {
      type: [{
        id: String,
        label: String,
        fileName: String,
        fileUrl: String,
        uploadDate: String
      }],
      default: undefined
    },

    lastBrowserActivityAt: { type: Date, default: null },
    lastBrowserHeartbeatAt: { type: Date, default: null },
    browserIsIdle: { type: Boolean, default: false },
    browserIdleForMs: { type: Number, default: 0 },
    browserLastReason: { type: String, default: '' },
    browserCrmOrigin: { type: String, default: '' },
    browserExtensionVersion: { type: String, default: '' },
    lastAgentLoginAt: { type: Date, default: null },
    lastAgentLogoutAt: { type: Date, default: null },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: '' },
    twoFactorEnabledAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export const UserModel = mongoose.model<UserDoc>('User', UserSchema);
