import '../config/env.js';
import { connectMongo } from '../config/db.js';
import { UserModel } from '../models/User.js';
import { TaskModel } from '../models/Task.js';
import { ProjectModel } from '../models/Project.js';
import { AttendanceModel } from '../models/Attendance.js';
import { LeaveModel } from '../models/Leave.js';
import { NoticeModel } from '../models/Notice.js';
import { BehaviorModel } from '../models/Behavior.js';
import { BranchConfigModel } from '../models/BranchConfig.js';
import { ProjectConfigModel } from '../models/ProjectConfig.js';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');

  await connectMongo(mongoUri);

  // Delete EVERYTHING (demo/prototype data). We will recreate an initial super-admin on next server start.
  await Promise.all([
    TaskModel.deleteMany({}),
    ProjectModel.deleteMany({}),
    AttendanceModel.deleteMany({}),
    LeaveModel.deleteMany({}),
    NoticeModel.deleteMany({}),
    BehaviorModel.deleteMany({}),
    BranchConfigModel.deleteMany({}),
    ProjectConfigModel.deleteMany({}),
    UserModel.deleteMany({})
  ]);

  // eslint-disable-next-line no-console
  console.log('Purged all application collections.');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

