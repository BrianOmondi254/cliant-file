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
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "");
};

const isRenderHost = Boolean(process.env.RENDER);
const isProduction = process.env.NODE_ENV === "production" || isRenderHost;
const envMongoUri = readEnvMongoUri();
const hasEnvMongoUri = Boolean(envMongoUri);
const MONGODB_URI = envMongoUri || "mongodb://localhost:27017/cliant-mobile";

if (isProduction && !hasEnvMongoUri) {
  console.error(
    "❌ FATAL: MongoDB URL is not set on Render.",
    "Add Environment variable: Key = MONGODB_URI, Value = your Atlas connection string",
    "(mongodb+srv://...). Copy the same value from your local .env file.",
  );
} else if (isProduction && /localhost|127\.0\.0\.1/.test(MONGODB_URI)) {
  console.error(
    "❌ FATAL: Database URL points to localhost. On Render use your MongoDB Atlas connection string.",
  );
}

const connectionOptions = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: isProduction ? 30000 : 15000,
  socketTimeoutMS: 45000,
};

let connectionPromise = null;

const maskMongoUri = (uri) => String(uri).replace(/:([^:@/]+)@/, ":****@");

/**
 * Ward Schema - Contains user data array matching data.json hierarchy
 */
const wardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: [
    {
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
      lastLogin: { type: Date },
    },
  ],
});

/**
 * Constituency Schema - Contains wards array
 */
const constituencySchema = new mongoose.Schema({
  name: { type: String, required: true },
  wards: [wardSchema],
});

/**
 * County Schema - Contains constituencies array matching data.json
 */
const countySchema = new mongoose.Schema(
  {
    county: { type: String, required: true, unique: true },
    constituencies: [constituencySchema],
  },
  {
    timestamps: true,
  },
);

// Create model (guarded against OverwriteModelError on hot-reload / repeated requires)
const County = mongoose.models.County || mongoose.model("County", countySchema);

/**
 * Transaction History Schema for accounts
 */
const transactionHistorySchema = new mongoose.Schema(
  {
    date: { type: String },
    type: { type: String },
    amount: { type: Number },
    balance: { type: Number },
    note: { type: String },
    state: { type: String },
    description: { type: String },
    transactionId: { type: String },
    transactionNumber: { type: Number },
    targetAccount: { type: String },
    totalDeductions: { type: Number },
    totalPendingDeductions: { type: Number },
    round: { type: Number },
    createdAt: { type: String },
    contributingMembers: [{ type: String }],
    scheduledDate: { type: String },
    status: { type: String },
  },
  { _id: false },
);

/**
 * Account Schema within a member
 */
const accountSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    accountName: { type: String },
    expectedAmount: { type: String },
    financials: {
      openingBalance: { type: Number, default: 0 },
      amountIn: { type: Number, default: 0 },
      amountOut: { type: Number, default: 0 },
      closingBalance: { type: Number, default: 0 },
    },
    transactionHistory: [transactionHistorySchema],
    dateIntervalCycle: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false },
);

/**
 * Member Schema within a group
 */
const memberSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true },
    name: { type: String },
    role: { type: String, default: "member" },
    idNumber: { type: String },
    memberFinancials: {
      openingBalance: { type: Number, default: 0 },
      amountIn: { type: Number, default: 0 },
      amountOut: { type: Number, default: 0 },
      closingBalance: { type: Number, default: 0 },
    },
    accounts: { type: Map, of: accountSchema, default: {} },
    processedDeductions: [{ type: mongoose.Schema.Types.Mixed }],
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { _id: false },
);

/**
 * Group Financials Schema
 */
const groupFinancialsSchema = new mongoose.Schema(
  {
    totalOpeningBalance: { type: Number, default: 0 },
    totalAmountIn: { type: Number, default: 0 },
    totalAmountOut: { type: Number, default: 0 },
    totalClosingBalance: { type: Number, default: 0 },
    availableWithdrawalBalance: { type: Number, default: 0 },
  },
  { _id: false },
);

/**
 * Member Group Schema — mirrors member.json groups structure
 */
