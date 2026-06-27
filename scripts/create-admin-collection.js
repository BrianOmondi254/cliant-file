const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.DATABASE_URL || "mongodb://localhost:27017/cliant-mobile";

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to:", mongoose.connection.host);

  const { Admin, adminConn } = require('../mongoose');

  const collections = await mongoose.connection.db.listCollections({ name: 'admins' }).toArray();
  if (collections.length > 0) {
    console.log("Collection 'admins' already exists.");
  } else {
    await mongoose.connection.createCollection('admins');
    console.log("Created collection 'admins'.");
  }

  const count = await Admin.countDocuments();
  console.log("Admin documents in collection:", count);

  await mongoose.connection.close();
  await adminConn.close();
  console.log("Done.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
