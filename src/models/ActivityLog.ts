import mongoose, { Schema } from 'mongoose';

export interface ActivityLogDoc {
  userId: string;
  at: Date;
  status: 'active' | 'idle';
  source: string; // 'desktop-agent' | 'browser'
  activityType?: 'keyboard' | 'mouse'; // optional for future
  activityDetail?: string; // key pressed or mouse event type
  eventType?: 'agent-login' | 'agent-logout';
}

const ActivityLogSchema = new Schema<ActivityLogDoc>(
  {
    userId: { type: String, required: true, index: true },
    at: { type: Date, required: true, index: true },
    status: { type: String, required: true, enum: ['active', 'idle'] },
    source: { type: String, required: true, default: 'browser' },
    activityType: { type: String, enum: ['keyboard', 'mouse'] },
    activityDetail: { type: String, default: '' },
    eventType: { type: String, enum: ['agent-login', 'agent-logout'] }
  },
  { timestamps: false }
);

export const ActivityLogModel = mongoose.model<ActivityLogDoc>('ActivityLog', ActivityLogSchema);
