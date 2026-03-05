import mongoose, { Schema } from 'mongoose';

export interface MonitoredDomainDoc {
  _id: string;
  domain: string;
  addedBy?: string;
  isLive: boolean | null;
  isParked: boolean | null;
  parkingProvider?: string;
  responseTime?: number;
  statusCode?: number;
  lastChecked: Date | null;
  lastScan?: {
    startUrl: string;
    baseHost: string;
    pagesScanned: number;
    pagesVisited: string[];
    internalLinks: string[];
    externalLinks: string[];
    images: Array<{
      url: string;
      isInternal: boolean;
      bytes: number | null;
      contentType: string | null;
    }>;
    errors: Array<{
      url: string;
      error: string;
    }>;
  };
}

const MonitoredDomainSchema = new Schema<MonitoredDomainDoc>(
  {
    domain: { type: String, required: true, unique: true, index: true },
    addedBy: { type: String, ref: 'User' },
    isLive: { type: Boolean, default: null },
    isParked: { type: Boolean, default: null },
    parkingProvider: { type: String },
    responseTime: { type: Number },
    statusCode: { type: Number },
    lastChecked: { type: Date, default: null },
    lastScan: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

export const MonitoredDomainModel = mongoose.model<MonitoredDomainDoc>('MonitoredDomain', MonitoredDomainSchema);