const memberGroupSchema = new mongoose.Schema(
  {
    groupKey: { type: String, required: true, unique: true, sparse: true },
    groupNumber: { type: Number },
    groupName: { type: String, required: true },
    groupFinancials: { type: groupFinancialsSchema },
    accountSchema: {
      type: Map,
      of: {
        accountId: { type: String },
        accountName: { type: String },
        expectedAmount: { type: String },
      },
    },
    otherContributions: {
      type: Map,
      of: {
        accountNumber: { type: String },
        transactions: [{ type: mongoose.Schema.Types.Mixed }],
      },
    },
    members: { type: Map, of: memberSchema, default: {} },
    principles: { type: mongoose.Schema.Types.Mixed },
    constitutionStartKey: { type: String },
    constitutionKeyGeneratedAt: { type: String },
    constitutionKeySetByAgentAt: { type: String },
    principlesSetAt: { type: String },
    createdAt: { type: String, default: () => new Date().toISOString() },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  { timestamps: true },
);

const MemberGroup =
  mongoose.models.MemberGroup ||
  mongoose.model("MemberGroup", memberGroupSchema, "groups");

/**
 * Tbank Settings Schema - Compliance configuration
 */
const tbankSettingsSchema = new mongoose.Schema(
  {
    compliance: {
      registration: {
        newGroupFee: { type: String, default: "50" },
        renewalFee: { type: String, default: "50" },
        updatedAt: { type: String, default: () => new Date().toISOString() },
      },
      membership: {
        trustees: { type: String, default: "1" },
        officials: { type: String, default: "1" },
        members: { type: String, default: "3" },
        maxMembers: { type: String, default: "40" },
        updatedAt: { type: String, default: () => new Date().toISOString() },
      },
      periods: {
        interval: { type: String, default: "Weekly" },
        season: { type: String, default: "Annual" },
        updatedAt: { type: String },
      },
      completed: { type: Boolean, default: true },
      personal_account_registration: {
        amount: { type: String, default: "50" },
        paymentMethod: { type: String, default: "mpesa" },
        passkey: { type: String },
        updatedAt: { type: String },
      },
    },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  { _id: false },
);

const TbankSettings =
  mongoose.models.TbankSettings ||
  mongoose.model("TbankSettings", tbankSettingsSchema, "tbank");

/**
 * Message Schema - For storing group notifications and constitution keys
 */
const messageSchema = new mongoose.Schema(
  {
    groupName: { type: String, required: true, index: true },
    to: { type: String, required: true, index: true },
    type: { type: String, default: "general" },
    title: { type: String },
    content: { type: String },
    key: { type: String },
    broadcast: { type: Boolean, default: false },
    roles: [{ type: String }],
    meta: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, default: "pending" },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { timestamps: true },
);

const Message =
  mongoose.models.Message ||
  mongoose.model("Message", messageSchema, "messages");

/**
 * Save message to MongoDB
 */
const saveMessageToMongo = async (message) => {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await Message.create(message);
    return true;
  } catch (e) {
    console.error("[messages] saveMessageToMongo error:", e.message);
    return false;
  }
};

/**
 * Get messages for a user by phone number
 */
const getMessagesForUser = async (phone) => {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const msgs = await Message.find({ to: phone })
      .sort({ createdAt: -1 })
      .lean();
    return msgs;
  } catch (e) {
    console.error("[messages] getMessagesForUser error:", e.message);
    return [];
  }
};

const PendingOfficerMessageSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    dept: { type: String, default: "" },
    passkey: { type: String, default: "" },
    processorName: { type: String, default: "" },
    processorPhone: { type: String, default: "" },
    timestamp: { type: Number, required: true },
  },
  { timestamps: true },
);

const PendingOfficerMessage =
  mongoose.models.PendingOfficerMessage ||
  mongoose.model(
    "PendingOfficerMessage",
    PendingOfficerMessageSchema,
    "pendingOfficerMessages",
  );

const savePendingOfficerMessage = async ({
  phone,
  name,
  dept,
  passkey,
  processorName,
  processorPhone,
  timestamp,
}) => {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const result = await PendingOfficerMessage.updateOne(
      { phone: normalizePhone(phone) },
      {
        $set: {
          name,
          dept,
          passkey: passkey || "",
          processorName: processorName || "",
          processorPhone: processorPhone || "",
          timestamp: timestamp || Date.now(),
        },
      },
      { upsert: true },
    );
    return { ...result, nModified: result.nModified || 1 };
  } catch (e) {
    console.error("[messages] savePendingOfficerMessage error:", e.message);
    return null;
  }
};

const getPendingOfficerMessageByPhone = async (phone) => {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const normalised = normalizePhone(phone);
    const msg = await PendingOfficerMessage.findOne({
      $or: [{ phone: normalised }, { processorPhone: normalised }],
    }).lean();
    return msg;
  } catch (e) {
    console.error(
      "[messages] getPendingOfficerMessageByPhone error:",
      e.message,
    );
    return null;
  }
};

const deletePendingOfficerMessage = async (phone) => {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    const normalised = normalizePhone(phone);
    await PendingOfficerMessage.deleteOne({
      $or: [{ phone: normalised }, { processorPhone: normalised }],
    });
    return true;
  } catch (e) {
    console.error("[messages] deletePendingOfficerMessage error:", e.message);
    return false;
  }
};

/**
 * Save tbank settings to MongoDB
 */
const saveTbankSettings = async (settings) => {
  if (mongoose.connection.readyState !== 1) return false;
  const db = mongoose.connection.db;
  if (!db) return false;

  try {
    await db
      .collection("tbank")
      .updateOne(
        {},
        { $set: { ...settings, updatedAt: new Date().toISOString() } },
        { upsert: true },
      );
    return true;
  } catch (e) {
    console.error("[tbank] saveTbankSettings error:", e.message);
    return false;
  }
};

