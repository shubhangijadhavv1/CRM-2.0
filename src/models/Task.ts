import mongoose, { Schema } from 'mongoose';

export interface TaskDoc {
  _id: string;
  title: string;
  description: string;
  projectId: string;
  projectName: string;
  assigneeId: string;
  assigneeName: string;
  assignerId: string;
  branch?: string;
  status: 'todo' | 'in-progress' | 'done' | 'overdue';
  priority: 'High' | 'Medium' | 'Low';
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  dueDate: string;
  dueTime?: string;
  timeTracked: number;
  timerStartedAt: number | null;
}

const TaskSchema = new Schema<TaskDoc>(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    projectId: { type: String, default: '' },
    projectName: { type: String, default: 'General Task' },
    assigneeId: { type: String, required: true },
    assigneeName: { type: String, required: true },
    assignerId: { type: String, required: true },
    branch: { type: String, default: '' },
    status: { type: String, required: true, enum: ['todo', 'in-progress', 'done', 'overdue'] },
    priority: { type: String, required: true, enum: ['High', 'Medium', 'Low'] },
    difficulty: { type: String, required: true, enum: ['Easy', 'Medium', 'Hard', 'Expert'] },
    dueDate: { type: String, required: true },
    dueTime: { type: String },
    timeTracked: { type: Number, default: 0 },
    timerStartedAt: { type: Number, default: null }
  },
  { timestamps: true }
);

export const TaskModel = mongoose.model<TaskDoc>('Task', TaskSchema);

