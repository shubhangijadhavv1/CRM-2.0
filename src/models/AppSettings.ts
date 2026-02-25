import mongoose, { Schema } from 'mongoose';

export interface AppSettingsDoc {
  key: 'default';
  forceNotificationPrompt: boolean;
  /** Gemini API key for AI features (stored server-side only, never returned to client). */
  geminiApiKey?: string;
}

const AppSettingsSchema = new Schema<AppSettingsDoc>(
  {
    key: { type: String, required: true, unique: true, enum: ['default'] },
    forceNotificationPrompt: { type: Boolean, default: true },
    geminiApiKey: { type: String, default: '' }
  },
  { timestamps: true }
);

export const AppSettingsModel = mongoose.model<AppSettingsDoc>('AppSettings', AppSettingsSchema);