/**
 * Get tbank settings from MongoDB
 */
const getTbankSettings = async () => {
  if (mongoose.connection.readyState !== 1) return null;
  const db = mongoose.connection.db;
  if (!db) return null;

  try {
    const settings = await db.collection("tbank").findOne({});
    return settings;
  } catch (e) {
    console.error("[tbank] getTbankSettings error:", e.message);
    return null;
  }
};

/**
 * GROUP CRUD - Find or create group document for member data
 */
const findOrCreateMemberGroup = async (groupName, groupNumber) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  let groupKey = String(groupName || "").trim();
  if (!groupKey) {
    const total = await MemberGroup.countDocuments();
    groupKey = "group_" + (total + 1);
  }

  let doc = await MemberGroup.findOne({ groupKey });
  if (!doc) {
    doc = new MemberGroup({
      groupKey,
      groupNumber: groupNumber || 0,
      groupName,
      members: {},
      accountSchema: {},
      otherContributions: {},
      principles: {},
      groupFinancials: {},
    });
    await doc.save();
  }
  return doc;
};

const normalizeGroupName = (groupName) =>
  String(groupName || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const escapeGroupNameRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const flattenMongoCountyDoc = (doc) => {
  const flat = [];
  if (!doc) return flat;

  // Handle flat group documents (groupKey at top level, no nested arrays)
  const hasNestedArrays = Object.keys(doc).some(
    (k) => k !== "_id" && k !== "county" && Array.isArray(doc[k]),
  );
  if (!hasNestedArrays && doc.groupName) {
    flat.push({
      ...doc,
      county: doc.county || "Unknown",
      constituency: doc.constituency || "Unknown",
      ward: doc.ward || "Unknown Ward",
    });
    return flat;
  }

  // Handle county documents with nested constituency/ward arrays
  const county = doc.county;
  for (const key in doc) {
    if (key === "_id" || key === "county") continue;
    const items = doc[key];
    if (!Array.isArray(items)) continue;
    let currentWard = "Unknown Ward";
    items.forEach((item) => {
      if (typeof item === "string") {
        currentWard = item;
      } else if (item && typeof item === "object") {
        flat.push({ ...item, county, constituency: key, ward: currentWard });
      }
    });
  }
  return flat;
};

const saveGeneralGroupToMongo = async (groupData) => {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[GeneralGroup] MongoDB not connected, skipping DB sync");
    return null;
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.warn(
      "[GeneralGroup] MongoDB database unavailable, skipping DB sync",
    );
    return null;
  }

  const { county, constituency, ward, ...accountFields } = groupData;
  const groupName = accountFields.groupName;
  const normalizedGroupName = groupName ? String(groupName).trim() : "";

  if (!normalizedGroupName) {
    console.warn(
      "[GeneralGroup] groupName is missing/empty, skipping MongoDB sync",
      {
        county,
        constituency,
        ward,
        receivedGroupName: groupName,
      },
    );
    return null;
  }

  if (!county || !constituency || !ward) {
    console.warn(
      "[GeneralGroup] county, constituency, ward and groupName are required for MongoDB sync",
    );
    return null;
  }

  const col = db.collection("groups");
  const now = new Date().toISOString();

  try {
    // Fix non-sparse groupKey index if it exists (prevents E11000 on county docs without groupKey)
    try {
      const indexes = await col.listIndexes().toArray();
      const idx = indexes.find((i) => i.name === "groupKey_1");
      if (idx && !idx.sparse) {
        await col.dropIndex("groupKey_1");
        await col.createIndex(
          { groupKey: 1 },
          { unique: true, sparse: true, name: "groupKey_1", background: true },
        );
        console.log("[GeneralGroup] Recreated groupKey_1 as sparse index");
      }
    } catch (idxErr) {
      // Index might not exist or other error — continue
    }

    // Build the group object (no groupKey on nested objects — county docs don't need it)
    const accountToSave = {
      ...accountFields,
      updatedAt: now,
      syncedAt: now,
      source: "general",
    };

    let countyDoc = await col.findOne({ county });

    if (!countyDoc) {
      const newDoc = { county };
      newDoc[constituency] = [ward, accountToSave];
      const insertResult = await col.insertOne(newDoc);
      console.log(
        `[GeneralGroup] Created county doc for ${county} & inserted group: ${groupName}`,
      );
      return insertResult;
    }

    const constituencyArray = Array.isArray(countyDoc[constituency])
      ? [...countyDoc[constituency]]
      : [];

    const existingIdx = constituencyArray.findIndex(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        item.groupName === groupName,
    );

    if (existingIdx !== -1) {
      constituencyArray[existingIdx] = {
        ...constituencyArray[existingIdx],
        ...accountToSave,
      };
    } else {
      let wardIndex = constituencyArray.findIndex(
        (item) =>
          typeof item === "string" && item.toLowerCase() === ward.toLowerCase(),
      );

      if (wardIndex === -1) {
        constituencyArray.push(ward, accountToSave);
      } else {
        let insertIndex = wardIndex + 1;
        while (
          insertIndex < constituencyArray.length &&
          typeof constituencyArray[insertIndex] === "object"
        ) {
          insertIndex++;
        }
        constituencyArray.splice(insertIndex, 0, accountToSave);
      }
    }

    const result = await col.updateOne(
      { county },
      { $set: { [constituency]: constituencyArray } },
    );

    console.log(
      `[GeneralGroup] Synced group into MongoDB 'groups' (county doc): ${groupName}`,
    );
    return result;
  } catch (err) {
    console.error("[GeneralGroup] MongoDB sync error:", err.message);
    return null;
  }
};

