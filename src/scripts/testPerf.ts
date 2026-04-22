import mongoose from 'mongoose';
import { AttendanceModel } from '../models/Attendance.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const minDate = sixtyDaysAgo.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  const docs = await AttendanceModel.find({ date: { $gte: minDate } }).lean();
  
  const fullJson = JSON.stringify(docs);
  console.log('Full JSON Size:', (fullJson.length / 1024 / 1024).toFixed(2), 'MB');

  const optimizedDocs = docs.map(d => {
    if (d.date === todayStr) return d;
    const { idleIntervals, sessions, breaks, ...rest } = d as any;
    return rest;
  });

  const optJson = JSON.stringify(optimizedDocs);
  console.log('Optimized JSON Size:', (optJson.length / 1024 / 1024).toFixed(2), 'MB');

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
