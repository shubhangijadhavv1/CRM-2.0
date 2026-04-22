import mongoose from 'mongoose';
import { AttendanceModel } from '../models/Attendance.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const today = new Date().toISOString().split('T')[0];
  const record = await AttendanceModel.findOne({ date: today }).lean();
  console.log('Record for today:', JSON.stringify(record, null, 2));
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