const deleteGeneralGroupFromMongo = async (groupName) => {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[GeneralGroup] MongoDB not connected, cannot delete");
    return false;
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.warn("[GeneralGroup] MongoDB database unavailable, cannot delete");
    return false;
  }

  const col = db.collection("groups");
  const target = String(groupName || "")
    .trim()
    .toLowerCase();
  if (!target) return false;

  try {
    const countyDocs = await col.find({}).toArray();
    for (const doc of countyDocs) {
      for (const key in doc) {
        if (key === "_id" || key === "county") continue;
        const items = doc[key];
        if (!Array.isArray(items)) continue;

        const idx = items.findIndex(
          (item) =>
            item &&
            typeof item === "object" &&
            item.groupName &&
            String(item.groupName).trim().toLowerCase() === target,
        );

        if (idx !== -1) {
          items.splice(idx, 1);
          await col.updateOne(
            { county: doc.county },
            { $set: { [key]: items } },
          );
          console.log(
            `[GeneralGroup] Deleted group '${groupName}' from MongoDB 'groups'`,
          );
          return true;
        }
      }
    }

    console.warn(
      `[GeneralGroup] Group '${groupName}' not found in MongoDB for deletion`,
    );
    return false;
  } catch (err) {
    console.error("[GeneralGroup] MongoDB delete error:", err.message);
    return false;
  }
};

/**
 * Clean up existing documents with null/empty groupKey in the groups collection
 * This fixes the E11000 duplicate key error when sparse index wasn't properly applied
 */
const cleanupNullGroupKeys = async (col) => {
  try {
    // Find documents with null or empty groupKey
    const nullGroups = await col
      .find({
        $or: [{ groupKey: { $type: "null" } }, { groupKey: "" }],
      })
      .toArray();
    let cleanedCount = 0;

    for (const doc of nullGroups) {
      // Delete these problematic documents
      await col.deleteOne({ _id: doc._id });
      cleanedCount++;
      console.log(
        `[GeneralGroup] Removed document with null/empty groupKey, _id: ${doc._id}`,
      );
    }

    return cleanedCount;
  } catch (err) {
    console.error("[GeneralGroup] Error during cleanup:", err.message);
    return 0;
  }
};

/**
 * Drop and recreate the groupKey index with sparse:true to allow multiple null values
 * Run this if the duplicate key error persists after cleanup
 */
const fixGroupKeyIndex = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.warn("[GeneralGroup] MongoDB not connected, cannot fix index");
      return false;
    }

    const db = mongoose.connection.db;
    const col = db.collection("groups");

    // Drop existing groupKey index (named groupKey_1)
    try {
      await col.dropIndex("groupKey_1");
      console.log("[GeneralGroup] Dropped existing groupKey_1 index");
    } catch (dropErr) {
      console.log(
        "[GeneralGroup] Could not drop index (may not exist):",
        dropErr.message,
      );
    }

    // Recreate index with sparse:true using the collection's createIndexes method
    await col.createIndex(
      { groupKey: 1 },
      {
        unique: true,
        sparse: true,
        name: "groupKey_1",
        background: true,
      },
    );
    console.log("[GeneralGroup] Created new sparse unique index on groupKey");

    return true;
  } catch (err) {
    console.error("[GeneralGroup] Error fixing index:", err.message);
    return false;
  }
};

/**
 * Public function to clean up null groupKeys - can be called on startup or via endpoint
 */
const cleanupStaleGroupKeys = async () => {
  if (mongoose.connection.readyState !== 1) return 0;
  const db = mongoose.connection.db;
  if (!db) return 0;
  const col = db.collection("groups");
  return cleanupNullGroupKeys(col);
};

const getGeneralGroupsFromMongo = async () => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB database unavailable");

  const countyDocs = await db.collection("groups").find({}).toArray();
  return countyDocs.flatMap(flattenMongoCountyDoc);
};

