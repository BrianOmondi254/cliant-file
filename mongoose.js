require("dotenv").config();
const mongoose = require("mongoose");

/**
 * Read MongoDB URL from environment (Render injects these — .env is local only).
 * Supports common variable names so a typo on Render does not break deploy.
 */
const readEnvMongoUri = () => {
  const raw =
    process.env.MONGODB_URI ||
    process.env.MONGODB_URL ||
    process.env.DATABASE_URL ||
    "";
  return String(raw).trim().replace(/^["']|["']$/g, "");
};

const isRenderHost = Boolean(process.env.RENDER);
const isProduction =
  process.env.NODE_ENV === "production" || isRenderHost;
const envMongoUri = readEnvMongoUri();
const hasEnvMongoUri = Boolean(envMongoUri);
const MONGODB_URI =
  envMongoUri || "mongodb://localhost:27017/cliant-mobile";

if (isProduction && !hasEnvMongoUri) {
  console.error(
    "❌ FATAL: MongoDB URL is not set on Render.",
    "Add Environment variable: Key = MONGODB_URI, Value = your Atlas connection string",
    "(mongodb+srv://...). Copy the same value from your local .env file."
  );
} else if (isProduction && /localhost|127\.0\.0\.1/.test(MONGODB_URI)) {
  console.error(
    "❌ FATAL: Database URL points to localhost. On Render use your MongoDB Atlas connection string."
  );
}

const connectionOptions = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: isProduction ? 30000 : 15000,
  socketTimeoutMS: 45000,
};

let connectionPromise = null;

const maskMongoUri = (uri) =>
  String(uri).replace(/:([^:@/]+)@/, ":****@");

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
 * Personal Account Schema - Mirrors p_account/personal.json per-user snapshot
 */
const personalAccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  transactions: [new mongoose.Schema({
    cord: { type: String },
    reference: { type: String },
    time: { type: Date },
    openingBalance: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    type: { type: String, enum: ['received', 'sent'], default: 'received' },
    from: {
      name: { type: String },
      number: { type: String }
    },
    to: {
      name: { type: String },
      number: { type: String }
    },
    closingBalance: { type: Number, default: 0 },
    environment: { type: String, default: 'unknown' },
    notes: { type: String }
  }, { _id: false })],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const PersonalAccount = mongoose.model('PersonalAccount', personalAccountSchema);

/**
 * Connect to MongoDB database (idempotent — safe to call multiple times)
 */
const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      console.log(`🔌 MongoDB connecting to ${maskMongoUri(MONGODB_URI)} ...`);
      const conn = await mongoose.connect(MONGODB_URI, connectionOptions);
      console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

      mongoose.connection.on("error", (err) => {
        console.error(`❌ MongoDB connection error: ${err.message}`);
      });

      mongoose.connection.on("disconnected", () => {
        console.warn("⚠️  MongoDB disconnected");
        connectionPromise = null;
      });

      mongoose.connection.on("reconnected", () => {
        console.log("🔄 MongoDB reconnected");
      });

      if (!process.listenerCount("SIGINT")) {
        process.on("SIGINT", async () => {
          try {
            await mongoose.connection.close();
            console.log("MongoDB connection closed through app termination");
            process.exit(0);
          } catch (err) {
            console.error("Error closing MongoDB connection:", err);
            process.exit(1);
          }
        });
      }

      return conn;
    } catch (error) {
      connectionPromise = null;
      console.error(`❌ Error connecting to MongoDB: ${error.message}`);
      throw error;
    }
  })();

  return connectionPromise;
};

/**
 * Wait for an active MongoDB connection (reconnects if needed)
 */
const ensureMongoReady = async () => {
  if (mongoose.connection.readyState === 1) {
    return true;
  }
  if (isProduction && !hasEnvMongoUri) {
    return false;
  }
  try {
    await connectDB();
    return mongoose.connection.readyState === 1;
  } catch (error) {
    console.error(`❌ ensureMongoReady failed: ${error.message}`);
    if (/whitelist|IP|timed out|ECONNREFUSED|ENOTFOUND/i.test(error.message)) {
      console.error(
        "   Tip: In MongoDB Atlas → Network Access, allow 0.0.0.0/0 so Render can connect."
      );
    }
    return false;
  }
};

