require('dotenv').config();
const mongoose = require('mongoose');

/**
 * MongoDB Connection Configuration
 * Connects to MongoDB and handles connection events
 */
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cliant-mobile';

const connectionOptions = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
};

/**
 * Ward Schema - Contains user data array matching data.json hierarchy
 */
const wardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: [{
    FirstName: { type: String, required: true },
    MiddleName: { type: String },
    LastName: { type: String, required: true },
    email: { type: String, lowercase: true, trim: true },
    phoneNumber: { type: String, required: true },
    password: { type: String, required: true },
    gender: { type: String },
    ageBracket: { type: String },
    idNumber: { type: String },
    passkey: { type: String },
    personalPin: { type: String },
    startky: { type: String },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date }
  }]
});

/**
 * Constituency Schema - Contains wards array
 */
const constituencySchema = new mongoose.Schema({
  name: { type: String, required: true },
  wards: [wardSchema]
});

/**
 * County Schema - Contains constituencies array matching data.json
 */
const countySchema = new mongoose.Schema({
  county: { type: String, required: true, unique: true },
  constituencies: [constituencySchema]
}, {
  timestamps: true
});

// Create model
const County = mongoose.model('County', countySchema);

/**
 * Connect to MongoDB database
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, connectionOptions);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    
    mongoose.connection.on('error', (err) => {
      console.error(`❌ MongoDB connection error: ${err.message}`);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB reconnected');
    });
    
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        console.log('MongoDB connection closed through app termination');
        process.exit(0);
      } catch (err) {
        console.error('Error closing MongoDB connection:', err);
        process.exit(1);
      }
    });
    
    return conn;
  } catch (error) {
    console.error(`❌ Error connecting to MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Find user by phone number in hierarchical structure
 */
const findUserByPhone = async (phoneNumber) => {
  try {
    const countyItem = await County.findOne({ 'constituencies.wards.data.phoneNumber': phoneNumber });
    if (!countyItem) return null;
    
    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const user = wardItem.data.find(u => u.phoneNumber === phoneNumber);
        if (user) {
          return { ...user.toObject(), county: countyItem.county, constituency: consItem.name, ward: wardItem.name };
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`❌ Error finding user: ${error.message}`);
    throw error;
  }
};

/**
 * Get user full name by phone from MongoDB
 */
const getUserNameByPhone = async (phoneNumber) => {
  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) return null;
    const parts = [user.FirstName, user.MiddleName, user.LastName].map(s => s && String(s).trim()).filter(Boolean);
    return parts.join(' ');
  } catch (error) {
    console.error(`❌ Error getting user name: ${error.message}`);
    return null;
  }
};

/**
 * Update user's last login time in hierarchical structure
 */
const updateLastLogin = async (phoneNumber) => {
  try {
    const countyItem = await County.findOne({ 'constituencies.wards.data.phoneNumber': phoneNumber });
    if (!countyItem) return null;
    
    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const user = wardItem.data.find(u => u.phoneNumber === phoneNumber);
        if (user) {
          user.lastLogin = new Date();
          await countyItem.save();
          return { ...user.toObject(), county: countyItem.county, constituency: consItem.name, ward: wardItem.name };
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`❌ Error updating last login: ${error.message}`);
    throw error;
  }
};

/**
 * Save user to hierarchical MongoDB structure matching data.json
 */
