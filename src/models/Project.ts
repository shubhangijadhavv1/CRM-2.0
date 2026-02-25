import mongoose, { Schema } from 'mongoose';

export interface ProjectDoc {
  _id: string;
  name: string;
  url?: string;
  category: string;
  subcategory: string;
  assignee: string;
  priority: 'High' | 'Medium' | 'Low';
  status: string;
  startDate?: string;
  endDate: string;
  websiteType: string;
  server: string;
  type: 'live' | 'demo';
  qaProgress1?: number;
  qaProgress2?: number;
}

const ProjectSchema = new Schema<ProjectDoc>(
  {
    name: { type: String, required: true },
    url: { type: String },
    category: { type: String, default: '' },
    subcategory: { type: String, default: '' },
    assignee: { type: String, default: '' },
    priority: { type: String, required: true, enum: ['High', 'Medium', 'Low'] },
    status: { type: String, default: 'Not Started' },
    startDate: { type: String },
    endDate: { type: String, required: true },
    websiteType: { type: String, default: '' },
    server: { type: String, default: '' },
    type: { type: String, required: true, enum: ['live', 'demo'] },
    qaProgress1: { type: Number },
    qaProgress2: { type: Number }
  },
  { timestamps: true }
);

export const ProjectModel = mongoose.model<ProjectDoc>('Project', ProjectSchema);

