import mongoose, { Schema } from 'mongoose';

export interface AgentWindowEventDoc {
  userId: string;
  at: Date;
  appName: string;
  windowTitle: string;
  domain?: string;
  url?: string;
  source: 'desktop-agent';
}

const AgentWindowEventSchema = new Schema<AgentWindowEventDoc>(
  {
    userId: { type: String, required: true, index: true },
    at: { type: Date, required: true, index: true },
    appName: { type: String, required: true, default: '' },
    windowTitle: { type: String, required: true, default: '' },
    domain: { type: String, default: '' },
    url: { type: String, default: '' },
    source: { type: String, required: true, enum: ['desktop-agent'], default: 'desktop-agent' }
  },
  { timestamps: true }
);

AgentWindowEventSchema.index({ userId: 1, at: -1 });

export const AgentWindowEventModel = mongoose.model<AgentWindowEventDoc>('AgentWindowEvent', AgentWindowEventSchema);
