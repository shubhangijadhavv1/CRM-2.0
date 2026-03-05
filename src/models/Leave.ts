import mongoose, { Schema } from 'mongoose';

export interface LeaveDoc {
  id: string;
  userId: string;
  userName: string;
  type: 'sick' | 'casual' | 'earned' | 'unpaid' | 'half-day';
  session?: 'first-half' | 'second-half';
  startDate: string;
  endDate: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  adminComment?: string;
  /** When set, only these dates count as approved (partial approval). Otherwise full range is approved/rejected. */
  approvedDays?: string[];
}

const LeaveSchema = new Schema<LeaveDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, required: true },
    type: { type: String, required: true, enum: ['sick', 'casual', 'earned', 'unpaid', 'half-day'] },
    session: { type: String, enum: ['first-half', 'second-half'] },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    reason: { type: String, required: true },
    status: { type: String, required: true, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminComment: { type: String },
    approvedDays: { type: [String], default: undefined }
  },
  { timestamps: true }
);

export const LeaveModel = mongoose.model<LeaveDoc>('Leave', LeaveSchema);

