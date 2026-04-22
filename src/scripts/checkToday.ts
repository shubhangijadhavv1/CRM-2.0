import mongoose from 'mongoose';
import { AttendanceModel } from '../models/Attendance.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const today = new Date().toISOString().split('T')[0];
  const count = await AttendanceModel.countDocuments({ date: today });
  console.log('Today:', today);
  console.log('Count for today:', count);
  
  const lastRecord = await AttendanceModel.findOne().sort({ date: -1 }).lean();
  console.log('Last record date:', lastRecord?.date);

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
