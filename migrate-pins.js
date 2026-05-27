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
const { connectDB, findUserByPhone, User } = require('./mongoose');

const dataFile = path.join(__dirname, 'data.json');

const norm = (p) => {
  if (!p) return '';
  let s = String(p).trim();
  if (s.startsWith('0')) s = s.substring(1);
  if (s.startsWith('+254')) s = s.substring(4);
  if (s.startsWith('254') && s.length > 9) s = s.substring(3);
  return s;
};

const migrate = async () => {
  console.log('🚀 Starting PIN migration from data.json → MongoDB...\n');

  // 1. Connect to MongoDB
  await connectDB();

  // 2. Read data.json
  const raw = fs.readFileSync(dataFile, 'utf8');
  const users = JSON.parse(raw);

  // 3. Filter users that have a personalPin
  const usersWithPin = users.filter(u => u.personalPin);
  console.log(`📋 Found ${usersWithPin.length} user(s) with personalPin in data.json\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const localUser of usersWithPin) {
    const phone = localUser.phoneNumber;
    const pin = localUser.personalPin;

    try {
      // Find user in MongoDB - try multiple phone number formats
      const normalizedPhone = norm(phone);
      let dbUser = await User.findOne({ phoneNumber: phone });
      
      if (!dbUser) {
        // Try with leading 0
        dbUser = await User.findOne({ phoneNumber: '0' + normalizedPhone });
      }
      if (!dbUser) {
        // Try with +254
        dbUser = await User.findOne({ phoneNumber: '+254' + normalizedPhone });
      }
      if (!dbUser) {
        // Try with 254
        dbUser = await User.findOne({ phoneNumber: '254' + normalizedPhone });
      }
      if (!dbUser) {
        // Try just the normalized digits
        dbUser = await User.findOne({ phoneNumber: normalizedPhone });
      }
      if (!dbUser) {
        // Try regex match on last 9 digits
        const regex = new RegExp(normalizedPhone + '$');
        dbUser = await User.findOne({ phoneNumber: regex });
      }

      if (!dbUser) {
        console.log(`⚠️  ${phone} (norm: ${normalizedPhone}) — Not found in MongoDB, skipping`);
        skipped++;
        continue;
      }

      // Check if MongoDB user already has a PIN
      if (dbUser.personalPin) {
        console.log(`⏭️  ${phone} — Already has PIN in MongoDB, skipping`);
        skipped++;
        continue;
      }

      // Hash plaintext PINs; keep already-hashed ones as-is
      let hashedPin = pin;
      if (!pin.startsWith('$2')) {
        console.log(`🔐 ${phone} — Plaintext PIN detected, hashing...`);
        hashedPin = await bcrypt.hash(pin, 10);
      }

      // Save to MongoDB
      dbUser.personalPin = hashedPin;
      await dbUser.save();
      console.log(`✅ ${phone} — PIN migrated to MongoDB`);
      migrated++;

    } catch (err) {
      console.error(`❌ ${phone} — Error: ${err.message}`);
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
