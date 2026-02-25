import mongoose, { Schema } from 'mongoose';

export interface ChecklistTemplateDoc {
  key: 'default';
  templates: Record<string, string[]>;
}

const ChecklistTemplateSchema = new Schema<ChecklistTemplateDoc>(
  {
    key: { type: String, required: true, unique: true, enum: ['default'] },
    templates: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const ChecklistTemplateModel = mongoose.model<ChecklistTemplateDoc>('ChecklistTemplate', ChecklistTemplateSchema);

