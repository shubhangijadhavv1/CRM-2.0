import mongoose, { Schema } from 'mongoose';

export interface ProjectConfigDoc {
  key: 'default';
  categoryOptions: Record<string, string[]>;
  serverOptions: string[];
  websiteTypeOptions: string[];
}

const ProjectConfigSchema = new Schema<ProjectConfigDoc>(
  {
    key: { type: String, required: true, unique: true, enum: ['default'] },
    categoryOptions: { type: Schema.Types.Mixed, default: {} },
    serverOptions: { type: [String], default: [] },
    websiteTypeOptions: { type: [String], default: [] }
  },
  { timestamps: true }
);

export const ProjectConfigModel = mongoose.model<ProjectConfigDoc>('ProjectConfig', ProjectConfigSchema);

