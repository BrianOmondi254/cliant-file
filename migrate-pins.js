/**
 * migrate-pins.js
 * 
 * Reads all users from data.json who have a personalPin,
 * hashes any plaintext PINs with bcrypt, and saves them
 * to the matching MongoDB user record.
 * 
 * Usage: node migrate-pins.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { connectDB, getAllUsersFlattened, updateUserPassword } = require('./mongoose');

const dataFile = path.join(__dirname, 'data.json');

const migrate = async () => {
  console.log('🚀 Starting PIN migration from data.json → MongoDB...\n');

  // 1. Connect to MongoDB
  await connectDB();

  // 2. Read data.json and flatten
  const raw = fs.readFileSync(dataFile, 'utf8');
  const users = JSON.parse(raw);
  
  // 3. Filter users that have a personalPin
  const flattenUsers = (hierarchicalData) => {
    const flat = [];
    hierarchicalData.forEach(countyItem => {
      countyItem.constituencies.forEach(constituencyItem => {
        constituencyItem.wards.forEach(wardItem => {
          wardItem.data.forEach(user => {
            flat.push({ ...user, county: countyItem.county, constituency: constituencyItem.name, ward: wardItem.name });
          });
        });
      });
    });
    return flat;
  };
  
  const usersWithPin = flattenUsers(users).filter(u => u.personalPin);
  console.log(`📋 Found ${usersWithPin.length} user(s) with personalPin in data.json\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const localUser of usersWithPin) {
    const { phoneNumber, personalPin } = localUser;

    try {
      // Find user in MongoDB
      const dbUser = await getAllUsersFlattened().then(all => 
        all.find(u => u.phoneNumber === phoneNumber)
      );
      
      if (!dbUser) {
        console.log(`⚠️  ${phoneNumber} — Not found in MongoDB, skipping`);
        skipped++;
        continue;
      }

      // Check if MongoDB user already has a PIN
      if (dbUser.personalPin) {
        console.log(`⏭️  ${phoneNumber} — Already has PIN in MongoDB, skipping`);
        skipped++;
        continue;
      }

      // Hash plaintext PINs; keep already-hashed ones as-is
      let hashedPin = personalPin;
      if (!personalPin.startsWith('$2')) {
        console.log(`🔐 ${phoneNumber} — Plaintext PIN detected, hashing...`);
        hashedPin = await bcrypt.hash(personalPin, 10);
      }

      // Save to MongoDB
      await updateUserPassword(phoneNumber, hashedPin);
      console.log(`✅ ${phoneNumber} — PIN migrated to MongoDB`);
      migrated++;

    } catch (err) {
      console.error(`❌ ${phoneNumber} — Error: ${err.message}`);
      errors++;
    }
  }

  console.log('\n========== Migration Complete ==========');
  console.log(`✅ Migrated: ${migrated}`);
  console.log(`⏭️  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  console.log('========================================\n');

  process.exit(0);
};

migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});