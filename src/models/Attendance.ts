import mongoose, { Schema } from 'mongoose';

export interface AttendanceDoc {
  id: string; // client-friendly id (not Mongo _id)
  userId: string;
  userName: string;
  date: string; // YYYY-MM-DD
  branch: string;
  mode: 'office' | 'wfh';
  checkInTime: string | null; // first session check-in (never changes)
  checkOutTime: string | null; // last session check-out (null when active)
  ipAddress: string;
  isLate: boolean;
  lateReason?: string;
  breaks: { type: 'lunch' | 'tea'; startTime: string; endTime: string | null }[];
  sessions?: { checkIn: string; checkOut: string | null }[]; // multi-session support
  idleIntervals: { startTime: string; endTime: string | null; deducted: boolean }[];
  idleMinutes: number;
  totalWorkMinutes: number;
  status: 'present' | 'absent' | 'half-day' | 'leave';
  dailyStatus: 'checked-in' | 'lunch-break' | 'tea-break' | 'checked-out' | 'offline' | 'idle' | 'background';
}

const AttendanceSchema = new Schema<AttendanceDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, required: true },
    date: { type: String, required: true, index: true },
    branch: { type: String, required: true },
    mode: { type: String, required: true, enum: ['office', 'wfh'] },
    checkInTime: { type: String, default: null },
    checkOutTime: { type: String, default: null },
    ipAddress: { type: String, default: '' },
    isLate: { type: Boolean, default: false },
    lateReason: { type: String },
    breaks: {
      type: [
        {
          type: { type: String, enum: ['lunch', 'tea'], required: true },
          startTime: { type: String, required: true },
          endTime: { type: String, default: null }
        }
      ],
      default: []
    },
    sessions: {
      type: [
        {
          checkIn: { type: String, required: true },
          checkOut: { type: String, default: null }
        }
      ],
      default: undefined
    },
    idleIntervals: {
      type: [
        {
          startTime: { type: String, required: true },
          endTime: { type: String, default: null },
          deducted: { type: Boolean, default: false }
        }
      ],
      default: []
    },
    idleMinutes: { type: Number, default: 0 },
    totalWorkMinutes: { type: Number, default: 0 },
    status: { type: String, enum: ['present', 'absent', 'half-day', 'leave'], default: 'present' },
    dailyStatus: {
      type: String,
      enum: ['checked-in', 'lunch-break', 'tea-break', 'checked-out', 'offline', 'idle', 'background'],
      default: 'checked-out'
    }
  },
  { timestamps: true }
);

export const AttendanceModel = mongoose.model<AttendanceDoc>('Attendance', AttendanceSchema);

