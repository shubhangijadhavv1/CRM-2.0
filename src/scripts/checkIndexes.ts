import mongoose from 'mongoose';

const uri = 'mongodb+srv://sanket_db_user:eD9ek0VbgpY5EDfs@mygdcfeb.ofzkc9h.mongodb.net/?retryWrites=true&w=majority';

async function run() {
  await mongoose.connect(uri);
  const indexes = await mongoose.connection.db.collection('attendances').indexes();
  console.log('Indexes:', JSON.stringify(indexes, null, 2));
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
