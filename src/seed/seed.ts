import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { seedIfEmpty } from './seedIfEmpty.js';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required to seed the database');
  }
  await connectMongo(mongoUri);
  await seedIfEmpty();
  // eslint-disable-next-line no-console
  console.log('Seed completed (or skipped if already seeded).');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

