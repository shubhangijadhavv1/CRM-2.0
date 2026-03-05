import mongoose, { Schema } from 'mongoose';

export interface NoticeDoc {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'urgent' | 'success' | 'warning';
  targetAudience: 'all' | 'branch' | 'individual';
  targetValue?: string;
  date: string;
  createdBy: string;
  readBy: string[];
}

const NoticeSchema = new Schema<NoticeDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    type: { type: String, required: true, enum: ['info', 'urgent', 'success', 'warning'] },
    targetAudience: { type: String, required: true, enum: ['all', 'branch', 'individual'] },
    targetValue: { type: String },
    date: { type: String, required: true },
    createdBy: { type: String, required: true },
    readBy: { type: [String], default: [] }
  },
  { timestamps: true }
);

export const NoticeModel = mongoose.model<NoticeDoc>('Notice', NoticeSchema);

