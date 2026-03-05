import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { ProjectConfigModel } from '../models/ProjectConfig.js';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  await connectMongo(mongoUri);
  await ProjectConfigModel.deleteMany({});

  // eslint-disable-next-line no-console
  console.log('Cleared ProjectConfig (categories/servers/types).');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

