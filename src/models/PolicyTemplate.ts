import mongoose, { Schema } from 'mongoose';

export interface PolicyPageItem {
  id: string;
  label: string;
  content: string;
}

export interface PolicyCategoryItem {
  id: string;
  label: string;
  policyPages: PolicyPageItem[];
}

export interface PolicyTemplateDoc {
  key: 'default';
  categories: PolicyCategoryItem[];
}

const PolicyPageSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    content: { type: String, default: '' }
  },
  { _id: false }
);

const PolicyCategorySchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    policyPages: { type: [PolicyPageSchema], default: [] }
  },
  { _id: false }
);

const PolicyTemplateSchema = new Schema<PolicyTemplateDoc>(
  {
    key: { type: String, required: true, unique: true, enum: ['default'] },
    categories: { type: [PolicyCategorySchema], default: [] }
  },
  { timestamps: true }
);

export const PolicyTemplateModel = mongoose.model<PolicyTemplateDoc>('PolicyTemplate', PolicyTemplateSchema);
