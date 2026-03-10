import mongoose, { Schema } from 'mongoose';

export interface MigrationDoc {
  _id: string;
  projectId: string;
  projectName: string;
  demoUrl: string;
  liveUrl: string;
  migrationDate: string;
  migratedBy: string;
  dataCleared: boolean;
}

const MigrationSchema = new Schema<MigrationDoc>(
  {
    projectId: { type: String, required: true, trim: true },
    projectName: { type: String, required: true, trim: true },
    demoUrl: { type: String, required: true, trim: true },
    liveUrl: { type: String, required: true, trim: true },
    migrationDate: { type: String, required: true, trim: true },
    migratedBy: { type: String, required: true, trim: true },
    dataCleared: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const MigrationModel = mongoose.model<MigrationDoc>('Migration', MigrationSchema);
