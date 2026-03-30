import mongoose, { Schema } from 'mongoose';

export type NotificationType = 'info' | 'alert' | 'success';

export interface NotificationLink {
  view: string;
  taskId?: string;
  projectId?: string;
  leaveId?: string;
  noticeId?: string;
  userId?: string;
}

export interface NotificationDoc {
  id: string;
  userId: string; // receiver
  title: string;
  message: string;
  type: NotificationType;
  time: string;
  read: boolean;
  link?: NotificationLink;
}

const NotificationSchema = new Schema<NotificationDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, required: true, enum: ['info', 'alert', 'success'] },
    time: { type: String, required: true },
    read: { type: Boolean, default: false },
    link: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

export const NotificationModel = mongoose.model<NotificationDoc>('Notification', NotificationSchema);

