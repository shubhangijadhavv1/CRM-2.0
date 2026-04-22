import mongoose, { Schema } from 'mongoose';

export interface BehaviorDoc {
  id: string;
  userId: string;
  loggedByUserId: string;
  date: string;
  type: 'positive' | 'negative' | 'neutral';
  category: 'Punctuality' | 'Teamwork' | 'Code Quality' | 'Communication' | 'Insubordination' | 'Other';
  description: string;
  impactScore: number;
}

const BehaviorSchema = new Schema<BehaviorDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    loggedByUserId: { type: String, required: true },
    date: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ['positive', 'negative', 'neutral'] },
    category: { type: String, required: true, enum: ['Punctuality', 'Teamwork', 'Code Quality', 'Communication', 'Insubordination', 'Other'] },
    description: { type: String, required: true },
    impactScore: { type: Number, required: true }
  },
  { timestamps: true }
);

export const BehaviorModel = mongoose.model<BehaviorDoc>('Behavior', BehaviorSchema);