const findGeneralGroupsByMemberPhone = async (phone) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB database unavailable");

  const normalized = normalizePhone(phone);
  const countyDocs = await db.collection("groups").find({}).toArray();
  const allGroups = countyDocs.flatMap(flattenMongoCountyDoc);

  return allGroups.filter((group) => {
    if (normalizePhone(group.phone) === normalized) return true;
    for (const key in group) {
      if (
        key.startsWith("trustee_") ||
        key.startsWith("official_") ||
        key.startsWith("member_")
      ) {
        const m = group[key];
        if (m && m.phone && normalizePhone(m.phone) === normalized) return true;
      }
    }
    return false;
  });
};

const findGroupNameInMongoGroupsCollection = async (groupName) => {
  if (mongoose.connection.readyState !== 1) return null;

  const db = mongoose.connection.db;
  if (!db) return null;

  const target = normalizeGroupName(groupName);
  if (!target) return null;

  try {
    const countyDocs = await db
      .collection("groups")
      .find({}, { maxTimeMS: 3000 })
      .toArray();
    for (const doc of countyDocs) {
      const groups = flattenMongoCountyDoc(doc);
      for (const group of groups) {
        const flatName = normalizeGroupName(group.groupName);
        const flatKey = normalizeGroupName(group.groupKey);
        if (flatName === target || flatKey === target) {
          return {
            group,
            county: group.county,
            constituency: group.constituency,
            ward: group.ward,
            source: "groups.county-doc",
          };
        }
      }
    }
  } catch (err) {
    console.error("[findGroupNameInMongoGroupsCollection]", err.message);
  }
  return null;
};

const findGroupNameInGroupsMembersCollection = async (groupName) => {
  if (mongoose.connection.readyState !== 1) return null;

  const db = mongoose.connection.db;
  if (!db) return null;

  const target = normalizeGroupName(groupName);
  if (!target) return null;

  try {
    const docs = await db
      .collection("groups-members")
      .find({}, { maxTimeMS: 3000 })
      .toArray();
    for (const doc of docs) {
      if (!doc || !Array.isArray(doc.constituencies)) continue;
      for (const constituency of doc.constituencies) {
        if (!constituency || !Array.isArray(constituency.wards)) continue;
        for (const ward of constituency.wards) {
          if (!ward || !Array.isArray(ward.data)) continue;
          for (const group of ward.data) {
            const flatName = normalizeGroupName(group.groupName);
            const flatId = normalizeGroupName(group.groupId);
            if (!group || (flatName !== target && flatId !== target)) continue;
            return {
              group,
              county: group.county || doc.county,
              constituency: group.constituency || constituency.name,
              ward: group.ward || ward.name,
              source: "groups-members.regional",
            };
          }
        }
      }
    }
  } catch (err) {
    console.error("[findGroupNameInGroupsMembersCollection]", err.message);
  }
  return null;
};

const isGroupNameAvailableInMongo = async (groupName) => {
  if (mongoose.connection.readyState !== 1) {
    return {
      available: true,
      exists: false,
      unavailable: true,
      message: "MongoDB is not available",
    };
  }

  const name = normalizeGroupName(groupName);
  if (!name)
    return {
      available: false,
      exists: false,
      message: "Group name is required",
    };

  const groupsCollectionMatch =
    await findGroupNameInMongoGroupsCollection(groupName);
  if (groupsCollectionMatch) {
    return {
      available: false,
      exists: true,
      source: groupsCollectionMatch.source,
      message: "Group name exists",
    };
  }

  const groupsMembersMatch =
    await findGroupNameInGroupsMembersCollection(groupName);
  if (groupsMembersMatch) {
    return {
      available: false,
      exists: true,
      source: groupsMembersMatch.source,
      message: "Group name exists",
    };
  }

  return {
    available: true,
    exists: false,
    source: "mongo",
    message: "Group name is available",
  };
};

/**
 * Save full group member data to MongoDB
 */