const saveUserToMongoDB = async (userData) => {
  try {
    const { county, constituency, ward, ...userInfo } = userData;
    
    // Find or create county
    let countyDoc = await County.findOne({ county });
    if (!countyDoc) {
      countyDoc = new County({ county, constituencies: [] });
    }
    
    // Find or create constituency
    let consIndex = countyDoc.constituencies.findIndex(c => c.name === constituency);
    if (consIndex === -1) {
      countyDoc.constituencies.push({ name: constituency, wards: [] });
      consIndex = countyDoc.constituencies.length - 1;
    }
    
    // Find or create ward
    let wardIndex = countyDoc.constituencies[consIndex].wards.findIndex(w => w.name === ward);
    if (wardIndex === -1) {
      countyDoc.constituencies[consIndex].wards.push({ name: ward, data: [] });
      wardIndex = countyDoc.constituencies[consIndex].wards.length - 1;
    }
    
    // Check for duplicate phone in this ward
    const existingUser = countyDoc.constituencies[consIndex].wards[wardIndex].data.find(
      u => u.phoneNumber === userInfo.phoneNumber
    );
    if (existingUser) {
      throw new Error('Phone number already registered');
    }
    
    // Add user to ward data
    countyDoc.constituencies[consIndex].wards[wardIndex].data.push({
      ...userInfo,
      createdAt: new Date()
    });
    
    await countyDoc.save();
    console.log(`✅ User saved to MongoDB (hierarchical): ${userInfo.phoneNumber}`);
    
    return countyDoc;
  } catch (error) {
    if (error.message === 'Phone number already registered') {
      console.error(`❌ Phone number already registered: ${userData.phoneNumber}`);
      throw error;
    }
    console.error(`❌ Error saving user to MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Flatten all users from hierarchical structure
 */
const getAllUsersFlattened = async () => {
  try {
    const counties = await County.find({});
    const users = [];
    counties.forEach(countyItem => {
      countyItem.constituencies.forEach(consItem => {
        consItem.wards.forEach(wardItem => {
          wardItem.data.forEach(user => {
            users.push({ ...user.toObject(), county: countyItem.county, constituency: consItem.name, ward: wardItem.name });
          });
        });
      });
    });
    return users;
  } catch (error) {
    console.error(`❌ Error flattening users: ${error.message}`);
    return [];
  }
};

/**
 * Update user password in hierarchical structure
 */
const updateUserPassword = async (phoneNumber, hashedPassword, isPin = false) => {
  try {
    const countyItem = await County.findOne({ 'constituencies.wards.data.phoneNumber': phoneNumber });
    if (!countyItem) return null;
    
    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const user = wardItem.data.find(u => u.phoneNumber === phoneNumber);
        if (user) {
          if (isPin) {
            user.personalPin = hashedPassword;
          } else {
            user.password = hashedPassword;
          }
          await countyItem.save();
          return { ...user.toObject(), county: countyItem.county, constituency: consItem.name, ward: wardItem.name };
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`❌ Error updating password: ${error.message}`);
    throw error;
  }
};

/**
 * Remove user from hierarchical structure by phone number
 */
const removeUserFromMongo = async (phoneNumber) => {
  try {
    const countyItem = await County.findOne({ 'constituencies.wards.data.phoneNumber': phoneNumber });
    if (!countyItem) return false;
    
    let removed = false;
    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const userIndex = wardItem.data.findIndex(u => u.phoneNumber === phoneNumber);
        if (userIndex !== -1) {
          wardItem.data.splice(userIndex, 1);
          removed = true;
        }
      }
    }
    
    if (removed) {
      await countyItem.save();
    }
    return removed;
  } catch (error) {
    console.error(`❌ Error removing user: ${error.message}`);
    throw error;
  }
};

/**
 * Flatten hierarchical data for searching (inline helper)
 */
const flattenHierarchicalUsers = (hierarchicalData) => {
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

/**
 * Migrate PINs from data.json to MongoDB
 * Usage: migratePinsFromJSON().then(() => process.exit(0))
 */
const migratePinsFromJSON = async () => {
  const fs = require('fs');
  const path = require('path');
  const bcrypt = require('bcrypt');
  
  console.log('🚀 Starting PIN migration from data.json → MongoDB...\n');
  
  const dataFile = path.join(__dirname, 'data.json');
  
  const raw = fs.readFileSync(dataFile, 'utf8');
  const users = JSON.parse(raw);
  
  const usersWithPin = flattenHierarchicalUsers(users).filter(u => u.personalPin);
  console.log(`📋 Found ${usersWithPin.length} user(s) with personalPin in data.json\n`);
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const localUser of usersWithPin) {
    const { phoneNumber, personalPin } = localUser;
    
    try {
      const dbUser = await findUserByPhone(phoneNumber);
      
      if (!dbUser) {
        console.log(`⚠️  ${phoneNumber} — Not found in MongoDB, skipping`);
        skipped++;
        continue;
      }
      
      if (dbUser.personalPin) {
        console.log(`⏭️  ${phoneNumber} — Already has PIN in MongoDB, skipping`);
        skipped++;
        continue;
      }
      
      let hashedPin = personalPin;
      if (!personalPin.startsWith('$2')) {
        console.log(`🔐 ${phoneNumber} — Plaintext PIN detected, hashing...`);
        hashedPin = await bcrypt.hash(personalPin, 10);
      }
      
      await updateUserPassword(phoneNumber, hashedPin, true); // isPin = true
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
  
  return { migrated, skipped, errors };
};

module.exports = { 
  connectDB, 
  mongoose, 
  County,
  saveUserToMongoDB,
  findUserByPhone,
  getUserNameByPhone,
  updateLastLogin,
  getAllUsersFlattened,
  updateUserPassword,
  removeUserFromMongo,
  migratePinsFromJSON,
  flattenHierarchicalUsers
};