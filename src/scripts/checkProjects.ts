import mongoose from 'mongoose';
import { ProjectModel } from '../models/Project.js';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const count = await ProjectModel.countDocuments();
  console.log('Projects count:', count);
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
