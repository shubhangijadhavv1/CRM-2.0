import mongoose from 'mongoose';
import { UserModel } from '../models/User.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const users = await UserModel.find({ role: { $ne: 'super-admin' } }).select('name branch branches').lean();
  console.log('Other users branches:', JSON.stringify(users, null, 2));
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
