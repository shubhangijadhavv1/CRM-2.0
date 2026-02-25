import mongoose, { Schema } from 'mongoose';

export interface PushSubscriptionDoc {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt?: Date;
  updatedAt?: Date;
}

const PushSubscriptionSchema = new Schema<PushSubscriptionDoc>(
  {
    userId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    }
  },
  { timestamps: true }
);

PushSubscriptionSchema.index({ userId: 1, endpoint: 1 }, { unique: true });

export const PushSubscriptionModel = mongoose.model<PushSubscriptionDoc>('PushSubscription', PushSubscriptionSchema);
