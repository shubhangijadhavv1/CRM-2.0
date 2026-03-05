import './src/config/env.js';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const EMAIL = process.argv[2] || 'superadmin@local';
const NEW_PASSWORD = process.argv[3] || 'Admin@123';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const hash = await bcrypt.hash(NEW_PASSWORD, 10);
  const result = await mongoose.connection.db.collection('users').updateOne(
    { email: EMAIL },
    { $set: { passwordHash: hash, loginLocked: false } }
  );
  if (result.matchedCount === 0) {
    console.log(`No user found with email: ${EMAIL}`);
  } else {
    console.log(`Password reset for ${EMAIL}`);
    console.log(`New password: ${NEW_PASSWORD}`);
  }
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
