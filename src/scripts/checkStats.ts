import mongoose from 'mongoose';
import { AttendanceModel } from '../models/Attendance.js';
import { BehaviorModel } from '../models/Behavior.js';
import { ChecklistProgressModel } from '../models/ChecklistProgress.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const attCount = await AttendanceModel.countDocuments();
  const behCount = await BehaviorModel.countDocuments();
  const checkCount = await ChecklistProgressModel.countDocuments();
  
  console.log('Attendance Count:', attCount);
  console.log('Behavior Count:', behCount);
  console.log('ChecklistProgress Count:', checkCount);

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const minDate = sixtyDaysAgo.toISOString().split('T')[0];

  const recentAtt = await AttendanceModel.countDocuments({ date: { $gte: minDate } });
  const recentBeh = await BehaviorModel.countDocuments({ date: { $gte: minDate } });

  console.log('Recent Attendance (60d):', recentAtt);
  console.log('Recent Behavior (60d):', recentBeh);

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
