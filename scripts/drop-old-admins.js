const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.DATABASE_URL || "mongodb://localhost:27017/cliant-mobile";

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to:", mongoose.connection.host);
  console.log("Current database:", mongoose.connection.db.databaseName);

  await mongoose.connection.db.collection('admins').drop();
  console.log("Dropped 'admins' collection from cliant-mobile database.");

  await mongoose.connection.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
