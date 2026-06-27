const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.DATABASE_URL || "mongodb://localhost:27017/cliant-mobile";

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to:", mongoose.connection.host);

  const { SuperAdmin, adminConn } = require('../mongoose');

  const collections = await mongoose.connection.db.listCollections({ name: 'superAdmins' }).toArray();
  if (collections.length > 0) {
    console.log("Collection 'superAdmins' already exists.");
  } else {
    await mongoose.connection.createCollection('superAdmins');
    console.log("Created collection 'superAdmins'.");
  }

  const count = await SuperAdmin.countDocuments();
  console.log("SuperAdmin documents in collection:", count);

  await mongoose.connection.close();
  await adminConn.close();
  console.log("Done.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
