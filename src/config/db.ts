import mongoose from 'mongoose';

export async function connectMongo(mongoUri: string) {
  mongoose.set('strictQuery', true);
  // Fail fast (don't silently buffer queries) if the DB goes down.
  mongoose.set('bufferCommands', false);
  await mongoose.connect(mongoUri);
  return mongoose.connection;
}

