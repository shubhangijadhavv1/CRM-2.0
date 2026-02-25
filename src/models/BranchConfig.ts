import mongoose, { Schema } from 'mongoose';

export interface BranchConfigDoc {
  id: string; // e.g. Pune, Mumbai
  name: string;
  startTime: string;
  endTime: string;
  lunchStart: string;
  lunchEnd: string;
  teaBreakDurationMinutes: number;
  lunchTimeLimitMinutes: number; // Maximum allowed lunch time in minutes
  teaBreakTimeLimitMinutes: number; // Maximum allowed tea break time in minutes
  autoLunchBreakThresholdMinutes: number; // Auto-detect lunch break if idle for this long during lunch hours
  autoTeaBreakThresholdMinutes: number; // Auto-detect tea break if idle for this long
  lateMarkGraceMinutes: number;
  ipRestrictions: string[];
  yearlyPaidLeaves: number;
  weekendPolicy: { saturdaysOff: number[]; sundayOff: boolean };
  holidays: { date: string; name: string }[];
}

const BranchConfigSchema = new Schema<BranchConfigDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    lunchStart: { type: String, required: true },
    lunchEnd: { type: String, required: true },
    teaBreakDurationMinutes: { type: Number, required: true },
    lunchTimeLimitMinutes: { type: Number, default: 30 }, // Default 30 minutes
    teaBreakTimeLimitMinutes: { type: Number, default: 15 }, // Default 15 minutes
    autoLunchBreakThresholdMinutes: { type: Number, default: 20 }, // Auto-detect lunch if idle 20+ min during lunch hours
    autoTeaBreakThresholdMinutes: { type: Number, default: 10 }, // Auto-detect tea break if idle 10+ min
    lateMarkGraceMinutes: { type: Number, required: true },
    ipRestrictions: { type: [String], default: [] },
    yearlyPaidLeaves: { type: Number, required: true },
    weekendPolicy: {
      type: {
        saturdaysOff: { type: [Number], default: [] },
        sundayOff: { type: Boolean, default: true }
      },
      default: { saturdaysOff: [], sundayOff: true }
    },
    holidays: {
      type: [{ date: { type: String, required: true }, name: { type: String, required: true } }],
      default: []
    }
  },
  { timestamps: true }
);

export const BranchConfigModel = mongoose.model<BranchConfigDoc>('BranchConfig', BranchConfigSchema);