const saveMemberGroupToMongo = async (groupData) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const groupName = groupData.groupName;
  if (!groupName) throw new Error("groupName is required");

  let groupKey = String(groupName).trim();
  let existing = await MemberGroup.findOne({ groupKey });
  if (!existing) {
    existing = new MemberGroup({
      groupKey,
      groupName,
      groupNumber: groupData.groupNumber || 0,
      groupFinancials: groupData.groupFinancials || {},
      accountSchema: groupData.accountSchema || {},
      otherContributions: groupData.otherContributions || {},
      members: {},
      principles: groupData.principles || {},
      constitutionStartKey: groupData.constitutionStartKey || "",
      constitutionKeyGeneratedAt: groupData.constitutionKeyGeneratedAt || "",
      constitutionKeySetByAgentAt: groupData.constitutionKeySetByAgentAt || "",
      principlesSetAt: groupData.principlesSetAt || "",
    });
  } else {
    existing.groupNumber = groupData.groupNumber || existing.groupNumber;
    existing.groupFinancials =
      groupData.groupFinancials || existing.groupFinancials;
    existing.accountSchema = groupData.accountSchema || existing.accountSchema;
    existing.otherContributions =
      groupData.otherContributions || existing.otherContributions;
    existing.principles = groupData.principles || existing.principles;
    existing.constitutionStartKey =
      groupData.constitutionStartKey || existing.constitutionStartKey;
    existing.constitutionKeyGeneratedAt =
      groupData.constitutionKeyGeneratedAt ||
      existing.constitutionKeyGeneratedAt;
    existing.constitutionKeySetByAgentAt =
      groupData.constitutionKeySetByAgentAt ||
      existing.constitutionKeySetByAgentAt;
    existing.principlesSetAt =
      groupData.principlesSetAt || existing.principlesSetAt;
    existing.updatedAt = new Date().toISOString();
  }

  if (groupData.members) {
    for (const [memberId, member] of Object.entries(groupData.members)) {
      existing.members.set(memberId, member);
    }
  }

  await existing.save();
  return existing;
};

/**
 * Add a member to a group in MongoDB
 */
const addMemberToMemberGroup = async (groupName, memberData) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const groupKey = String(groupName).trim();
  let doc = await MemberGroup.findOne({ groupKey });
  if (!doc) {
    doc = new MemberGroup({
      groupKey,
      groupName,
      groupNumber: 0,
      members: {},
    });
  }

  const memberId = memberData.memberId || "";
  if (!memberId) throw new Error("memberId is required");

  doc.members.set(memberId, memberData);
  doc.updatedAt = new Date().toISOString();
  await doc.save();
  return doc;
};

/**
 * Update a member's account in a group
 */
const updateMemberAccountInMongo = async (
  groupName,
  memberId,
  accountNumber,
  transactionData,
) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const groupKey = String(groupName).trim();
  const doc = await MemberGroup.findOne({ groupKey });
  if (!doc) throw new Error("Group not found");

  const member = doc.members.get(memberId);
  if (!member) throw new Error("Member not found");

  if (!member.accounts) member.accounts = {};
  const account = member.accounts.get(accountNumber) || {
    accountId: accountNumber,
    accountName: "",
    financials: {
      openingBalance: 0,
      amountIn: 0,
      amountOut: 0,
      closingBalance: 0,
    },
    transactionHistory: [],
  };

  account.transactionHistory = transactionData;
  member.accounts.set(accountNumber, account);
  doc.updatedAt = new Date().toISOString();
  await doc.save();
  return doc;
};

/**
 * Get full member group data from MongoDB
 */
const getMemberGroupFromMongo = async (groupName) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const groupKey = String(groupName).trim();
  const doc = await MemberGroup.findOne({ groupKey }).lean();
  if (!doc) return null;

  const membersObj = {};
  if (doc.members) {
    doc.members.forEach((value, key) => {
      membersObj[key] = value;
    });
    doc.members = membersObj;
  }

  const accountSchemaObj = {};
  if (doc.accountSchema) {
    doc.accountSchema.forEach((value, key) => {
      accountSchemaObj[key] = value;
    });
    doc.accountSchema = accountSchemaObj;
  }

  const otherContributionsObj = {};
  if (doc.otherContributions) {
    doc.otherContributions.forEach((value, key) => {
      otherContributionsObj[key] = value;
    });
    doc.otherContributions = otherContributionsObj;
  }

  return doc;
};

/**
 * Save top-level member.json structure (group key wrapper)
 */
const saveMemberDataToMongo = async (memberData) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  if (memberData.group) {
    for (const [key, group] of Object.entries(memberData.group)) {
      await saveMemberGroupToMongo({
        ...group,
        groupName: group.groupName || key,
      });
    }
    return true;
  }

  if (memberData.groups) {
    for (const [key, group] of Object.entries(memberData.groups)) {
      await saveMemberGroupToMongo({
        ...group,
        groupName: group.groupName || key,
      });
    }
    return true;
  }

  return false;
};

/**
 * Personal Account Schema - Mirrors p_account/personal.json per-user snapshot
 */
const personalAccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  transactions: [
    new mongoose.Schema(
      {
        cord: { type: String },
        reference: { type: String },
        time: { type: Date },
        openingBalance: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
        type: { type: String, enum: ["received", "sent"], default: "received" },
        from: {
          name: { type: String },
          number: { type: String },
        },
        to: {
          name: { type: String },
          number: { type: String },
        },
        closingBalance: { type: Number, default: 0 },
        environment: { type: String, default: "unknown" },
        notes: { type: String },
      },
      { _id: false },
    ),
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const PersonalAccount =
  mongoose.models.PersonalAccount ||
  mongoose.model("PersonalAccount", personalAccountSchema);

/**
 * Agent Schema - Mirrors agent.json structure
 */
const agentSchema = new mongoose.Schema({
  name: { type: String },
  phoneNumber: { type: String, required: true, unique: true },
  dealerPhone: { type: String },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
  isBlocked: { type: Boolean, default: false },
  passkey: { type: String },
  createdAt: { type: Date, default: Date.now },
  groupsTotal: [{ type: mongoose.Schema.Types.Mixed }],
  totalMembers: { type: Number, default: 0 },
  members: { type: mongoose.Schema.Types.Mixed },
  group: { type: mongoose.Schema.Types.Mixed },
});

const Agent =
  mongoose.models.Agent || mongoose.model("Agent", agentSchema, "agents");

/**
 * Dealer Schema - Mirrors dealer.json structure
 */
const dealerSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  hqPhone: { type: String },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
  name: { type: String },
  isBlocked: { type: Boolean, default: false },
  pin: { type: String },
  passkey: { type: String },
  createdAt: { type: Date, default: Date.now },
  stats: {
    agent_creation: { type: Number, default: 0 },
    personal_account_creation: { type: Number, default: 0 },
    dealer_creation: { type: Number, default: 0 },
  },
});

const Dealer =
  mongoose.models.Dealer || mongoose.model("Dealer", dealerSchema, "dealers");

/**
 * Admin Schema - HQ administrators with department assignment
 */
const adminSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  department: { type: String, required: true },
  processNumber: { type: String },
  dateOfProcess: { type: Date, default: Date.now },
  pin: { type: String, default: null },
  pinCreatedAt: { type: Date, default: null },
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
});

const adminConn = mongoose.createConnection(MONGODB_URI, connectionOptions);
// Add error handler to avoid unhandled promise rejection
adminConn.on('error', (err) => {
  console.error(`❌ Admin MongoDB connection error: ${err.message}`);
});
adminConn.on("disconnected", () => {
  adminConnectionPromise = null;
});
const adminDb = adminConn.useDb("tbank-admin");
const Admin = adminDb.model("Admin", adminSchema, "admins");

/**
 * SuperAdmin Schema - Tier above administrators
 */
const superAdminSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  rawPhone: { type: String },
  name: { type: String, required: true },
  pin: { type: String, required: true },
  permissions: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
});

const SuperAdmin = adminDb.model("SuperAdmin", superAdminSchema, "superAdmins");

let adminConnectionPromise = null;

/**
 * Connect (and reuse) the separate admin connection.
 * This was the root cause of "Operation admins.distinct() buffering timed out"
 * and "superAdmins.findOne() buffering timed out" — the admin connection was
 * created but never opened.
 */
const connectAdminDB = async () => {
  if (adminConn.readyState === 1) return adminConn;
  if (adminConnectionPromise) return adminConnectionPromise;

  adminConnectionPromise = (async () => {
    try {
      await adminConn.asPromise();
      return adminConn;
    } catch (error) {
      adminConnectionPromise = null;
      console.error(`❌ Error connecting to admin MongoDB: ${error.message}`);
      throw error;
    }
  })();

  return adminConnectionPromise;
};

