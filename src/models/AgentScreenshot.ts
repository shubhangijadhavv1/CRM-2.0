import mongoose, { Schema } from 'mongoose';

export interface AgentScreenshotDoc {
  userId: string;
  at: Date;
  imageDataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  source: 'desktop-agent';
}

const AgentScreenshotSchema = new Schema<AgentScreenshotDoc>(
  {
    userId: { type: String, required: true, index: true },
    at: { type: Date, required: true, index: true },
    imageDataUrl: { type: String, required: true },
    mimeType: { type: String, required: true, default: 'image/jpeg' },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    source: { type: String, required: true, enum: ['desktop-agent'], default: 'desktop-agent' }
  },
  { timestamps: true }
);

AgentScreenshotSchema.index({ userId: 1, at: -1 });

export const AgentScreenshotModel = mongoose.model<AgentScreenshotDoc>('AgentScreenshot', AgentScreenshotSchema);
