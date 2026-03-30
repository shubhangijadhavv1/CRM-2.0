import mongoose, { Schema } from 'mongoose';

export interface AppSettingsDoc {
  key: 'default';
  forceNotificationPrompt: boolean;
  /** Gemini API key for AI features (stored server-side only, never returned to client). */
  geminiApiKey?: string;
  agentPolicy?: {
    screenshotEnabled: boolean;
    screenshotIntervalSec: number;
    urlTrackingEnabled: boolean;
    windowTrackingEnabled: boolean;
    trackKeyboard: boolean;
    trackMouse: boolean;
    idleAlertMinutes: number;
    blockedKeywords: string[];
    retentionDays: number;
  };
}

const AppSettingsSchema = new Schema<AppSettingsDoc>(
  {
    key: { type: String, required: true, unique: true, enum: ['default'] },
    forceNotificationPrompt: { type: Boolean, default: true },
    geminiApiKey: { type: String, default: '' },
    agentPolicy: {
      type: new Schema({
        screenshotEnabled: { type: Boolean, default: true },
        screenshotIntervalSec: { type: Number, default: 300 },
        urlTrackingEnabled: { type: Boolean, default: true },
        windowTrackingEnabled: { type: Boolean, default: true },
        trackKeyboard: { type: Boolean, default: true },
        trackMouse: { type: Boolean, default: true },
        idleAlertMinutes: { type: Number, default: 20 },
        blockedKeywords: { type: [String], default: [] },
        retentionDays: { type: Number, default: 7 }
      }, { _id: false }),
      default: () => ({
        screenshotEnabled: true,
        screenshotIntervalSec: 300,
        urlTrackingEnabled: true,
        windowTrackingEnabled: true,
        trackKeyboard: true,
        trackMouse: true,
        idleAlertMinutes: 20,
        blockedKeywords: [],
        retentionDays: 7
      })
    }
  },
  { timestamps: true }
);

export const AppSettingsModel = mongoose.model<AppSettingsDoc>('AppSettings', AppSettingsSchema);