const ensureAdminReady = async () => {
  if (adminConn.readyState === 1) return true;
  try {
    await connectAdminDB();
    return adminConn.readyState === 1;
  } catch (error) {
    console.error(`❌ ensureAdminReady failed: ${error.message}`);
    return false;
  }
};

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

      // Open the separate admin connection used by Admin/SuperAdmin models
      connectAdminDB()
        .then(() => console.log("✅ Admin DB connection opened"))
        .catch((err) =>
          console.error(`❌ Admin DB connection failed: ${err.message}`),
        );

      if (!process.listenerCount("SIGINT")) {
        process.on("SIGINT", async () => {
          try {
            await mongoose.connection.close();
            await adminConn.close();
            console.log("MongoDB connections closed through app termination");
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
        "   Tip: In MongoDB Atlas → Network Access, allow 0.0.0.0/0 so Render can connect.",
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
      user =
        legacy.find((u) => normalizePhone(u.phoneNumber) === target) || null;
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
    const parts = [user.FirstName, user.MiddleName, user.LastName]
      .map((s) => s && String(s).trim())
      .filter(Boolean);
    return parts.join(" ");
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
          const user = (wardItem.data || []).find(
            (u) => normalizePhone(u.phoneNumber) === target,
          );
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
    let consIndex = countyDoc.constituencies.findIndex(
      (c) => c.name === constituency,
    );
    if (consIndex === -1) {
      countyDoc.constituencies.push({ name: constituency, wards: [] });
      consIndex = countyDoc.constituencies.length - 1;
    }

    // Find or create ward
    let wardIndex = countyDoc.constituencies[consIndex].wards.findIndex(
      (w) => w.name === ward,
    );
    if (wardIndex === -1) {
      countyDoc.constituencies[consIndex].wards.push({ name: ward, data: [] });
      wardIndex = countyDoc.constituencies[consIndex].wards.length - 1;
    }

    // Check for duplicate phone in this ward
    const existingUser = countyDoc.constituencies[consIndex].wards[
      wardIndex
    ].data.find((u) => phoneMatches(u.phoneNumber, userInfo.phoneNumber));
    if (existingUser) {
      throw new Error("Phone number already registered");
    }

    // Add user to ward data
    countyDoc.constituencies[consIndex].wards[wardIndex].data.push({
      ...userInfo,
      createdAt: new Date(),
    });

    await countyDoc.save();
    console.log(
      `✅ User saved to MongoDB (hierarchical): ${userInfo.phoneNumber}`,
    );

    return countyDoc;
  } catch (error) {
    if (error.message === "Phone number already registered") {
      console.error(
        `❌ Phone number already registered: ${userData.phoneNumber}`,
      );
      throw error;
    }
    console.error(`❌ Error saving user to MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Update user password in hierarchical structure
 */
const updateUserPassword = async (
  phoneNumber,
  hashedPassword,
  isPin = false,
) => {
  try {
    const countyItem = await County.findOne({
      "constituencies.wards.data.phoneNumber": phoneNumber,
    });
    if (!countyItem) return null;

    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const user = wardItem.data.find((u) => u.phoneNumber === phoneNumber);
        if (user) {
          if (isPin) {
            user.personalPin = hashedPassword;
          } else {
            user.password = hashedPassword;
          }
          await countyItem.save();
          return {
            ...user.toObject(),
            county: countyItem.county,
            constituency: consItem.name,
            ward: wardItem.name,
          };
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
    const countyItem = await County.findOne({
      "constituencies.wards.data.phoneNumber": phoneNumber,
    });
    if (!countyItem) return false;

    let removed = false;
    for (const consItem of countyItem.constituencies) {
      for (const wardItem of consItem.wards) {
        const userIndex = wardItem.data.findIndex(
          (u) => u.phoneNumber === phoneNumber,
        );
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
  hierarchicalData.forEach((countyItem) => {
    countyItem.constituencies.forEach((constituencyItem) => {
      constituencyItem.wards.forEach((wardItem) => {
        wardItem.data.forEach((user) => {
          flat.push({
            ...user,
            county: countyItem.county,
            constituency: constituencyItem.name,
            ward: wardItem.name,
          });
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
  const fs = require("fs");
  const path = require("path");
  const bcrypt = require("bcrypt");

  console.log("🚀 Starting PIN migration from data.json → MongoDB...\n");

  // data.json lives at the project root, alongside this file
  const dataFile = path.join(__dirname, "data.json");

  const raw = fs.readFileSync(dataFile, "utf8");
  const users = JSON.parse(raw);

  const usersWithPin = flattenHierarchicalUsers(users).filter(
    (u) => u.personalPin,
  );
  console.log(
    `📋 Found ${usersWithPin.length} user(s) with personalPin in data.json\n`,
  );

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
        console.log(
          `⏭️  ${phoneNumber} — Already has PIN in MongoDB, skipping`,
        );
        skipped++;
        continue;
      }

      let hashedPin = personalPin;
      if (!personalPin.startsWith("$2")) {
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

  console.log("\n========== Migration Complete ==========");
  console.log(`✅ Migrated: ${migrated}`);
  console.log(`⏭️  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  console.log("========================================\n");

  return { migrated, skipped, errors };
};

module.exports = {
  connectDB,
  ensureMongoReady,
  ensureAdminReady,
  connectAdminDB,
  getMongoConfigHint,
  mongoose,
  County,
  PersonalAccount,
  MemberGroup,
  TbankSettings,
  Message,
  Agent,
  Dealer,
  Admin,
  SuperAdmin,
  adminConn,
  saveMessageToMongo,
  getMessagesForUser,
  PendingOfficerMessage,
  savePendingOfficerMessage,
  getPendingOfficerMessageByPhone,
  deletePendingOfficerMessage,
  saveUserToMongoDB,
  findUserByPhone,
  findUserInCounties,
  getUserNameByPhone,
  updateLastLogin,
  getAllUsersFlattened,
  updateUserPassword,
  removeUserFromMongo,
  migratePinsFromJSON,
  flattenHierarchicalUsers,
  normalizePhone,
  phoneMatches,
  saveMemberGroupToMongo,
  addMemberToMemberGroup,
  updateMemberAccountInMongo,
  getMemberGroupFromMongo,
  saveMemberDataToMongo,
  findOrCreateMemberGroup,
  isGroupNameAvailableInMongo,
  saveGeneralGroupToMongo,
  deleteGeneralGroupFromMongo,
  getGeneralGroupsFromMongo,
  findGeneralGroupsByMemberPhone,
  cleanupStaleGroupKeys,
  fixGroupKeyIndex,
  saveTbankSettings,
  getTbankSettings,
};
