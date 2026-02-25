import mongoose, { Schema } from 'mongoose';

export interface ChecklistProgressDoc {
  projectId: string; // Project._id string
  stage1: Record<string, boolean>;
  stage2: Record<string, boolean>;
  stage1Notes?: Record<string, string>;
  stage2Notes?: Record<string, string>;
  stage1Assignee: string;
  stage2Assignee: string;
  stage2AssigneeId?: string;
  status: 'dev-in-progress' | 'ready-for-qa' | 'qa-in-progress' | 'completed';
}

const ChecklistProgressSchema = new Schema<ChecklistProgressDoc>(
  {
    projectId: { type: String, required: true, unique: true, index: true },
    stage1: { type: Schema.Types.Mixed, default: {} },
    stage2: { type: Schema.Types.Mixed, default: {} },
    stage1Notes: { type: Schema.Types.Mixed, default: {} },
    stage2Notes: { type: Schema.Types.Mixed, default: {} },
    stage1Assignee: { type: String, default: 'Unassigned' },
    stage2Assignee: { type: String, default: '' },
    stage2AssigneeId: { type: String, default: '' },
    status: { type: String, default: 'dev-in-progress', enum: ['dev-in-progress', 'ready-for-qa', 'qa-in-progress', 'completed'] }
  },
  { timestamps: true }
);

export const ChecklistProgressModel = mongoose.model<ChecklistProgressDoc>('ChecklistProgress', ChecklistProgressSchema);

