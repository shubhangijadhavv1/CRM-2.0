import mongoose, { Schema } from 'mongoose';

export type AgentAlertSeverity = 'info' | 'warning' | 'critical';

export interface AgentAlertDoc {
  id: string;
  userId: string;
  ruleKey: string;
  severity: AgentAlertSeverity;
  message: string;
  details?: string;
  resolvedAt?: Date | null;
}

const AgentAlertSchema = new Schema<AgentAlertDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    ruleKey: { type: String, required: true },
    severity: { type: String, required: true, enum: ['info', 'warning', 'critical'], default: 'warning' },
    message: { type: String, required: true },
    details: { type: String, default: '' },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AgentAlertSchema.index({ userId: 1, createdAt: -1 });

export const AgentAlertModel = mongoose.model<AgentAlertDoc>('AgentAlert', AgentAlertSchema);
