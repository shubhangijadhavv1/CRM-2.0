import mongoose, { Schema } from 'mongoose';

export interface AuditLogDoc {
  id: string;
  actorUserId: string;
  action: string;
  targetUserId?: string;
  metadata?: string;
}

const AuditLogSchema = new Schema<AuditLogDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    actorUserId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    targetUserId: { type: String, default: '' },
    metadata: { type: String, default: '' }
  },
  { timestamps: true }
);

AuditLogSchema.index({ actorUserId: 1, createdAt: -1 });

export const AuditLogModel = mongoose.model<AuditLogDoc>('AuditLog', AuditLogSchema);