const getMongoConfigHint = () => {
  if (!hasEnvMongoUri) {
    return "Database URL is not set on Render. Add Environment variable MONGODB_URI with your Atlas connection string (mongodb+srv://...), then redeploy.";
  }
  if (isProduction && /localhost|127\.0\.0\.1/.test(MONGODB_URI)) {
    return "Server is configured with a local database URL, which does not work on Render.";
  }
  return "Could not reach the database. In Atlas → Network Access, allow 0.0.0.0/0, then redeploy.";
};

const normalizePhone = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

const phoneMatches = (a, b) => normalizePhone(a) === normalizePhone(b);

/**
 * Flatten all users from counties collection (+ legacy users collection)
 */
const getAllUsersFlattened = async () => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      throw new Error("MongoDB not connected");
    }
    const counties = await County.find({}).lean();
    const users = [];
    const seen = new Set();

    for (const countyItem of counties) {
      for (const consItem of countyItem.constituencies || []) {
        for (const wardItem of consItem.wards || []) {
          for (const user of wardItem.data || []) {
            const key = normalizePhone(user.phoneNumber);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            users.push({
              ...user,
              county: countyItem.county,
              constituency: consItem.name,
              ward: wardItem.name,
            });
          }
        }
      }
    }

    const db = mongoose.connection.db;
    if (db) {
      const legacyUsers = await db.collection("users").find({}).toArray();
      for (const user of legacyUsers) {
        const key = normalizePhone(user.phoneNumber);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        users.push(user);
      }
    }

    return users;
  } catch (error) {
    console.error(`❌ Error flattening users: ${error.message}`);
    return [];
  }
};

/**
 * Find user by phone in counties collection (normalized match)
 */
const findUserInCounties = async (phoneNumber) => {
  const target = normalizePhone(phoneNumber);
  if (!target) return null;

  const counties = await County.find({}).lean();
  for (const countyItem of counties) {
    for (const consItem of countyItem.constituencies || []) {
      for (const wardItem of consItem.wards || []) {
        for (const user of wardItem.data || []) {
          if (normalizePhone(user.phoneNumber) === target) {
            return {
              ...user,
              county: countyItem.county,
              constituency: consItem.name,
              ward: wardItem.name,
            };
          }
        }
      }
    }
  }
  return null;
};

/**
 * Find user by phone number in MongoDB (counties + legacy users collection)
 */
const findUserByPhone = async (phoneNumber) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      throw new Error("MongoDB not connected");
    }

    let user = await findUserInCounties(phoneNumber);
    if (user) return user;

    const target = normalizePhone(phoneNumber);
    if (!target) return null;

    const db = mongoose.connection.db;
    if (db) {
      const legacy = await db.collection("users").find({}).toArray();
      user = legacy.find((u) => normalizePhone(u.phoneNumber) === target) || null;
    }
    return user;
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
    const target = normalizePhone(phoneNumber);
    if (!target) return null;

    const allCounties = await County.find({});
    for (const doc of allCounties) {
      for (const consItem of doc.constituencies || []) {
        for (const wardItem of consItem.wards || []) {
          const user = (wardItem.data || []).find((u) => normalizePhone(u.phoneNumber) === target);
          if (user) {
            user.lastLogin = new Date();
            await doc.save();
            return {
              ...user.toObject(),
              county: doc.county,
              constituency: consItem.name,
              ward: wardItem.name,
            };
          }
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
      (u) => phoneMatches(u.phoneNumber, userInfo.phoneNumber)
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
  
  const dataFile = path.join(__dirname, 'data/data.json');
  
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
  ensureMongoReady,
  mongoose, 
  County,
  PersonalAccount,
  saveUserToMongoDB,
  findUserByPhone,
  getUserNameByPhone,
  updateLastLogin,
  getAllUsersFlattened,
  updateUserPassword,
  removeUserFromMongo,
  migratePinsFromJSON,
  flattenHierarchicalUsers,
  normalizePhone,
  phoneMatches,
};