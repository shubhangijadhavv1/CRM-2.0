import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { UserModel } from '../models/User.js';
import bcrypt from 'bcryptjs';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  await connectMongo(mongoUri);

  const newPassword = 'admin123';
  const hash = await bcrypt.hash(newPassword, 10);

  const result = await UserModel.findOneAndUpdate(
    { role: 'super-admin' },
    { $set: { passwordHash: hash, loginLocked: false, status: 'active' } },
    { new: true }
  );

  if (result) {
    console.log(`\n✅ Super Admin password reset successfully!`);
    console.log(`   Email: ${result.email}`);
    console.log(`   Password: ${newPassword}`);
    console.log(`   Login lock: cleared`);
    console.log(`   Status: active\n`);
  } else {
    console.log('\n⚠️  No super-admin user found. Creating one...');
    await UserModel.create({
      name: 'Super Admin',
      email: 'super@nexus.com',
      passwordHash: hash,
      role: 'super-admin',
      branch: 'Main',
      jobTitle: 'System Administrator',
      allowedModules: ['all'],
      allowedWorkModes: ['office', 'wfh'],
      status: 'active',
      loginLocked: false,
      privacyModeEnabled: false,
      idleTrackingEnabled: true
    });
    console.log(`✅ Super Admin created!`);
    console.log(`   Email: super@nexus.com`);
    console.log(`   Password: ${newPassword}\n`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
