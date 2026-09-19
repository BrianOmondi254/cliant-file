require("dotenv").config();
const mongoose = require("mongoose");
let _bcryptLazy = null;
const getBcrypt = () => {
  if (_bcryptLazy === null) {
    try { _bcryptLazy = require("bcrypt"); }
    catch (_) { _bcryptLazy = false; }
  }
  return _bcryptLazy || null;
};
const isBcryptHash = (value) =>
  typeof value === "string" &&
  value.length >= 59 &&
  value.length <= 60 &&
  /^\$2[aby]?\$\d{1,2}\$/.test(value);
const maskPhone = (p) => {
  const s = String(p || "").trim();
  if (!s || s.length < 7) return s;
  const visibleHead = Math.min(3, Math.max(1, Math.floor(s.length / 4)));
  const visibleTail = 2;
  return s.slice(0, visibleHead) + "*".repeat(Math.max(3, s.length - visibleHead - visibleTail)) + s.slice(-visibleTail);
};

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

const adminConnectionOptions = {
  ...connectionOptions,
  serverSelectionTimeoutMS: isProduction ? 60000 : 30000,
};

let connectionPromise = null;

const maskMongoUri = (uri) => String(uri).replace(/:([^:@/]+)@/, ":****@");

const CREDENTIAL_FIELDS = [
  "password",
  "passkey",
  "personalPin",
  "startky",
  "pin",
  "secret",
  "token",
];
const redactCredentials = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((o) => redactCredentials(o));
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    const keyLower = typeof k === "string" ? k.toLowerCase() : k;
    if (CREDENTIAL_FIELDS.includes(k) || CREDENTIAL_FIELDS.some((s) => keyLower === s || keyLower.endsWith(s) || keyLower.startsWith(s))) {
      delete out[k];
      continue;
    }
    if (out[k] && typeof out[k] === "object" && !(out[k] instanceof Date) && !ArrayBuffer.isView(out[k])) {
      out[k] = redactCredentials(out[k]);
    }
  }
  return out;
};

/**
 * Ward Schema - Contains user data array matching data.json hierarchy
 */
const wardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: [
    {
      FirstName: { type: String, required: true, maxlength: 80 },
      MiddleName: { type: String, maxlength: 80 },
      LastName: { type: String, required: true, maxlength: 80 },
      email: {
        type: String,
        lowercase: true,
        trim: true,
        maxlength: 200,
        match: [/^\S+@\S+\.\S+$/, "Invalid email format"],
      },
      phoneNumber: { type: String, required: true, maxlength: 30 },
      password: {
        type: String,
        required: true,
        select: false,
        minlength: 59,
        maxlength: 60,
        validate: {
          validator: (v) => typeof v === "string" && /^\$2[aby]?\$\d{1,2}\$/.test(v),
          message: "Password must be a bcrypt hash",
        },
      },
      gender: { type: String, maxlength: 20 },
      ageBracket: { type: String, maxlength: 20 },
      idNumber: { type: String, maxlength: 30 },
      passkey: {
        type: String,
        select: false,
        maxlength: 60,
      },
      personalPin: {
        type: String,
        select: false,
        maxlength: 60,
      },
      startky: {
        type: String,
        select: false,
        maxlength: 60,
      },
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
    accountVerified: { type: String },
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
    lastSelectedAuthOption: {
      option: { type: String },
      processedBy: { type: String },
      replacedAt: { type: String },
      date: { type: String },
    },
    lastSelectedAuthOptionHistory: [
      {
        option: { type: String },
        processedBy: { type: String },
        replacedAt: { type: String },
        date: { type: String },
      },
    ],
  },
  { _id: false },
);

const TbankSettings =
  mongoose.models.TbankSettings ||
  mongoose.model("TbankSettings", tbankSettingsSchema, "tbank");

const sanitizeObjectKeys = (raw, opts = {}) => {
  if (!raw || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map((v) => sanitizeObjectKeys(v, opts));
  const allowlist = Array.isArray(opts.allowlist) ? new Set(opts.allowlist) : null;
  const out = {};
  for (const key of Object.keys(raw)) {
    if (typeof key !== "string") continue;
    if (key.includes(".") || key.startsWith("$")) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (allowlist && !allowlist.has(key)) continue;
    const val = raw[key];
    if (val && typeof val === "object" && !(val instanceof Date) && !ArrayBuffer.isView(val)) {
      out[key] = sanitizeObjectKeys(val, {});
    } else {
      out[key] = val;
    }
  }
  return out;
};

/**
 * Typed registrationData sub-schema — replaces Schema.Types.Mixed so
 * credentials & PII fields are explicitly declared and validated.
 */
const registrationDataSchema = new mongoose.Schema(
  {
    FirstName: { type: String, default: "" },
    MiddleName: { type: String, default: "" },
    LastName: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, lowercase: true, trim: true, default: "" },
    phoneNumber: { type: String, default: "" },
    idNumber: { type: String, default: "" },
    gender: { type: String, default: "" },
    ageBracket: { type: String, default: "" },
    password: { type: String, select: false },
    startky: { type: String, select: false },
    orderId: { type: String },
    orderTrackingId: { type: String },
    merchantReference: { type: String },
    paymentMethod: { type: String },
    verificationNonce: { type: String },
    checkoutRequestId: { type: String },
    receiptNumber: { type: String },
  },
  { _id: false, strict: false, toObject: { minimize: false } }
);


/**
 * PendingAccount leaf record (stored inside ward.data[]). Contains all
 * payment/user fields that the old flat PendingAccount documents had.
 */
const pendingAccountRecordSchema = new mongoose.Schema(
  {
    orderId: { type: String },
    orderTrackingId: { type: String },
    merchantReference: { type: String },
    amount: { type: Number },
    chargedAmount: { type: Number },
    currency: { type: String, default: "KES" },
    statusCode: { type: mongoose.Schema.Types.Mixed },
    paymentStatusDescription: { type: String },
    paymentMethod: { type: String },
    paymentAccount: { type: String },
    confirmationCode: { type: String },
    verificationNonce: { type: String },
    registrationData: { type: registrationDataSchema, default: () => ({}) },
    status: { type: String, default: "INITIATED" },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { _id: true, timestamps: false }
);

/**
 * PendingAccount Ward sub-document — matches County wardSchema shape.
 * name = ward name (e.g. "Kangemi"), data = array of pending registration records
 */
const pendingAccountWardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: [pendingAccountRecordSchema],
});

/**
 * PendingAccount Constituency sub-document — matches County constituencySchema.
 * name = constituency name (e.g. "Westlands"), wards = array of ward sub-docs
 */
const pendingAccountConstituencySchema = new mongoose.Schema({
  name: { type: String, required: true },
  wards: [pendingAccountWardSchema],
});

/**
 * PendingAccount Schema — County-level nesting, identical to County structure:
 *   County doc → constituencies[] → wards[] → data[] (pending payment records)
 *
 * The top-level PendingAccount document = one county (unique name). All pending
 * registrations for users in that county are stored inside the hierarchy.
 */
const pendingAccountSchema = new mongoose.Schema(
  {
    county: { type: String, required: true, unique: true },
    constituencies: [pendingAccountConstituencySchema],
  },
  { timestamps: true }
);

const PendingAccount =
  mongoose.models.PendingAccount ||
  mongoose.model("PendingAccount", pendingAccountSchema, "pendingaccount");

/**
 * Flatten a single PendingAccount (county-level) doc into an array of
 * leaf records, each injected with county / constituency / ward names.
 * Mirrors flattenMongoCountyDoc + getAllUsersFlattened patterns.
 */
const flattenPendingAccountDoc = (doc) => {
  const flat = [];
  if (!doc) return flat;
  const county = doc.county;
  for (const cons of doc.constituencies || []) {
    const constituency = cons.name;
    for (const ward of cons.wards || []) {
      const wardName = ward.name;
      for (const rec of ward.data || []) {
        const obj = rec.toObject ? rec.toObject() : { ...rec };
        let regData = obj.registrationData || {};
        if (typeof regData === "string") {
          try { regData = JSON.parse(regData); } catch (_) { regData = {}; }
        }
        const fn = obj.FirstName || regData.FirstName || regData.firstName || "";
        const mn = obj.MiddleName || regData.MiddleName || regData.middleName || "";
        const ln = obj.LastName || regData.LastName || regData.lastName || "";
        const fullName = regData.name || [fn, mn, ln].filter(Boolean).join(" ");

        flat.push({
          ...obj,
          phoneNumber: obj.phoneNumber || regData.phoneNumber || regData.PhoneNumber || regData.phone || "",
          FirstName: fn,
          MiddleName: mn,
          LastName: ln,
          name: fullName,
          email: obj.email || regData.email || "",
          gender: obj.gender || regData.gender || "",
          ageBracket: obj.ageBracket || regData.ageBracket || "",
          idNumber: obj.idNumber || regData.idNumber || "",
          password: obj.password || regData.password || "",
          passkey: obj.passkey || regData.passkey || "",
          startky: obj.startky || regData.startky || "",
          county,
          constituency,
          ward: wardName,
        });
      }
    }
  }
  return flat;
};

/**
 * Flatten ALL PendingAccount county documents (optionally filtered by a
 * per-record predicate + per-record status/datetime filters). Used by
 * read-path helpers that need to scan across the collection.
 *
 * opts: { filter?: (flatRecord) => boolean, newerThanMs?: number }
 */
const getAllPendingFlattened = async (opts = {}) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return [];
    const cursor = PendingAccount.find({}).cursor();
    const results = [];
    for await (const doc of cursor) {
      const flatRecs = flattenPendingAccountDoc(doc);
      for (const rec of flatRecs) {
        if (typeof opts.newerThanMs === "number") {
          const t = rec.createdAt ? new Date(rec.createdAt).getTime() : 0;
          if (Date.now() - t > opts.newerThanMs) continue;
        }
        if (typeof opts.filter === "function" && !opts.filter(rec)) continue;
        results.push(rec);
      }
    }
    return results;
  } catch (e) {
    console.error("[getAllPendingFlattened] error:", e.message);
    return [];
  }
};

/**
 * Save / upsert a pending registration record into the nested County-style
 * PendingAccount structure. Works just like saveUserToMongoDB: if the county/
 * constituency/ward path doesn't exist it is created; if an existing record
 * matches by a provided uniqueness predicate, it is updated in place; otherwise
 * a new leaf record is pushed into ward.data[].
 *
 * pendingData must contain county/constituency/ward strings plus the leaf
 * record fields (orderId, phoneNumber, amount, status, etc.).
 *
 * opts.match: a predicate(record) => boolean used to detect existing record
 *             to update instead of inserting a new one. Common: match by
 *             orderId or orderTrackingId.
 */
const savePendingAccountToMongo = async (pendingData, opts = {}) => {
  const { county, constituency, ward, ...leafFields } = pendingData || {};
  if (!county) {
    throw new Error("savePendingAccountToMongo: county is required");
  }
  if (!constituency) {
    throw new Error("savePendingAccountToMongo: constituency is required");
  }
  if (!ward) {
    throw new Error("savePendingAccountToMongo: ward is required");
  }

  const PENDING_LEAF_ALLOWLIST = [
    "orderId",
    "orderTrackingId",
    "merchantReference",
    "amount",
    "chargedAmount",
    "currency",
    "statusCode",
    "paymentStatusDescription",
    "paymentMethod",
    "paymentAccount",
    "confirmationCode",
    "verificationNonce",
    "registrationData",
    "status",
    "createdAt",
    "completedAt",
  ];
  const sanitizedLeaf = sanitizeObjectKeys(leafFields || {}, { allowlist: PENDING_LEAF_ALLOWLIST });
  if (sanitizedLeaf.registrationData !== undefined) {
    sanitizedLeaf.registrationData = sanitizeObjectKeys(sanitizedLeaf.registrationData || {});
  }
  if (sanitizedLeaf.statusCode !== undefined) {
    sanitizedLeaf.statusCode = sanitizeObjectKeys(sanitizedLeaf.statusCode);
  }

  let countyDoc = await PendingAccount.findOne({ county });
  if (!countyDoc) {
    countyDoc = new PendingAccount({ county, constituencies: [] });
  }

  let consIdx = countyDoc.constituencies.findIndex(
    (c) => c.name === constituency,
  );
  if (consIdx === -1) {
    countyDoc.constituencies.push({ name: constituency, wards: [] });
    consIdx = countyDoc.constituencies.length - 1;
  }

  let wardIdx = countyDoc.constituencies[consIdx].wards.findIndex(
    (w) => w.name === ward,
  );
  if (wardIdx === -1) {
    countyDoc.constituencies[consIdx].wards.push({ name: ward, data: [] });
    wardIdx = countyDoc.constituencies[consIdx].wards.length - 1;
  }

  const wardRef = countyDoc.constituencies[consIdx].wards[wardIdx];
  const leaf = { ...sanitizedLeaf };
  if (!leaf.createdAt) leaf.createdAt = new Date();

  let matchIdx = -1;
  if (typeof opts.match === "function") {
    matchIdx = wardRef.data.findIndex((r) => {
      try {
        return opts.match(r);
      } catch (_) {
        return false;
      }
    });
  }
  if (matchIdx !== -1) {
    const existing = wardRef.data[matchIdx];
    const existingId = existing._id;
    const existingCreated = existing.createdAt;
    const existingRaw = existing.toObject ? existing.toObject() : { ...existing };
    const merged = {
      ...existingRaw,
      ...leaf,
      _id: existingId,
      createdAt: existingCreated || leaf.createdAt,
    };
    if (existingRaw.registrationData || leaf.registrationData) {
      merged.registrationData = {
        ...sanitizeObjectKeys(existingRaw.registrationData || {}),
        ...sanitizeObjectKeys(leaf.registrationData || {}),
      };
    }
    wardRef.data[matchIdx] = merged;
  } else {
    wardRef.data.push(leaf);
  }

  await countyDoc.save();
  const flattened = matchIdx !== -1
    ? flattenPendingAccountDoc(countyDoc).find((r) =>
        (matchIdx !== -1) && opts.match && opts.match(r),
      )
    : null;
  return flattened || {
    ...(wardRef.data[wardRef.data.length - 1].toObject
      ? wardRef.data[wardRef.data.length - 1].toObject()
      : wardRef.data[wardRef.data.length - 1]),
    county,
    constituency,
    ward,
  };
};

/**
 * Internal helper: navigate the PendingAccount nested structure on a
 * Mongoose doc and apply a mutator to any leaf record matching the predicate.
 * Returns [countyDoc, mutatedCount] so the caller can save() if needed.
 */
const mutatePendingLeaves = async (predicate, mutator) => {
  const ready = await ensureMongoReady();
  if (!ready) return null;
  const docs = await PendingAccount.find({});
  let totalMutated = 0;
  for (const countyDoc of docs) {
    let changed = false;
    for (const cons of countyDoc.constituencies || []) {
      for (const ward of cons.wards || []) {
        for (let i = 0; i < (ward.data || []).length; i++) {
          let rec = ward.data[i];
          const flatRec = {
            ...(rec.toObject ? rec.toObject() : rec),
            county: countyDoc.county,
            constituency: cons.name,
            ward: ward.name,
          };
          if (predicate(flatRec)) {
            const updated = mutator(rec, { county: countyDoc.county, constituency: cons.name, ward: ward.name });
            if (updated !== undefined) ward.data[i] = updated;
            changed = true;
            totalMutated++;
          }
        }
      }
    }
    if (changed) await countyDoc.save();
  }
  return totalMutated;
};

/**
 * Find FIRST pending record across all counties matching a predicate,
 * returned flat with county/constituency/ward attached (or null).
 *
 * opts: { newerThanMs?: number, filterStatuses?: string[] }
 */
const findPendingRecord = async (predicate, opts = {}) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return null;
    const cursor = PendingAccount.find({}).cursor();
    for await (const doc of cursor) {
      const flat = flattenPendingAccountDoc(doc);
      for (const rec of flat) {
        if (Array.isArray(opts.filterStatuses) && opts.filterStatuses.length > 0) {
          if (!opts.filterStatuses.includes(String(rec.status || ""))) continue;
        }
        if (typeof opts.newerThanMs === "number") {
          const t = rec.createdAt ? new Date(rec.createdAt).getTime() : 0;
          if (Date.now() - t > opts.newerThanMs) continue;
        }
        try {
          if (predicate(rec)) return rec;
        } catch (_) {
          // predicate threw for this record — skip
        }
      }
    }
    return null;
  } catch (e) {
    console.error("[findPendingRecord] error:", e.message);
    return null;
  }
};

/**
 * Delete FIRST pending record matching the predicate (returns true if
 * anything was removed). Used when consuming a pending registration.
 */
const deletePendingRecord = async (predicate) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return false;
    const docs = await PendingAccount.find({});
    for (const countyDoc of docs) {
      let changed = false;
      for (const cons of countyDoc.constituencies || []) {
        for (const ward of cons.wards || []) {
          const dataArr = ward.data || [];
          for (let i = dataArr.length - 1; i >= 0; i--) {
            const r = dataArr[i];
            const flat = {
              ...(r.toObject ? r.toObject() : r),
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name,
            };
            if (predicate(flat)) {
              dataArr.splice(i, 1);
              changed = true;
            }
          }
        }
      }
      if (changed) {
        await countyDoc.save();
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error("[deletePendingRecord] error:", e.message);
    return false;
  }
};

/**
 * Delete ALL pending records matching a predicate (cleanup old INITIATED).
 * Returns count of deleted records.
 */
const deleteAllPendingRecords = async (predicate) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return 0;
    const docs = await PendingAccount.find({});
    let total = 0;
    for (const countyDoc of docs) {
      let changed = false;
      for (const cons of countyDoc.constituencies || []) {
        for (const ward of cons.wards || []) {
          const dataArr = ward.data || [];
          for (let i = dataArr.length - 1; i >= 0; i--) {
            const r = dataArr[i];
            const flat = {
              ...(r.toObject ? r.toObject() : r),
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name,
            };
            if (predicate(flat)) {
              dataArr.splice(i, 1);
              total++;
              changed = true;
            }
          }
        }
      }
      if (changed) await countyDoc.save();
    }
    return total;
  } catch (e) {
    console.error("[deleteAllPendingRecords] error:", e.message);
    return 0;
  }
};

/**
 * Update in place the FIRST pending record matching predicate with $set-style
 * fields. Returns the updated flat record or null.
 */
const updatePendingRecord = async (predicate, setFields = {}) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return null;
    const safeSetFields = sanitizeObjectKeys(setFields);
    const docs = await PendingAccount.find({});
    for (const countyDoc of docs) {
      let matchedFlat = null;
      let changed = false;
      for (const cons of countyDoc.constituencies || []) {
        for (const ward of cons.wards || []) {
          for (let i = 0; i < (ward.data || []).length; i++) {
            const r = ward.data[i];
            const flat = {
              ...(r.toObject ? r.toObject() : r),
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name,
            };
            if (predicate(flat)) {
              Object.keys(safeSetFields).forEach((k) => {
                r[k] = safeSetFields[k];
              });
              matchedFlat = {
                ...(r.toObject ? r.toObject() : { ...r }),
                county: countyDoc.county,
                constituency: cons.name,
                ward: ward.name,
              };
              changed = true;
              break;
            }
          }
          if (matchedFlat) break;
        }
        if (matchedFlat) break;
      }
      if (changed) await countyDoc.save();
      if (matchedFlat) return matchedFlat;
    }
    return null;
  } catch (e) {
    console.error("[updatePendingRecord] error:", e.message);
    return null;
  }
};

/**
 * Save a pending record by ANY of the common keys — automatically derives
 * county/constituency/ward from (a) passed explicit values or (b) the
 * registrationData blob. This is the single entry-point used by pesapal.js
 * for both setPendingPayment (INITIATED) and callback (VERIFIED_PENDING_).
 *
 * On upsert match-order: 1. orderId 2. orderTrackingId 3. verificationNonce
 * — whichever is present in `data` first, the existing record is found.
 */
const upsertPendingAccount = async (data) => {
  let regData =
    data && typeof data.registrationData === "string"
      ? (() => {
          try { return JSON.parse(data.registrationData); } catch (_) { return {}; }
        })()
      : ({ ...(data?.registrationData || {}) });

  const county =
    String(data.county || regData.county || "").trim() || "Unknown";
  const constituency =
    String(data.constituency || regData.constituency || "").trim() || "Unknown";
  const ward =
    String(data.ward || regData.ward || "").trim() || "Unknown Ward";

  // Build complete user profile object inside registrationData
  const FirstName = data.FirstName || regData.FirstName || regData.firstName || "";
  const MiddleName = data.MiddleName || regData.MiddleName || regData.middleName || "";
  const LastName = data.LastName || regData.LastName || regData.lastName || "";
  const fullName = regData.name || [FirstName, MiddleName, LastName].filter(Boolean).join(" ");
  const phoneNumber = String(data.phoneNumber || regData.phoneNumber || regData.PhoneNumber || regData.phone || "").trim();
  const email = data.email || regData.email || "";
  const rawPassword = data.password || regData.password || "";
  const idNumber = data.idNumber || regData.idNumber || "";
  const gender = data.gender || regData.gender || "";
  const ageBracket = data.ageBracket || regData.ageBracket || "";
  const rawStartky = data.startky || regData.startky || "";

  let securedPassword = rawPassword;
  if (rawPassword && !isBcryptHash(rawPassword)) {
    const bcrypt = getBcrypt();
    if (bcrypt) {
      try { securedPassword = await bcrypt.hash(String(rawPassword), 10); }
      catch (_) { securedPassword = ""; }
    } else {
      securedPassword = "";
    }
  }
  let securedStartky = rawStartky;
  if (rawStartky && !isBcryptHash(rawStartky)) {
    const bcrypt = getBcrypt();
    if (bcrypt) {
      try { securedStartky = await bcrypt.hash(String(rawStartky), 10); }
      catch (_) { securedStartky = ""; }
    } else {
      securedStartky = "";
    }
  }

  const cleanedRegData = {
    FirstName,
    MiddleName,
    LastName,
    name: fullName,
    email,
    password: securedPassword || undefined,
    phoneNumber,
    idNumber,
    gender,
    ageBracket,
    startky: securedStartky || undefined,
  };

  // Remove regional block from registrationData since county, constituency, ward are in document hierarchy
  delete cleanedRegData.county;
  delete cleanedRegData.constituency;
  delete cleanedRegData.ward;
  // Ensure passkey is NEVER persisted in pending records (it belongs only in tbank compliance settings)
  delete cleanedRegData.passkey;

  const matchKeys = [];
  if (data.orderId) matchKeys.push((r) => r.orderId === data.orderId);
  if (data.orderTrackingId) matchKeys.push((r) => r.orderTrackingId === data.orderTrackingId);
  if (data.verificationNonce) matchKeys.push((r) => r.verificationNonce === data.verificationNonce);
  const combinedMatch = (r) => matchKeys.some((fn) => fn(r));

  const payload = {
    county,
    constituency,
    ward,
    orderId: data.orderId || undefined,
    orderTrackingId: data.orderTrackingId || undefined,
    merchantReference: data.merchantReference || undefined,
    amount: typeof data.amount === "number" ? data.amount : undefined,
    chargedAmount: typeof data.chargedAmount === "number" ? data.chargedAmount : undefined,
    currency: data.currency || "KES",
    statusCode: data.statusCode !== undefined ? data.statusCode : undefined,
    paymentStatusDescription: data.paymentStatusDescription || undefined,
    paymentMethod: data.paymentMethod || undefined,
    paymentAccount: data.paymentAccount || undefined,
    confirmationCode: data.confirmationCode || undefined,
    verificationNonce: data.verificationNonce || undefined,
    registrationData: cleanedRegData,
    status: data.status || "INITIATED",
    createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
    completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
  };

  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  return savePendingAccountToMongo(payload, {
    match: matchKeys.length ? combinedMatch : undefined,
  });
};

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
    const MESSAGE_ALLOWLIST = [
      "groupName",
      "to",
      "type",
      "title",
      "content",
      "key",
      "broadcast",
      "roles",
      "meta",
      "status",
      "createdAt",
    ];
    const safe = sanitizeObjectKeys(message || {}, { allowlist: MESSAGE_ALLOWLIST });
    if (safe.meta !== undefined) safe.meta = sanitizeObjectKeys(safe.meta);
    if (Array.isArray(safe.roles)) safe.roles = safe.roles.filter((r) => typeof r === "string").map((r) => String(r).slice(0, 64));
    await Message.create(safe);
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
    passkey: { type: String, default: "", select: false },
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
    let securedPasskey = passkey || "";
    if (securedPasskey && !isBcryptHash(securedPasskey)) {
      const bcrypt = getBcrypt();
      if (bcrypt) {
        try {
          securedPasskey = await bcrypt.hash(String(securedPasskey), 10);
        } catch (_) {
          securedPasskey = "";
        }
      } else {
        securedPasskey = "";
      }
    }
    const result = await PendingOfficerMessage.updateOne(
      { phone: normalizePhone(phone) },
      {
        $set: {
          name,
          dept,
          passkey: securedPasskey,
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

const TBANK_ALLOWED_TOP_LEVEL = [
  "compliance",
  "lastSelectedAuthOption",
  "lastSelectedAuthOptionHistory",
];

const sanitizeTbankSettings = (raw) => {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;

  for (const topKey of TBANK_ALLOWED_TOP_LEVEL) {
    if (!(topKey in raw)) continue;
    const value = raw[topKey];
    if (topKey === "lastSelectedAuthOptionHistory") {
      if (Array.isArray(value)) {
        result[topKey] = value
          .filter(x => x && typeof x === "object" && !Array.isArray(x))
          .map(entry => {
            const clean = {};
            for (const k of Object.keys(entry)) {
              if (typeof k !== "string") continue;
              if (k.includes(".") || k.startsWith("$") || k === "__proto__" || k === "constructor" || k === "prototype") continue;
              clean[k] = entry[k];
            }
            return clean;
          });
      }
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const cleanSub = {};
      for (const subKey of Object.keys(value)) {
        if (typeof subKey !== "string") continue;
        if (subKey.includes(".") || subKey.startsWith("$") || subKey === "__proto__" || subKey === "constructor" || subKey === "prototype") continue;
        const subVal = value[subKey];
        if (subVal && typeof subVal === "object" && !Array.isArray(subVal)) {
          const cleanLeaf = {};
          for (const leafKey of Object.keys(subVal)) {
            if (typeof leafKey !== "string") continue;
            if (leafKey.includes(".") || leafKey.startsWith("$") || leafKey === "__proto__" || leafKey === "constructor" || leafKey === "prototype") continue;
            cleanLeaf[leafKey] = subVal[leafKey];
          }
          cleanSub[subKey] = cleanLeaf;
        } else {
          cleanSub[subKey] = subVal;
        }
      }
      result[topKey] = cleanSub;
    } else {
      result[topKey] = value;
    }
  }

  return result;
};

/**
 * Save tbank settings to MongoDB
 */
const saveTbankSettings = async (settings) => {
  if (mongoose.connection.readyState !== 1) return false;
  const db = mongoose.connection.db;
  if (!db) return false;

  try {
    const cleaned = sanitizeTbankSettings(settings);
    const payload = { ...cleaned, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(payload)) {
      if (typeof k !== "string" || k.includes(".") || k.startsWith("$")) {
        delete payload[k];
      }
    }

    await db
      .collection("tbank")
      .updateOne(
        {},
        { $set: payload },
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
    // NOTE: createdAt is intentionally left out here and stamped per-branch below,
    // so updates to an existing group can preserve its original createdAt.
    const accountToSave = {
      ...accountFields,
      updatedAt: now,
      syncedAt: now,
      source: "general",
    };

    let countyDoc = await col.findOne({ county });

    if (!countyDoc) {
      const newDoc = { county };
      newDoc[constituency] = [
        ward,
        { ...accountToSave, createdAt: accountFields.createdAt || now },
      ];
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
      const existingItem = constituencyArray[existingIdx];
      constituencyArray[existingIdx] = {
        ...existingItem,
        ...accountToSave,
        createdAt: existingItem.createdAt || accountFields.createdAt || now,
      };
    } else {
      const newGroupEntry = {
        ...accountToSave,
        createdAt: accountFields.createdAt || now,
      };
      let wardIndex = constituencyArray.findIndex(
        (item) =>
          typeof item === "string" && item.toLowerCase() === ward.toLowerCase(),
      );

      if (wardIndex === -1) {
        constituencyArray.push(ward, newGroupEntry);
      } else {
        let insertIndex = wardIndex + 1;
        while (
          insertIndex < constituencyArray.length &&
          typeof constituencyArray[insertIndex] === "object"
        ) {
          insertIndex++;
        }
        constituencyArray.splice(insertIndex, 0, newGroupEntry);
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

const createPerformanceIndexes = async () => {
  try {
    if (mongoose.connection.readyState !== 1) return false;
    const db = mongoose.connection.db;
    if (!db) return false;

    const results = [];

    const groupsCol = db.collection("groups");
    try {
      const idx1 = await groupsCol.createIndex(
        { county: 1 },
        { background: true, name: "county_1" }
      );
      results.push(`groups: ${idx1}`);
    } catch (e) {
      results.push(`groups index error: ${e.message}`);
    }

    const membersCol = db.collection("groups-members");
    try {
      const idxPromises = [];
      idxPromises.push(
        membersCol.createIndex(
          { county: 1 },
          { background: true, name: "county_1" }
        ).then(r => `groups-members:${r}`)
      );
      // Case-insensitive indexes for group lookup fields (strength:2 = case insensitive, accent insensitive)
      const ciCollation = { locale: "en", strength: 2 };
      idxPromises.push(
        membersCol.createIndex(
          { "constituencies.wards.data.groupName": 1 },
          { background: true, name: "ward_data_groupName_ci", collation: ciCollation }
        ).then(r => `groups-members:gn_ci:${r}`)
      );
      idxPromises.push(
        membersCol.createIndex(
          { "constituencies.wards.data.groupId": 1 },
          { background: true, name: "ward_data_groupId_ci", collation: ciCollation }
        ).then(r => `groups-members:gid_ci:${r}`)
      );
      idxPromises.push(
        membersCol.createIndex(
          { "constituencies.wards.data.accountNumber": 1 },
          { background: true, name: "ward_data_accNum_ci", collation: ciCollation }
        ).then(r => `groups-members:acc_ci:${r}`)
      );
      const settled = await Promise.allSettled(idxPromises);
      const results2 = settled
        .filter(s => s.status === "fulfilled")
        .map(s => s.value)
        .concat(settled.filter(s => s.status === "rejected").map(s => `idx_err:${String(s.reason && s.reason.message || s.reason).slice(0,80)}`));
      results.push(results2.join(", "));
    } catch (e) {
      results.push(`groups-members index error: ${e.message}`);
    }

    const countiesCol = db.collection("counties");
    try {
      const ciCollation2 = { locale: "en", strength: 2 };
      const idx2 = await countiesCol.createIndex(
        { "constituencies.wards.data.phoneNumber": 1 },
        { background: true, name: "ward_data_phoneNumber_ci", collation: ciCollation2 }
      );
      results.push(`counties: ${idx2}`);
    } catch (e) {
      results.push(`counties index error: ${e.message}`);
    }

    const paCol = db.collection("personalaccounts");
    try {
      const ciCollation3 = { locale: "en", strength: 2 };
      const idxPromises3 = [];
      idxPromises3.push(
        paCol.createIndex(
          { "constituencies.wards.data.phone": 1 },
          { background: true, name: "ward_data_phone_ci", collation: ciCollation3 }
        ).then(r => `pa_leaf:${r}`)
      );
      idxPromises3.push(
        paCol.createIndex(
          { phone: 1 },
          { background: true, sparse: true, name: "top_level_phone_sparse" }
        ).then(r => `pa_top:${r}`)
      );
      idxPromises3.push(
        paCol.createIndex(
          { "account.personal.accountNumber": 1 },
          { background: true, sparse: true, name: "account_personal_accountNumber_sparse" }
        ).then(r => `pa_acc:${r}`)
      );
      const settled3 = await Promise.allSettled(idxPromises3);
      const results3 = settled3
        .filter(s => s.status === "fulfilled")
        .map(s => s.value)
        .concat(settled3.filter(s => s.status === "rejected").map(s => `idx_err:${String(s.reason && s.reason.message || s.reason).slice(0,80)}`));
      results.push(results3.join(", "));
    } catch (e) {
      results.push(`personalaccounts index error: ${e.message}`);
    }

    const pendingCol = db.collection("pendingaccounts");
    try {
      const pendingIdx = await pendingCol.createIndex(
        { createdAt: 1 },
        {
          background: true,
          name: "pending_createdAt_ttl_initiated",
          expireAfterSeconds: 3600,
          partialFilterExpression: { status: "INITIATED" },
        }
      );
      results.push(`pending_ttl:${pendingIdx}`);
    } catch (e) {
      results.push(`pending ttl error: ${e.message}`);
    }

    try {
      const cutoff = new Date(Date.now() - 2 * 3600 * 1000);
      const dr = await pendingCol.deleteMany({
        status: "INITIATED",
        createdAt: { $lt: cutoff },
      });
      if (dr && typeof dr.deletedCount === "number" && dr.deletedCount > 0) {
        results.push(`pending_cleanup:${dr.deletedCount}`);
      }
    } catch (e) {
      results.push(`pending cleanup err: ${e.message}`);
    }

    console.log("[Index] Performance indexes ensured:", results.join(", "));
    return true;
  } catch (err) {
    console.error("[Index] Error creating performance indexes:", err.message);
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

  const cursor = db.collection("groups").find({});
  const allGroups = [];
  for await (const doc of cursor) {
    allGroups.push(...flattenMongoCountyDoc(doc));
  }
  return allGroups;
};

const findGeneralGroupsByMemberPhone = async (phone) => {
  const ready = await ensureMongoReady();
  if (!ready) throw new Error("MongoDB not connected");

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB database unavailable");

  const normalized = normalizePhone(phone);
  const cursor = db.collection("groups").find({});
  const allGroups = [];
  for await (const doc of cursor) {
    allGroups.push(...flattenMongoCountyDoc(doc));
  }

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
    const cursor = db
      .collection("groups")
      .find({});

    for await (const doc of cursor) {
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
    const cursor = db
      .collection("groups-members")
      .find({});

    for await (const doc of cursor) {
      if (!doc || !Array.isArray(doc.constituencies)) continue;
      for (let i = 0; i < doc.constituencies.length; i++) {
        const constituency = doc.constituencies[i];
        if (!constituency || !Array.isArray(constituency.wards)) continue;
        for (let j = 0; j < constituency.wards.length; j++) {
          const ward = constituency.wards[j];
          if (!ward || !Array.isArray(ward.data)) continue;
          for (let k = 0; k < ward.data.length; k++) {
            const group = ward.data[k];
            const flatName = normalizeGroupName(group && group.groupName);
            const flatId = normalizeGroupName(group && group.groupId);
            if (!group || (flatName !== target && flatId !== target)) continue;
            return {
              group,
              county: group.county || doc.county,
              constituency: group.constituency || constituency.name,
              ward: group.ward || ward.name,
              source: "groups-members.regional",
              // Exact write coordinates — reused by callers that need to
              // mutate this same group later (e.g. the tBank payment route)
              // instead of re-scanning and possibly resolving a different doc.
              docId: doc._id,
              groupPath: `constituencies.${i}.wards.${j}.data.${k}`,
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
 * Personal Account Leaf Record — one per user, stored inside ward.data[].
 * Mirrors the old flat personalAccountSchema fields EXCEPT that county,
 * constituency, and ward are removed from the leaf because they are carried
 * by the document hierarchy (county doc → constituencies[] → wards[] → data[]).
 */
const personalAccountLeafSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    account: {
      business: {
        name: { type: String, default: "" },
        "total-bal": { type: Number, default: 0 },
        float: { type: Number, default: 0 },
        benefit: { type: Number, default: 0 },
      },
      pending: {
        value: { type: Number, default: 0 },
      },
      personal: {
        reg_fee: { type: Number, default: 0 },
        personal: { type: Number, default: 0 },
        openBalance: { type: Number, default: 0 },
        pendingBalance: { type: Number, default: 0 },
      },
    },
    transactions: [
      new mongoose.Schema(
        {
          cord: { type: String },
          reference: { type: String },
          time: { type: Date },
          openingBalance: { type: Number, default: 0 },
          amount: { type: Number, default: 0 },
          type: { type: String, enum: ["received", "sent"], default: "received" },
          from: { name: { type: String }, number: { type: String } },
          to: { name: { type: String }, number: { type: String } },
          closingBalance: { type: Number, default: 0 },
          environment: { type: String, default: "unknown" },
          notes: { type: String },
          status: { type: String, enum: ["pending", "completed"], default: "completed" },
        },
        { _id: false },
      ),
    ],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const personalAccountWardSchema = new mongoose.Schema({
  name: { type: String, required: true },
  data: [personalAccountLeafSchema],
});

const personalAccountConstituencySchema = new mongoose.Schema({
  name: { type: String, required: true },
  wards: [personalAccountWardSchema],
});

const personalAccountSchema = new mongoose.Schema(
  {
    county: { type: String, required: true, unique: true },
    constituencies: [personalAccountConstituencySchema],
  },
  { timestamps: true }
);

const PersonalAccount =
  mongoose.models.PersonalAccount ||
  mongoose.model("PersonalAccount", personalAccountSchema, "personalaccounts");

const flattenPersonalAccountDoc = (doc) => {
  const flat = [];
  if (!doc) return flat;
  const county = doc.county;
  for (const cons of doc.constituencies || []) {
    const constituency = cons.name;
    for (const ward of cons.wards || []) {
      const wardName = ward.name;
      for (const rec of ward.data || []) {
        const obj = rec.toObject ? rec.toObject() : { ...rec };
        flat.push({
          ...obj,
          county,
          constituency,
          ward: wardName,
        });
      }
    }
  }
  return flat;
};

const getAllPersonalFlattened = async (opts = {}) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return [];
    const cursor = PersonalAccount.find({}).cursor();
    const results = [];
    for await (const doc of cursor) {
      const flatRecs = flattenPersonalAccountDoc(doc);
      for (const rec of flatRecs) {
        if (typeof opts.filter === "function" && !opts.filter(rec)) continue;
        results.push(rec);
      }
    }
    return results;
  } catch (e) {
    console.error("[getAllPersonalFlattened] error:", e.message);
    return [];
  }
};

const findPersonalAccountByPhone = async (phone) => {
  try {
    const rawPhone = String(phone || '').trim();
    const target = normalizePhone(rawPhone);
    if (!target) return null;
    const ready = await ensureMongoReady();
    if (!ready) return null;

    const phoneVariants = [
      rawPhone,
      target,
      `0${target}`,
      `254${target}`,
      `+254${target}`
    ];

    const db = mongoose.connection.db;
    const ciCollation = { locale: "en", strength: 2 };

    // 0. NEW: Indexed fast-path — narrow to the single county doc that has this phone
    try {
      if (db) {
        const paCol = db.collection("personalaccounts");
        const narrowDoc = await paCol
          .findOne(
            { "constituencies.wards.data.phone": { $in: phoneVariants } },
            { collation: ciCollation }
          );
        if (narrowDoc) {
          const countyName = narrowDoc.county;
          for (const consItem of narrowDoc.constituencies || []) {
            const consName = consItem.name;
            for (const wardItem of consItem.wards || []) {
              const wardName = wardItem.name;
              for (const rec of wardItem.data || []) {
                const recObj = rec && rec.toObject ? rec.toObject() : { ...rec };
                if (
                  normalizePhone(recObj.phone) === target ||
                  phoneVariants.includes(String(recObj.phone || ""))
                ) {
                  return {
                    ...recObj,
                    county: countyName,
                    constituency: consName,
                    ward: wardName,
                  };
                }
              }
            }
          }
        }
      }
    } catch (fastErr) {
      console.warn(
        "[findPersonalAccountByPhone] indexed fast-path failed, continuing fallbacks:",
        fastErr.message
      );
    }

    // 1. Direct collection query on personalaccounts (flat documents)
    const directDoc = await db.collection("personalaccounts").findOne({
      $or: [
        { phone: { $in: phoneVariants } },
        { "account.personal.accountNumber": { $in: phoneVariants } }
      ]
    });
    if (directDoc && (directDoc.account || directDoc.phone || directDoc.transactions)) {
      return directDoc;
    }

    // 2. Direct collection query on PersonalAccount
    const directDoc2 = await db.collection("PersonalAccount").findOne({
      $or: [
        { phone: { $in: phoneVariants } },
        { "account.personal.accountNumber": { $in: phoneVariants } }
      ]
    });
    if (directDoc2 && (directDoc2.account || directDoc2.phone || directDoc2.transactions)) {
      return directDoc2;
    }

    // 3. Hierarchical search across PersonalAccount county structures (full fallback)
    const cursor = PersonalAccount.find({}).cursor();
    for await (const doc of cursor) {
      const flat = flattenPersonalAccountDoc(doc);
      for (const rec of flat) {
        if (normalizePhone(rec.phone) === target || phoneVariants.includes(rec.phone)) return rec;
      }
    }
    return null;
  } catch (e) {
    console.error("[findPersonalAccountByPhone] error:", e.message);
    return null;
  }
};

const savePersonalAccountToMongo = async (accountData) => {
  const { county, constituency, ward, ...leafFields } = accountData;
  if (!county) throw new Error("savePersonalAccountToMongo: county is required");
  if (!constituency) throw new Error("savePersonalAccountToMongo: constituency is required");
  if (!ward) throw new Error("savePersonalAccountToMongo: ward is required");

  let countyDoc = await PersonalAccount.findOne({ county });
  if (!countyDoc) {
    countyDoc = new PersonalAccount({ county, constituencies: [] });
  }

  let consIdx = countyDoc.constituencies.findIndex((c) => c.name === constituency);
  if (consIdx === -1) {
    countyDoc.constituencies.push({ name: constituency, wards: [] });
    consIdx = countyDoc.constituencies.length - 1;
  }

  let wardIdx = countyDoc.constituencies[consIdx].wards.findIndex((w) => w.name === ward);
  if (wardIdx === -1) {
    countyDoc.constituencies[consIdx].wards.push({ name: ward, data: [] });
    wardIdx = countyDoc.constituencies[consIdx].wards.length - 1;
  }

  const wardRef = countyDoc.constituencies[consIdx].wards[wardIdx];
  const phone = leafFields.phone ? String(leafFields.phone) : "";
  const leaf = { ...leafFields };
  if (!leaf.createdAt) leaf.createdAt = new Date();

  let matchIdx = -1;
  if (phone) {
    matchIdx = wardRef.data.findIndex((r) => normalizePhone(r.phone) === normalizePhone(phone));
  }
  if (matchIdx !== -1) {
    const existing = wardRef.data[matchIdx];
    const existingId = existing._id;
    const existingCreated = existing.createdAt;
    wardRef.data[matchIdx] = {
      ...(existing.toObject ? existing.toObject() : existing),
      ...leaf,
      _id: existingId,
      createdAt: existingCreated || leaf.createdAt,
      updatedAt: new Date(),
    };
  } else {
    wardRef.data.push(leaf);
  }

  await countyDoc.save();
  const flat = flattenPersonalAccountDoc(countyDoc);
  if (phone) {
    return flat.find((r) => normalizePhone(r.phone) === normalizePhone(phone)) || null;
  }
  const last = wardRef.data[wardRef.data.length - 1];
  return last ? {
    ...(last.toObject ? last.toObject() : last),
    county, constituency, ward,
  } : null;
};

const mutatePersonalLeaves = async (predicate, mutator) => {
  const ready = await ensureMongoReady();
  if (!ready) return null;
  const docs = await PersonalAccount.find({});
  let totalMutated = 0;
  for (const countyDoc of docs) {
    let changed = false;
    for (const cons of countyDoc.constituencies || []) {
      for (const ward of cons.wards || []) {
        for (let i = 0; i < (ward.data || []).length; i++) {
          const rec = ward.data[i];
          const flatRec = {
            ...(rec.toObject ? rec.toObject() : rec),
            county: countyDoc.county,
            constituency: cons.name,
            ward: ward.name,
          };
          if (predicate(flatRec)) {
            const updated = mutator(rec, {
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name,
            });
            if (updated !== undefined) {
              ward.data[i] = updated;
              ward.data[i].updatedAt = new Date();
            } else {
              rec.updatedAt = new Date();
            }
            changed = true;
            totalMutated++;
          }
        }
      }
    }
    if (changed) await countyDoc.save();
  }
  return totalMutated;
};

const findPersonalRecord = async (predicate) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return null;
    const cursor = PersonalAccount.find({}).cursor();
    for await (const doc of cursor) {
      const flat = flattenPersonalAccountDoc(doc);
      for (const rec of flat) {
        try { if (predicate(rec)) return rec; } catch (_) {}
      }
    }
    return null;
  } catch (e) {
    console.error("[findPersonalRecord] error:", e.message);
    return null;
  }
};

const updatePersonalRecord = async (predicate, setFields = {}) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return null;
    const safeSetFields = sanitizeObjectKeys(setFields);
    const docs = await PersonalAccount.find({});
    for (const countyDoc of docs) {
      let matchedFlat = null;
      let changed = false;
      for (const cons of countyDoc.constituencies || []) {
        for (const ward of cons.wards || []) {
          for (let i = 0; i < (ward.data || []).length; i++) {
            const r = ward.data[i];
            const flat = {
              ...(r.toObject ? r.toObject() : r),
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name,
            };
            if (predicate(flat)) {
              Object.keys(safeSetFields).forEach((k) => { r[k] = safeSetFields[k]; });
              r.updatedAt = new Date();
              matchedFlat = {
                ...(r.toObject ? r.toObject() : { ...r }),
                county: countyDoc.county,
                constituency: cons.name,
                ward: ward.name,
              };
              changed = true;
              break;
            }
          }
          if (matchedFlat) break;
        }
        if (matchedFlat) break;
      }
      if (changed) await countyDoc.save();
      if (matchedFlat) return matchedFlat;
    }
    return null;
  } catch (e) {
    console.error("[updatePersonalRecord] error:", e.message);
    return null;
  }
};

const upsertPersonalAccount = async (data) => {
  const county = String(data.county || "").trim() || "Unknown";
  const constituency = String(data.constituency || "").trim() || "Unknown";
  const ward = String(data.ward || "").trim() || "Unknown Ward";
  const payload = { ...data };
  delete payload.county;
  delete payload.constituency;
  delete payload.ward;
  return await savePersonalAccountToMongo({
    county, constituency, ward, ...payload,
  });
};

/**
 * Agent Schema - backed by the `agents` MongoDB collection
 */
const agentSchema = new mongoose.Schema({
  name: { type: String },
  phoneNumber: { type: String, required: true, unique: true },
  dealerPhone: { type: String },
  accepted: { type: Boolean, default: true },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
  isBlocked: { type: Boolean, default: false },
  passkey: { type: String, select: false },
  createdAt: { type: Date, default: Date.now },
  groupsTotal: [{ type: mongoose.Schema.Types.Mixed }],
  totalMembers: { type: Number, default: 0 },
  members: { type: mongoose.Schema.Types.Mixed },
  group: { type: mongoose.Schema.Types.Mixed },
});

const Agent =
  mongoose.models.Agent || mongoose.model("Agent", agentSchema, "agents");

/**
 * Dealer Schema - backed by the `dealers` MongoDB collection
 */
const dealerSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  hqPhone: { type: String },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
  name: { type: String },
  isBlocked: { type: Boolean, default: false },
  pin: { type: String, select: false },
  passkey: { type: String, select: false },
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
  pin: { type: String, default: null, select: false },
  pinCreatedAt: { type: Date, default: null },
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
});

// NOTE: "tbank-admin" is a different DATABASE, not a different CLUSTER —
// it lives on the same Atlas deployment as the main connection. Previously
// this opened a second, fully independent mongoose.createConnection(), which
// meant a second TLS handshake to Atlas competing with the main one. On some
// networks that second concurrent handshake was reliably timing out at the
// secureConnect stage even though the primary connection succeeded every
// time. useDb({ useCache: true }) reuses the already-open client/socket pool
// from the default connection instead of dialing out again, so there is only
// ever ONE physical connection to Atlas — its readyState tracks the main
// connection automatically.
const adminConn = mongoose.connection.useDb("tbank-admin", { useCache: true });
adminConn.on("error", (err) => {
  console.error(`❌ Admin MongoDB (tbank-admin) error: ${err.message}`);
});
const adminDb = adminConn;
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

/**
 * "Connect" the admin DB — since adminConn now shares the main connection's
 * client (see useDb({ useCache: true }) above), there is no separate socket
 * to dial. This just ensures the MAIN connection is up; adminConn.readyState
 * tracks it automatically once that succeeds.
 */
const connectAdminDB = async () => {
  await connectDB();
  return adminConn;
};

const ensureAdminReady = async () => {
  if (adminConn.readyState === 1) {
    return true;
  }
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

  // Register listeners BEFORE calling connect(). mongoose.connection is a
  // persistent EventEmitter — if the socket emits 'error' (e.g. ECONNRESET
  // during handshake) before any 'error' listener exists, Node treats it as
  // an unhandled event and crashes the whole process, even though the
  // connect() promise rejection below is already being caught elsewhere.
  // Attaching these up front is what actually prevents the crash.
  if (mongoose.connection.listenerCount("error") === 0) {
    mongoose.connection.on("error", (err) => {
      console.error(`❌ MongoDB connection error: ${err.message}`);
    });
  }

  if (mongoose.connection.listenerCount("disconnected") === 0) {
    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️  MongoDB disconnected");
      connectionPromise = null;
    });
  }

  if (mongoose.connection.listenerCount("reconnected") === 0) {
    mongoose.connection.on("reconnected", () => {
      console.log("🔄 MongoDB reconnected");
    });
  }

  connectionPromise = (async () => {
    try {
      console.log(`🔌 MongoDB connecting to ${maskMongoUri(MONGODB_URI)} ...`);
      const conn = await mongoose.connect(MONGODB_URI, connectionOptions);
      console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

      // Open the separate admin connection used by Admin/SuperAdmin models
      connectAdminDB()
        .then(() => console.log("✅ Admin DB connection opened"))
        .catch((err) =>
          console.error(`❌ Admin DB connection failed: ${err.message}`),
        );

      if (!process.listenerCount("SIGINT")) {
        process.on("SIGINT", async () => {
          try {
            // adminConn shares the main connection's client (useDb/useCache),
            // so closing mongoose.connection also tears down adminConn — no
            // separate .close() call needed (and calling one here would just
            // double-close the same underlying socket).
            await mongoose.connection.close();
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
  const digits = String(p).trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 9) return digits.slice(-9);
  return digits;
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
const findUserInCounties = async (phoneNumber, opts = {}) => {
  const includeCredentials = Boolean(opts.includeCredentials);
  const target = normalizePhone(phoneNumber);
  if (!target) return null;

  const rawPhone = String(phoneNumber || "").trim();
  const phoneVariants = [
    rawPhone,
    target,
    `0${target}`,
    `254${target}`,
    `+254${target}`,
  ];
  const ciCollation = { locale: "en", strength: 2 };

  try {
    const db = mongoose.connection.db;
    if (db) {
      const countiesCol = db.collection("counties");
      const projection = includeCredentials
        ? {}
        : {
            "constituencies.wards.data.password": 0,
            "constituencies.wards.data.passkey": 0,
            "constituencies.wards.data.personalPin": 0,
            "constituencies.wards.data.startky": 0,
          };
      const narrowDoc = await countiesCol
        .findOne(
          { "constituencies.wards.data.phoneNumber": { $in: phoneVariants } },
          { collation: ciCollation, projection }
        );
      if (narrowDoc) {
        const countyName = narrowDoc.county;
        for (const consItem of narrowDoc.constituencies || []) {
          const consName = consItem.name;
          for (const wardItem of consItem.wards || []) {
            const wardName = wardItem.name;
            for (const user of wardItem.data || []) {
              if (
                normalizePhone(user.phoneNumber) === target ||
                phoneVariants.includes(String(user.phoneNumber || ""))
              ) {
                const result = {
                  ...user,
                  county: countyName,
                  constituency: consName,
                  ward: wardName,
                };
                return includeCredentials ? result : redactCredentials(result);
              }
            }
          }
        }
      }
    }
  } catch (fastErr) {
    console.warn(
      "[findUserInCounties] indexed fast-path failed, falling back:",
      fastErr.message
    );
  }

  const countiesQuery = County.find({});
  if (includeCredentials) {
    countiesQuery.select(
      "+constituencies.wards.data.password " +
      "+constituencies.wards.data.passkey " +
      "+constituencies.wards.data.personalPin " +
      "+constituencies.wards.data.startky"
    );
  }
  const counties = await countiesQuery.lean();
  for (const countyItem of counties) {
    for (const consItem of countyItem.constituencies || []) {
      for (const wardItem of consItem.wards || []) {
        for (const user of wardItem.data || []) {
          if (normalizePhone(user.phoneNumber) === target) {
            const result = {
              ...user,
              county: countyItem.county,
              constituency: consItem.name,
              ward: wardItem.name,
            };
            return includeCredentials ? result : redactCredentials(result);
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
const findUserByPhone = async (phoneNumber, opts = {}) => {
  const includeCredentials = Boolean(opts.includeCredentials);
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      throw new Error("MongoDB not connected");
    }

    let user = await findUserInCounties(phoneNumber, { includeCredentials });
    if (user) return user;

    const target = normalizePhone(phoneNumber);
    if (!target) return null;

    const db = mongoose.connection.db;
    if (db) {
      const legacyCol = db.collection("users");
      const projection = includeCredentials
        ? {}
        : { password: 0, passkey: 0, personalPin: 0, startky: 0 };
      const legacy = await legacyCol.find({}, { projection }).toArray();
      const found =
        legacy.find((u) => normalizePhone(u.phoneNumber) === target) || null;
      if (found) {
        return includeCredentials ? { ...found } : redactCredentials({ ...found });
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
    const { county, constituency, ward } = userData || {};

    const ALLOWED_USER_KEYS = [
      "FirstName",
      "MiddleName",
      "LastName",
      "email",
      "phoneNumber",
      "password",
      "gender",
      "ageBracket",
      "idNumber",
      "passkey",
      "personalPin",
      "startky",
      "createdAt",
      "lastLogin",
    ];
    const pickAllowed = (src) => {
      const out = {};
      if (!src || typeof src !== "object") return out;
      for (const k of ALLOWED_USER_KEYS) {
        if (k in src) out[k] = src[k];
      }
      return out;
    };
    const userInfo = pickAllowed(userData || {});

    const rawPassword = userInfo.password;
    if (
      rawPassword &&
      !isBcryptHash(rawPassword) &&
      typeof rawPassword === "string" &&
      rawPassword.length > 0
    ) {
      const bcrypt = getBcrypt();
      if (bcrypt) {
        try {
          userInfo.password = await bcrypt.hash(String(rawPassword), 10);
        } catch (_) {
          userInfo.password = "";
        }
      } else {
        throw new Error(
          "Password requires bcrypt dependency unavailable — cannot store plaintext password",
        );
      }
    }
    const rawPin = userInfo.personalPin;
    if (
      rawPin &&
      !isBcryptHash(rawPin) &&
      typeof rawPin === "string" &&
      rawPin.length > 0
    ) {
      const bcrypt = getBcrypt();
      if (bcrypt) {
        try {
          userInfo.personalPin = await bcrypt.hash(String(rawPin), 10);
        } catch (_) {
          userInfo.personalPin = "";
        }
      }
    }
    const rawStartky = userInfo.startky;
    if (
      rawStartky &&
      !isBcryptHash(rawStartky) &&
      typeof rawStartky === "string" &&
      rawStartky.length > 0
    ) {
      const bcrypt = getBcrypt();
      if (bcrypt) {
        try {
          userInfo.startky = await bcrypt.hash(String(rawStartky), 10);
        } catch (_) {
          userInfo.startky = "";
        }
      }
    }

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
    if (!isProduction) {
      console.log(
        `✅ User saved to MongoDB (hierarchical): ${maskPhone(userInfo.phoneNumber)}`,
      );
    }

    return countyDoc;
  } catch (error) {
    if (error.message === "Phone number already registered") {
      if (!isProduction) {
        console.error(
          `❌ Phone number already registered: ${maskPhone(
            userData && userData.phoneNumber,
          )}`,
        );
      }
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
    const maskedPhone = maskPhone(phoneNumber);

    try {
      const dbUser = await findUserByPhone(phoneNumber);

      if (!dbUser) {
        if (!isProduction) console.log(`⚠️  ${maskedPhone} — Not found in MongoDB, skipping`);
        skipped++;
        continue;
      }

      if (dbUser.personalPin) {
        if (!isProduction) {
          console.log(
            `⏭️  ${maskedPhone} — Already has PIN in MongoDB, skipping`,
          );
        }
        skipped++;
        continue;
      }

      let hashedPin = personalPin;
      if (!personalPin.startsWith("$2")) {
        if (!isProduction) console.log(`🔐 ${maskedPhone} — Plaintext PIN detected, hashing...`);
        hashedPin = await bcrypt.hash(personalPin, 10);
      }

      await updateUserPassword(phoneNumber, hashedPin, true); // isPin = true
      if (!isProduction) console.log(`✅ ${maskedPhone} — PIN migrated to MongoDB`);
      migrated++;
    } catch (err) {
      if (!isProduction) console.error(`❌ ${maskedPhone} — Error: ${err.message}`);
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

/**
 * Build phone-number variants for tolerant matching against stored
 * agent/dealer phone numbers, which may be saved with or without a leading
 * "0", a "+254"/"254" prefix, etc.
 */
const phoneVariants = (p) => {
  if (!p) return [];
  const n = normalizePhone(p);
  return Array.from(new Set([
    n,
    "0" + n,
    "254" + n,
    "+254" + n,
    String(p).trim()
  ].filter(Boolean)));
};

const findAgentByPhone = async (phone, opts = {}) => {
  const includeCredentials = Boolean(opts.includeCredentials);
  try {
    if (!phone) return null;
    const q = Agent.findOne({ phoneNumber: { $in: phoneVariants(phone) } });
    if (includeCredentials) q.select("+passkey");
    return await q.lean();
  } catch (e) {
    console.error("findAgentByPhone error:", e.message);
    return null;
  }
};

const findDealerByPhone = async (phone, opts = {}) => {
  const includeCredentials = Boolean(opts.includeCredentials);
  try {
    if (!phone) return null;
    const q = Dealer.findOne({ phoneNumber: { $in: phoneVariants(phone) } });
    if (includeCredentials) q.select("+pin +passkey");
    return await q.lean();
  } catch (e) {
    console.error("findDealerByPhone error:", e.message);
    return null;
  }
};

const processedGroupTxIds = new Set();
setInterval(() => {
  if (processedGroupTxIds.size > 10000) processedGroupTxIds.clear();
}, 2 * 60 * 60 * 1000);

// =========================================================================
// Builds the dateIntervalCycle.rounds[] array that computeLiveRoundStatuses
// consumes. Call this whenever a member's contribution schedule is first
// created (con_group.ejs's "Activate Principles" -> POST /general/set-principles
// is where `principles.intervals` originates), and it's also used below as a
// self-healing fallback when an account has no rounds yet.
//
// intervalConfig matches con_group.ejs's `principles.intervals` shape exactly:
//   { frequency, endSavingPeriod, contributionDay, weekOfMonth, month }
//
// Guarantees computeLiveRoundStatuses' two assumptions:
//   1. Every round.scheduledDate is a parseable ISO string (never left to
//      chance / free-text input).
//   2. Rounds come out pre-sorted ascending (they're generated in order).
// =========================================================================
const DEFAULT_ROUND_COUNTS = { daily: 30, weekly: 52, monthly: 12, yearly: 5 };

// con_group.ejs's "End Saving Period" <select> — total cycle duration,
// expressed in months regardless of contribution frequency.
const SAVING_PERIOD_MONTHS = {
  "6-months": 6,
  "1-year": 12,
  "2-years": 24,
  "3-years": 36,
  "4-years": 48,
  "5-years": 60,
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_OF_MONTH_INDEX = { "1st Week": 0, "2nd Week": 1, "3rd Week": 2, "4th Week": 3 };
const MONTH_INDEX = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

// How many rounds a full cycle needs, given the admin's chosen
// `endSavingPeriod` (e.g. "5-years") and how often contributions land.
// Falls back to the old fixed defaults if endSavingPeriod wasn't set/recognized
// (e.g. legacy groups saved before this field existed).
const roundsForSavingPeriod = (frequency, endSavingPeriod) => {
  const months = SAVING_PERIOD_MONTHS[String(endSavingPeriod || "").toLowerCase()];
  if (!months) return DEFAULT_ROUND_COUNTS[frequency] || DEFAULT_ROUND_COUNTS.weekly;
  if (frequency === "daily") return Math.round(months * 30.44);
  if (frequency === "monthly") return months;
  if (frequency === "yearly") return Math.max(1, Math.round(months / 12));
  return Math.round(months * (52 / 12)); // weekly, and the fallback for unknown frequencies
};

// Snaps the cycle's first round onto the exact weekday / week-of-month /
// month the admin picked in con_group.ejs, instead of just "whatever weekday
// principlesSetAt happens to be". Subsequent rounds stay evenly spaced from
// this anchor by addIntervalToDate, so the whole schedule stays aligned.
const alignFirstRoundDate = (start, frequency, intervalConfig) => {
  const d = new Date(start);
  const targetDow = WEEKDAYS.indexOf(intervalConfig?.contributionDay || "");
  const weekIdx = WEEK_OF_MONTH_INDEX[intervalConfig?.weekOfMonth];

  if (frequency === "weekly" && targetDow >= 0) {
    d.setDate(d.getDate() + ((targetDow - d.getDay() + 7) % 7));
  } else if (frequency === "monthly" && weekIdx != null) {
    d.setDate(1);
    d.setDate(1 + (targetDow >= 0 ? (targetDow - d.getDay() + 7) % 7 : 0) + weekIdx * 7);
  } else if (frequency === "yearly" && intervalConfig?.month in MONTH_INDEX) {
    d.setMonth(MONTH_INDEX[intervalConfig.month]);
    d.setDate(1);
    if (weekIdx != null) {
      d.setDate(1 + (targetDow >= 0 ? (targetDow - d.getDay() + 7) % 7 : 0) + weekIdx * 7);
    }
  }
  return d;
};

const addIntervalToDate = (date, n, frequency) => {
  const d = new Date(date);
  if (frequency === "daily") d.setDate(d.getDate() + n);
  else if (frequency === "monthly") d.setMonth(d.getMonth() + n);
  else if (frequency === "yearly") d.setFullYear(d.getFullYear() + n);
  else d.setDate(d.getDate() + n * 7); // weekly, and the fallback for unknown frequencies
  return d;
};

const buildDateIntervalCycle = (startDate, intervalConfig = {}, totalRounds) => {
  const frequency = String(intervalConfig?.frequency || "").toLowerCase() || "weekly";
  const rawStart = startDate ? new Date(startDate) : new Date();
  if (Number.isNaN(rawStart.getTime())) {
    // Never persist an unparseable cycle — that's exactly what causes a
    // round to get stuck forever (see computeLiveRoundStatuses' malformed
    // branch). Fall back to "now" instead of writing bad data.
    return buildDateIntervalCycle(new Date().toISOString(), intervalConfig, totalRounds);
  }
  const start = alignFirstRoundDate(rawStart, frequency, intervalConfig);

  const count = Number.isInteger(totalRounds) && totalRounds > 0
    ? totalRounds
    : roundsForSavingPeriod(frequency, intervalConfig?.endSavingPeriod);

  const rounds = [];
  for (let i = 0; i < count; i++) {
    rounds.push({
      roundNumber: i + 1,
      scheduledDate: addIntervalToDate(start, i, frequency).toISOString(),
      status: "pending", // computeLiveRoundStatuses recomputes this live on every read
      accountroundPerformance: [],
    });
  }

  return {
    frequency,
    endSavingPeriod: intervalConfig?.endSavingPeriod || null,
    startDate: start.toISOString(),
    endDate: addIntervalToDate(start, count, frequency).toISOString(),
    rounds,
  };
};

const calculateActiveCircle = (principlesSetAt, intervalConfig = {}) => {
  const frequency = String(intervalConfig?.frequency || '').toLowerCase() || 'weekly';
  const startRaw = principlesSetAt || new Date().toISOString();
  const startDate = new Date(startRaw);
  const now = new Date();

  const diffMs = Math.max(0, now.getTime() - startDate.getTime());
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  let roundIndex = 0;
  if (frequency === 'daily') {
    roundIndex = diffDays;
  } else if (frequency === 'weekly') {
    roundIndex = Math.floor(diffDays / 7);
  } else if (frequency === 'monthly') {
    const months = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
    roundIndex = Math.max(0, months);
  } else if (frequency === 'yearly') {
    roundIndex = Math.max(0, now.getFullYear() - startDate.getFullYear());
  } else {
    roundIndex = Math.floor(diffDays / 7);
  }
  return {
    roundIndex,
    roundNumber: roundIndex + 1,
    frequency,
    startDate: startDate.toISOString().split('T')[0],
  };
};

const contributionLocks = new Map();
const withContributionLock = async (lockKey, fn) => {
  const prev = contributionLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  contributionLocks.set(lockKey, current);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (contributionLocks.get(lockKey) === current) {
      contributionLocks.delete(lockKey);
    }
  }
};

// =========================================================================
// Real-time round-state resolver — computes each round's status purely by
// comparing `refDate` against that round's own `scheduledDate` window. No
// elapsed-time / month-count math is involved, and rounds[] is assumed to
// already be in chronological order (round 1, 2, 3 ... as generated).
//
//   - "pending" -> refDate is before this round's scheduledDate
//   - "active"  -> refDate falls within [this round's scheduledDate, next
//                  round's scheduledDate) — or through `endDate` for the
//                  final round
//   - "closed"  -> refDate is on/after the NEXT round's scheduledDate (or
//                  on/after `endDate` for the final round) — this round's
//                  window has already passed
//
// Callers (e.g. a contribution being credited) should only ever READ the
// round whose live status comes back "active" — never recompute an index.
// =========================================================================
const computeLiveRoundStatuses = (rounds, endDate, refDate = new Date()) => {
  if (!Array.isArray(rounds) || rounds.length === 0) return [];
  return rounds.map((round, i) => {
    const schedDate = new Date(round.scheduledDate);
    const nextSchedDate = i + 1 < rounds.length
      ? new Date(rounds[i + 1].scheduledDate)
      : (endDate ? new Date(endDate) : null);

    let status;
    if (Number.isNaN(schedDate.getTime())) {
      status = round.status || "pending"; // malformed date -> leave as-is
    } else if (refDate < schedDate) {
      status = "pending";
    } else if (nextSchedDate && !Number.isNaN(nextSchedDate.getTime()) && refDate >= nextSchedDate) {
      status = "closed";
    } else {
      status = "active";
    }
    return { ...round, status };
  });
};

// =========================================================================
// High-Concurrency Regional Transaction Queue ("qing data")
// Handles 1000+ simultaneous member transactions without delay or crash.
// Enqueues in O(1) time and coalesces regional writes in background batches.
// =========================================================================
const regionalTransactionQueue = [];
let isProcessingRegionalQueue = false;
const REGIONAL_QUEUE_BATCH_SIZE = 150;

const getRegionalQueueStats = () => ({
  pending: regionalTransactionQueue.length,
  isProcessing: isProcessingRegionalQueue,
});

const enqueueRegionalTransaction = (item) => {
  if (!item || Number(item.verifiedTotal || 0) <= 0) return;
  regionalTransactionQueue.push(item);
  triggerRegionalQueueProcessing();
};

const triggerRegionalQueueProcessing = () => {
  if (isProcessingRegionalQueue) return;
  isProcessingRegionalQueue = true;
  setImmediate(async () => {
    try {
      await processRegionalQueueWorker();
    } catch (err) {
      console.error("[processRegionalQueueWorker] Unhandled error:", err.message);
    } finally {
      isProcessingRegionalQueue = false;
      if (regionalTransactionQueue.length > 0) {
        triggerRegionalQueueProcessing();
      }
    }
  });
};

const processRegionalBatch = async (batch, db) => {
  if (!batch || batch.length === 0 || !db) return;
  const membersCol = db.collection("groups-members");
  const nowIso = new Date().toISOString();

  // 1. Resolve regional metadata and prep records for every item in this batch
  const batchTxEntries = [];
  const byCounty = {};

  for (const item of batch) {
    let targetCounty = "Region";
    let targetConstituency = "General";
    let targetWard = "General";

    if (item.locatedInMembersCol?.isNested && item.locatedInMembersCol?.nestedLocation) {
      const { cIdx, wIdx } = item.locatedInMembersCol.nestedLocation;
      targetCounty = item.locatedInMembersCol.doc?.county || targetCounty;
      if (Array.isArray(item.locatedInMembersCol.doc?.constituencies)) {
        const consObj = item.locatedInMembersCol.doc.constituencies[cIdx];
        if (consObj?.name) targetConstituency = consObj.name;
        if (Array.isArray(consObj?.wards) && consObj.wards[wIdx]?.name) {
          targetWard = consObj.wards[wIdx].name;
        }
      }
    } else if (item.locatedInMembersCol?.layout === "dynamic_constituency") {
      targetCounty = item.locatedInMembersCol.doc?.county || targetCounty;
      targetConstituency = item.locatedInMembersCol.constituencyKey || targetConstituency;
      if (item.locatedInMembersCol.groupData?.ward) {
        targetWard = item.locatedInMembersCol.groupData.ward;
      }
    }

    if (item.targetGroupData) {
      if (item.targetGroupData.county && targetCounty === "Region") targetCounty = item.targetGroupData.county;
      if (item.targetGroupData.constituency && targetConstituency === "General") targetConstituency = item.targetGroupData.constituency;
      if (item.targetGroupData.ward && targetWard === "General") targetWard = item.targetGroupData.ward;
    }

    const candidateGroupName = item.targetGroupData?.groupName || item.groupName;
    if (candidateGroupName && (targetCounty === "Region" || targetConstituency === "General" || targetWard === "General")) {
      const gHit = (await findGroupNameInGroupsMembersCollection(candidateGroupName)) ||
                   (await findGroupNameInMongoGroupsCollection(candidateGroupName));
      if (gHit) {
        if (gHit.county && (targetCounty === "Region" || !targetCounty)) targetCounty = gHit.county;
        if (gHit.constituency && (targetConstituency === "General" || !targetConstituency)) targetConstituency = gHit.constituency;
        if (gHit.ward && (targetWard === "General" || !targetWard)) targetWard = gHit.ward;
      }
    }

    item.resolvedCounty = targetCounty;
    item.resolvedConstituency = targetConstituency;
    item.resolvedWard = targetWard;

    if (targetCounty && targetCounty !== "Region") {
      if (!byCounty[targetCounty]) byCounty[targetCounty] = [];
      byCounty[targetCounty].push(item);
    }
  }

  // 2. Global Region Level (_id: 'regionTransaction') - Single Coalesced Write
  let regionDoc = await membersCol.findOne({ _id: "regionTransaction" });
  if (!regionDoc) {
    regionDoc = {
      _id: "regionTransaction",
      county: "Region",
      countyId: "region",
      regionTransaction: {
        openingBalance: 0,
        amountIn: 0,
        amountOut: 0,
        closingBalance: 0,
        transactions: [],
      },
      syncedAt: nowIso,
    };
  }

  let regRunningClose = Number(regionDoc.regionTransaction?.closingBalance || 0);
  let regRunningIn = Number(regionDoc.regionTransaction?.amountIn || 0);
  let regRunningOut = Number(regionDoc.regionTransaction?.amountOut || 0);
  const regInitialOpen = regRunningClose;

  for (const item of batch) {
    const amt = Number(item.verifiedTotal || 0);
    const txOpen = regRunningClose;
    regRunningClose = txOpen + amt;
    regRunningIn += amt;

    const txRecord = {
      reference: item.txRef,
      transactionCode: item.txRef,
      time: new Date(),
      date: item.nowIso || nowIso,
      openingBalance: txOpen,
      amount: amt,
      amountIn: amt,
      amountOut: 0,
      closingBalance: regRunningClose,
      type: "credit",
      status: "completed",
    };

    item.txRecord = txRecord;
    batchTxEntries.push(txRecord);
  }

  // Ensure the regionTransaction document exists before pushing to it
  await membersCol.updateOne(
    { _id: "regionTransaction" },
    {
      $setOnInsert: {
        _id: "regionTransaction",
        county: "Region",
        countyId: "region",
        regionTransaction: {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0,
          transactions: [],
        },
        syncedAt: nowIso,
      },
    },
    { upsert: true }
  );

  await membersCol.updateOne(
    { _id: "regionTransaction" },
    {
      $set: {
        county: "Region",
        countyId: "region",
        "regionTransaction.openingBalance": regInitialOpen,
        "regionTransaction.amountIn": regRunningIn,
        "regionTransaction.amountOut": regRunningOut,
        "regionTransaction.closingBalance": regRunningClose,
        syncedAt: nowIso,
      },
      $push: {
        "regionTransaction.transactions": {
          $each: batchTxEntries,
          $slice: -1000,
        },
      },
    }
  );

  // 3. County, Constituency & Ward Level - Coalesced Writes with Auto-Creation if missing
  for (const [countyName, countyItems] of Object.entries(byCounty)) {
    let countyDoc = await membersCol.findOne({
      county: countyName,
      _id: { $ne: "regionTransaction" },
    });

    if (!countyDoc) {
      countyDoc = {
        county: countyName,
        countyId: countyName.toLowerCase(),
        countryTransaction: {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0,
          transactions: [],
        },
        constituencies: [],
        syncedAt: nowIso,
      };
      const insRes = await membersCol.insertOne(countyDoc);
      countyDoc._id = insRes.insertedId;
    }

    if (!countyDoc.countryTransaction) {
      countyDoc.countryTransaction = {
        openingBalance: 0,
        amountIn: 0,
        amountOut: 0,
        closingBalance: 0,
        transactions: [],
      };
    }
    if (!Array.isArray(countyDoc.constituencies)) {
      countyDoc.constituencies = [];
    }

    for (const cItem of countyItems) {
      const cAmt = Number(cItem.verifiedTotal || 0);
      const txBase = {
        reference: cItem.txRecord.reference,
        transactionCode: cItem.txRecord.transactionCode,
        time: cItem.txRecord.time,
        date: cItem.txRecord.date,
        amount: cAmt,
        amountIn: cAmt,
        amountOut: 0,
        type: "credit",
        status: "completed",
      };

      // --- County Level ---
      const countyCurrentClose = Number(countyDoc.countryTransaction?.closingBalance || 0);
      const countyTxEntry = {
        ...txBase,
        openingBalance: countyCurrentClose,
        closingBalance: countyCurrentClose + cAmt,
      };

      await membersCol.updateOne(
        { _id: countyDoc._id },
        {
          $inc: {
            "countryTransaction.amountIn": cAmt,
            "countryTransaction.closingBalance": cAmt,
          },
          $push: {
            "countryTransaction.transactions": {
              $each: [countyTxEntry],
              $slice: -1000,
            },
          },
          $set: { syncedAt: nowIso },
        }
      );

      // Keep countyDoc in-memory balances in sync
      countyDoc.countryTransaction.closingBalance = countyCurrentClose + cAmt;
      countyDoc.countryTransaction.amountIn = Number(countyDoc.countryTransaction.amountIn || 0) + cAmt;

      // Re-read county doc to get fresh constituencies hierarchy
      const freshCounty = await membersCol.findOne(
        { _id: countyDoc._id },
        { projection: { constituencies: 1 } }
      );
      if (freshCounty && Array.isArray(freshCounty.constituencies)) {
        countyDoc.constituencies = freshCounty.constituencies;
      }

      // --- Constituency Level ---
      const consName = String(cItem.resolvedConstituency || "").trim();
      if (!consName || consName === "General") continue;

      let consIdx = (countyDoc.constituencies || []).findIndex(
        (c) => String(c.name || "").trim().toLowerCase() === consName.toLowerCase()
      );

      if (consIdx === -1) {
        const newCons = {
          name: consName,
          constituencyTransaction: {
            openingBalance: 0,
            amountIn: 0,
            amountOut: 0,
            closingBalance: 0,
            transactions: [],
          },
          wards: [],
        };
        await membersCol.updateOne(
          { _id: countyDoc._id },
          { $push: { constituencies: newCons } }
        );
        const refCounty = await membersCol.findOne({ _id: countyDoc._id }, { projection: { constituencies: 1 } });
        countyDoc.constituencies = refCounty?.constituencies || [];
        consIdx = countyDoc.constituencies.findIndex(
          (c) => String(c.name || "").trim().toLowerCase() === consName.toLowerCase()
        );
      }

      if (consIdx !== -1) {
        const consDoc = countyDoc.constituencies[consIdx];
        const consCurrentClose = Number(consDoc.constituencyTransaction?.closingBalance || 0);
        const consTxEntry = {
          ...txBase,
          openingBalance: consCurrentClose,
          closingBalance: consCurrentClose + cAmt,
        };

        await membersCol.updateOne(
          { _id: countyDoc._id },
          {
            $inc: {
              [`constituencies.${consIdx}.constituencyTransaction.amountIn`]: cAmt,
              [`constituencies.${consIdx}.constituencyTransaction.closingBalance`]: cAmt,
            },
            $push: {
              [`constituencies.${consIdx}.constituencyTransaction.transactions`]: {
                $each: [consTxEntry],
                $slice: -1000,
              },
            },
          }
        );

        if (consDoc.constituencyTransaction) {
          consDoc.constituencyTransaction.closingBalance = consCurrentClose + cAmt;
        }

        // --- Ward Level ---
        const wardName = String(cItem.resolvedWard || "").trim();
        if (wardName && wardName !== "General") {
          let wardIdx = (consDoc.wards || []).findIndex(
            (w) => String(w.name || "").trim().toLowerCase() === wardName.toLowerCase()
          );

          if (wardIdx === -1) {
            const newWard = {
              name: wardName,
              wardTransaction: {
                openingBalance: 0,
                amountIn: 0,
                amountOut: 0,
                closingBalance: 0,
                transactions: [],
              },
              data: [],
            };
            await membersCol.updateOne(
              { _id: countyDoc._id },
              { $push: { [`constituencies.${consIdx}.wards`]: newWard } }
            );
            const refCounty = await membersCol.findOne({ _id: countyDoc._id }, { projection: { constituencies: 1 } });
            countyDoc.constituencies = refCounty?.constituencies || [];
            const freshCons = countyDoc.constituencies[consIdx];
            wardIdx = (freshCons?.wards || []).findIndex(
              (w) => String(w.name || "").trim().toLowerCase() === wardName.toLowerCase()
            );
          }

          if (wardIdx !== -1) {
            const freshCons = countyDoc.constituencies[consIdx];
            const wardDoc = freshCons.wards[wardIdx];
            const wardCurrentClose = Number(wardDoc?.wardTransaction?.closingBalance || 0);
            const wardTxEntry = {
              ...txBase,
              openingBalance: wardCurrentClose,
              closingBalance: wardCurrentClose + cAmt,
            };

            await membersCol.updateOne(
              { _id: countyDoc._id },
              {
                $inc: {
                  [`constituencies.${consIdx}.wards.${wardIdx}.wardTransaction.amountIn`]: cAmt,
                  [`constituencies.${consIdx}.wards.${wardIdx}.wardTransaction.closingBalance`]: cAmt,
                },
                $push: {
                  [`constituencies.${consIdx}.wards.${wardIdx}.wardTransaction.transactions`]: {
                    $each: [wardTxEntry],
                    $slice: -1000,
                  },
                },
              }
            );
          }
        }
      }
    }
  }
};

const processRegionalQueueWorker = async () => {
  const ready = await ensureMongoReady();
  if (!ready || mongoose.connection.readyState !== 1) {
    console.warn("[processRegionalQueueWorker] Mongo not ready, will retry on next tick.");
    return;
  }
  const db = mongoose.connection.db;

  while (regionalTransactionQueue.length > 0) {
    const batch = regionalTransactionQueue.splice(0, REGIONAL_QUEUE_BATCH_SIZE);
    try {
      await processRegionalBatch(batch, db);
    } catch (err) {
      console.error("[processRegionalBatch] Error in batch processing:", err.message);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

// Helper for direct/legacy invocation or testing
const updateRegionalHierarchyTransactions = async (params) => {
  enqueueRegionalTransaction(params);
};

const applyAtomicGroupMemberContribution = async ({
  groupName,
  memberPhone,
  accountId = "001",
  accountName = "",
  amount,
  accounts, // NEW optional: [{accountId, accountName, amount}, ...] for multi-account contributions.
            // When omitted, falls back to the single accountId/accountName/amount trio below.
  reference,
  paymentMethod = "mpesa",
  payerPhone,
  notes = "",
}) => {
  const rawLines = Array.isArray(accounts) && accounts.length > 0
    ? accounts
    : [{ accountId, accountName, amount }];

  const lines = rawLines
    .map((a) => ({
      accountId: String(a.accountId || a.accountNumber || "001"),
      accountName: String(a.accountName || "").trim(),
      amount: Number(a.amount || a.inputAmount || 0),
    }))
    .filter((l) => l.amount > 0);

  const payAmount = lines.reduce((s, l) => s + l.amount, 0);
  if (!memberPhone || !lines.length || payAmount <= 0) {
    return { success: false, reason: "INVALID_INPUT" };
  }

  const mPhone = normalizePhone(memberPhone) || String(memberPhone).trim();
  const pPhone = payerPhone ? normalizePhone(payerPhone) || String(payerPhone).trim() : mPhone;
  const rawRef = String(reference || "").trim();
  const isGenericRef = !rawRef || rawRef.toLowerCase() === "group deposit" || rawRef.toLowerCase() === "tbank agent" || rawRef.toLowerCase() === "wallet top-up";
  const txRef = isGenericRef ? `TX_${Date.now()}_${Math.floor(Math.random() * 10000)}` : rawRef;
  const targetGroupNorm = normalizeGroupName(groupName);

  if (txRef && !isGenericRef && processedGroupTxIds.has(txRef)) {
    return { success: false, reason: "ALREADY_PROCESSED" };
  }
  if (txRef && !isGenericRef) processedGroupTxIds.add(txRef);

  const lockKey = `${targetGroupNorm || "grp"}_${mPhone}`;

  return await withContributionLock(lockKey, async () => {
    try {
      const ready = await ensureMongoReady();
      if (!ready || mongoose.connection.readyState !== 1) {
        if (txRef && !isGenericRef) processedGroupTxIds.delete(txRef);
        return { success: false, reason: "MONGO_NOT_READY" };
      }

      const db = mongoose.connection.db;
      const membersCol = db.collection("groups-members");
      const groupsCol = db.collection("groups");

      // =========================================================================
      // Shared fallback: Auto-credit via Add-Fund to PersonalAccount.
      // =========================================================================
      const fallbackToPersonalWallet = async (fallbackReason, fbAmount, fbAccountId, fbAccountName) => {
        const amt = Number(fbAmount != null ? fbAmount : payAmount);
        console.warn(
          `[applyAtomicGroupMemberContribution] ${fallbackReason} — group "${groupName}", member "${mPhone}", amount ${amt}` +
          `${fbAccountId ? `, account ${fbAccountId}` : ""}. Routing to Add-Fund personal wallet.`
        );

        let newWalletBalance = 0;
        let prevOpen = 0;
        await mutatePersonalLeaves(
          (r) => normalizePhone(r.phone) === mPhone,
          (rec) => {
            if (!rec.account) rec.account = {};
            if (!rec.account.business) {
              rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
            }
            if (!rec.account.pending) rec.account.pending = { value: 0 };
            if (!rec.account.personal) {
              rec.account.personal = { reg_fee: 0, personal: 0, openBalance: 0, pendingBalance: 0 };
            }

            prevOpen = Number(rec.account.personal.openBalance || 0);
            const prevPersonal = Number(rec.account.personal.personal || 0);
            newWalletBalance = prevOpen + amt;

            rec.account.personal.openBalance = newWalletBalance;
            rec.account.personal.personal = prevPersonal + amt;

            if (!rec.transactions) rec.transactions = [];
            rec.transactions.push({
              reference: fbAccountId ? `${txRef}_${fbAccountId}` : txRef,
              time: new Date(),
              openingBalance: prevOpen,
              amount: amt,
              type: "received",
              from: {
                name: paymentMethod === "mpesa" ? "M-Pesa (Add-Fund Fallback)" : "Wallet Add-Fund",
                number: pPhone,
              },
              to: { name: "Personal Account", number: mPhone },
              closingBalance: newWalletBalance,
              environment: paymentMethod,
              notes: `Add Fund (Fallback from unverified ${fbAccountId ? `account "${fbAccountName || fbAccountId}" in ` : ""}group: ${groupName || "Unknown"} — ${fallbackReason})`,
              status: "completed",
            });
            rec.updatedAt = new Date();
            return rec;
          }
        );

        const isGroupNotFound = fallbackReason === "GROUP_NOT_FOUND_IN_GROUPS" || fallbackReason === "GROUP_NOT_FOUND";
        const messageTitle = isGroupNotFound ? "Group Account Verification Failed" : "Deposit Credited to Personal Wallet";
        const messageContent = isGroupNotFound
          ? `your payment to ${groupName || "Group"} from your mpesa account has failed to verify group account, amount successfully submitted to your personal wallet.`
          : `Your transaction of KES ${amt.toLocaleString()} intended for ${fbAccountId ? `account "${fbAccountName || fbAccountId}" in ` : ""}group "${groupName || 'Unknown'}" could not be verified and was safely credited to your Personal Wallet balance. Ref: ${txRef}.`;

        await saveMessageToMongo({
          to: mPhone,
          groupName: groupName || "Personal Wallet",
          type: "wallet_credit_fallback",
          title: messageTitle,
          content: messageContent,
          createdAt: new Date().toISOString(),
          isNew: true,
          meta: {
            reference: txRef,
            amount: amt,
            accountId: fbAccountId || null,
            accountName: fbAccountName || null,
            fallbackReason,
            closingBalance: newWalletBalance,
          }
        });

        return {
          success: true,
          fallback: true,
          reason: fallbackReason,
          groupName: groupName || "Personal Wallet",
          memberPhone: mPhone,
          accountId: fbAccountId || null,
          accountName: fbAccountName || null,
          amount: amt,
          topUp: { success: true, balance: newWalletBalance },
          statement: {
            reference: txRef,
            type: "wallet_deposit_fallback",
            amount: amt,
            closingBalance: newWalletBalance,
            date: new Date().toISOString(),
            status: "completed"
          }
        };
      };

      // =========================================================================
      // STAGE 1 — locate the group across all DB shapes (Flat, Structured
      // Hierarchy, and Dynamic Constituency Array [doc.Ugenya = ['Ward', groupObj]]).
      // =========================================================================
      const locateGroupDoc = async (col) => {
        // 1. Flat root match
        const direct = await col.findOne({
          $or: [
            { groupName: groupName },
            { groupKey: targetGroupNorm },
            { groupId: groupName },
            { accountNumber: groupName }
          ]
        });
        if (direct && (direct.groupName || direct.groupKey || direct.groupId)) {
          return { doc: direct, isNested: false, layout: "flat", groupData: direct, col };
        }

        // 2. Structured hierarchy (e.g. groups-members: constituencies[].wards[].data[])
        const structDocs = await col.find({ "constituencies.wards.data": { $exists: true } }).toArray();
        for (const countyDoc of structDocs) {
          if (!countyDoc || !Array.isArray(countyDoc.constituencies)) continue;
          for (let i = 0; i < countyDoc.constituencies.length; i++) {
            const cons = countyDoc.constituencies[i];
            if (!cons || !Array.isArray(cons.wards)) continue;
            for (let j = 0; j < cons.wards.length; j++) {
              const ward = cons.wards[j];
              if (!ward || !Array.isArray(ward.data)) continue;
              for (let k = 0; k < ward.data.length; k++) {
                const g = ward.data[k];
                const gName = normalizeGroupName(g?.groupName);
                const gId = normalizeGroupName(g?.groupId);
                const gAcc = normalizeGroupName(g?.accountNumber);
                if (
                  g &&
                  (gName === targetGroupNorm ||
                   gId === targetGroupNorm ||
                   gAcc === targetGroupNorm ||
                   gName.replace(/\s*\d+$/, "") === targetGroupNorm.replace(/\s*\d+$/, "") ||
                   String(g.groupName || "").trim().toLowerCase() === String(groupName || "").trim().toLowerCase())
                ) {
                  return {
                    doc: countyDoc,
                    isNested: true,
                    layout: "structured_hierarchy",
                    nestedLocation: { cIdx: i, wIdx: j, gIdx: k, groupData: g },
                    groupData: g,
                    col
                  };
                }
              }
            }
          }
        }

        // 3. Dynamic constituency array layout (e.g. groups collection: doc[constituency] = ['ward', groupObj])
        const allDocs = await col.find({}).toArray();
        for (const doc of allDocs) {
          if (!doc) continue;
          for (const key in doc) {
            if (key === "_id" || key === "county" || key === "countyId" || key === "countryTransaction" || key === "syncedAt" || key === "createdAt" || key === "updatedAt") continue;
            const items = doc[key];
            if (!Array.isArray(items)) continue;
            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx];
              if (item && typeof item === "object" && !Array.isArray(item)) {
                const gName = normalizeGroupName(item.groupName);
                const gId = normalizeGroupName(item.groupId);
                const gAcc = normalizeGroupName(item.accountNumber);
                if (
                  gName === targetGroupNorm ||
                  gId === targetGroupNorm ||
                  gAcc === targetGroupNorm ||
                  gName.replace(/\s*\d+$/, "") === targetGroupNorm.replace(/\s*\d+$/, "") ||
                  String(item.groupName || "").trim().toLowerCase() === String(groupName || "").trim().toLowerCase()
                ) {
                  return {
                    doc,
                    isNested: true,
                    layout: "dynamic_constituency",
                    constituencyKey: key,
                    itemIndex: idx,
                    groupData: item,
                    col
                  };
                }
              }
            }
          }
        }

        return null;
      };

      // =========================================================================
      // Group existence gate — a group must be found in BOTH the `groups`
      // collection AND the `groups-members` collection before any member or
      // account-level verification is attempted. If `groups` doesn't have it,
      // `groups-members` is never even queried — we stop immediately and
      // fall back to crediting the payer's personal wallet.
      // =========================================================================
      const verifyGroupAcrossCollections = async () => {
        // 1. Verify group in `groups` collection first
        const locatedInGroups = await locateGroupDoc(groupsCol);
        if (!locatedInGroups) {
          // Not found in `groups` -> stop here, do NOT query groups-members
          // or run any member verification. Fallback only.
          return { ok: false, reason: "GROUP_NOT_FOUND_IN_GROUPS" };
        }

        // 2. Only if found in `groups`, proceed to also verify from `groups-members`
        const locatedInMembersCol = await locateGroupDoc(membersCol);
        if (!locatedInMembersCol) {
          return { ok: false, reason: "GROUP_NOT_FOUND_IN_GROUPS_MEMBERS" };
        }

        return { ok: true, locatedInGroups, locatedInMembersCol };
      };

      const groupCheck = await verifyGroupAcrossCollections();
      if (!groupCheck.ok) {
        return await fallbackToPersonalWallet(groupCheck.reason, payAmount);
      }
      const { locatedInGroups, locatedInMembersCol } = groupCheck;

      // =========================================================================
      // Member verification gate — verified strictly against the
      // `groups-members` collection only. Match the payer's phone number
      // against the member's `memberId` (primary), falling back to
      // phone/phoneNumber field and the map key itself. The `groups`
      // collection is not consulted here at all (it's already been used to
      // confirm the group itself exists, in the group-existence gate above).
      // =========================================================================
      const targetGroupData = locatedInMembersCol.groupData || locatedInGroups.groupData;
      const groupDoc = locatedInMembersCol.doc || locatedInGroups.doc;

      const verifyMemberInGroupMembers = () => {
        const membersColMembers = locatedInMembersCol.groupData?.members || {};

        let memberKey = null;
        let memberRecord = null;

        // Match: phone number vs memberId (primary), map key, phone/phoneNumber
        for (const [key, mem] of Object.entries(membersColMembers)) {
          const idNorm = normalizePhone(mem?.memberId);
          const keyNorm = normalizePhone(key);
          const phoneNorm = normalizePhone(mem?.phone || mem?.phoneNumber);
          if (idNorm === mPhone || keyNorm === mPhone || phoneNorm === mPhone) {
            memberKey = key;
            memberRecord = mem;
            break;
          }
        }

        if (!memberRecord) {
          return { ok: false, reason: "MEMBER_NOT_IN_GROUP" };
        }

        return { ok: true, memberKey, memberRecord };
      };

      const memberCheck = verifyMemberInGroupMembers();
      if (!memberCheck.ok) {
        return await fallbackToPersonalWallet(memberCheck.reason, payAmount);
      }
      const { memberKey, memberRecord } = memberCheck;

      // =========================================================================
      // STAGE 3 — verify EACH selected account BY NAME against the group's known
      // account schema (`groupaccoutverify`), independently.
      // =========================================================================
      const memberAccounts = memberRecord?.accounts || targetGroupData.members?.[memberKey]?.accounts || {};
      const accountSchemaMap = {
        ...(memberAccounts || {}),
        ...(locatedInMembersCol.groupData?.accountSchema || {}),
        ...(locatedInGroups.groupData?.accountSchema || {}),
        ...(groupDoc.accountSchema || {})
      };
      const otherContribList =
        locatedInMembersCol.groupData?.principles?.otherContributions ||
        locatedInGroups.groupData?.principles?.otherContributions ||
        groupDoc.principles?.otherContributions ||
        [];
      const normStr = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

      const verifiedLines = [];
      const fallbackResults = [];

      for (const line of lines) {
        const rawAccId = String(line.accountId || "001");
        const accIdTrim = rawAccId.replace(/^0+/, "") || "0";
        const accIdPadded = rawAccId.padStart(3, "0");

        const schemaEntry =
          accountSchemaMap[rawAccId] ||
          accountSchemaMap[accIdTrim] ||
          accountSchemaMap[accIdPadded];

        const listEntry = otherContribList.find(a => {
          const aNum = String(a.accountNumber || a.accountId || "");
          return aNum === rawAccId ||
                 aNum.replace(/^0+/, "") === accIdTrim ||
                 aNum.padStart(3, "0") === accIdPadded;
        });

        const registeredAccountName = schemaEntry?.accountName || listEntry?.accountName || null;

        if (!schemaEntry && !listEntry) {
          fallbackResults.push(await fallbackToPersonalWallet("ACCOUNT_NOT_FOUND_IN_GROUP", line.amount, line.accountId, line.accountName));
          continue;
        }

        // Validate account name flexibly if supplied
        const clientNameNorm = normStr(line.accountName);
        const regNameNorm = normStr(registeredAccountName);
        const nameMatches = !clientNameNorm || !regNameNorm ||
                            clientNameNorm === regNameNorm ||
                            clientNameNorm.includes(regNameNorm) ||
                            regNameNorm.includes(clientNameNorm);

        if (!nameMatches) {
          fallbackResults.push(await fallbackToPersonalWallet("ACCOUNT_NAME_MISMATCH", line.amount, line.accountId, line.accountName));
          continue;
        }

        verifiedLines.push({
          ...line,
          resolvedAccountName: registeredAccountName || line.accountName || "Saving",
        });
      }

      if (!verifiedLines.length) {
        return {
          success: true,
          fallback: true,
          reason: "ALL_ACCOUNTS_FAILED_VERIFICATION",
          groupName: targetGroupData.groupName || groupName,
          memberPhone: mPhone,
          amount: payAmount,
          lines: fallbackResults,
        };
      }

      // =========================================================================
      // STAGE 4 — Update openingBalance, amountIn, closingBalance, accountVerified,
      // and write transaction structure to group documents.
      // =========================================================================
      const principlesSetAt = targetGroupData.principlesSetAt || groupDoc?.principlesSetAt || targetGroupData.createdAt || new Date().toISOString();
      const intervals = targetGroupData.principles?.intervals || groupDoc?.principles?.intervals || {};
      const circleInfo = calculateActiveCircle(principlesSetAt, intervals);
      const nowIso = new Date().toISOString();
      const nowDate = new Date(nowIso);
      const numOr0 = (v) => (typeof v === "number" && !Number.isNaN(v)) ? v : 0;

      const memLoc = locatedInMembersCol;
      const memPrefix = memLoc.isNested && memLoc.nestedLocation
        ? `constituencies.${memLoc.nestedLocation.cIdx}.wards.${memLoc.nestedLocation.wIdx}.data.${memLoc.nestedLocation.gIdx}.`
        : "";

      const acctState = {};
      const getAcctState = (accId) => {
        if (!acctState[accId]) {
          const prev = targetGroupData.members?.[memberKey]?.accounts?.[accId]?.financials ||
                       memberRecord?.accounts?.[accId]?.financials || {};
          const c = numOr0(prev.closingBalance);
          acctState[accId] = { openingInitial: c, amountInRunning: numOr0(prev.amountIn), closingRunning: c };
        }
        return acctState[accId];
      };

      const acctWiseState = {};
      const getAcctWiseState = (accId) => {
        if (!acctWiseState[accId]) {
          const prev = targetGroupData.groupFinancials?.accountWise?.[accId] || {};
          const c = numOr0(prev.closingBalance != null ? prev.closingBalance : prev.totalClosingBalance);
          acctWiseState[accId] = { openingInitial: c, amountInRunning: numOr0(prev.amountIn), totalAmountInRunning: numOr0(prev.totalAmountIn), closingRunning: c };
        }
        return acctWiseState[accId];
      };

      const memberPrevFin = targetGroupData.members?.[memberKey]?.memberFinancials || memberRecord?.memberFinancials || {};
      const memberOpeningInitial = numOr0(memberPrevFin.closingBalance);
      let memberAmountInRunning = numOr0(memberPrevFin.amountIn);
      let memberClosingRunning = memberOpeningInitial;

      const groupPrevFin = targetGroupData.groupFinancials || {};
      const groupOpeningInitial = numOr0(groupPrevFin.totalClosingBalance);
      let groupAmountInRunning = numOr0(groupPrevFin.totalAmountIn);
      let groupClosingRunning = groupOpeningInitial;

      // Per-account real-time round-state lookup (memoized) — the ONLY thing
      // Stage 4 does with rounds is read whichever one comes back "active"
      // from computeLiveRoundStatuses. No date math happens here.
      //
      // Self-healing: if an account has no rounds yet (never generated) or
      // its cycle is otherwise unusable, we build one now via
      // buildDateIntervalCycle instead of falling through to the old
      // elapsed-time index forever — the fresh cycle is persisted below so
      // every subsequent contribution finds real rounds already in place.
      const acctRoundState = {};
      const regeneratedCycles = {}; // accId -> newly-built cycle, flushed into setFields below
      const getAcctRoundState = (accId) => {
        if (!acctRoundState[accId]) {
          let cycle = targetGroupData.members?.[memberKey]?.accounts?.[accId]?.dateIntervalCycle ||
                        memberRecord?.accounts?.[accId]?.dateIntervalCycle || {};
          if (!Array.isArray(cycle.rounds) || cycle.rounds.length === 0) {
            cycle = buildDateIntervalCycle(principlesSetAt, intervals);
            regeneratedCycles[accId] = cycle;
            console.warn(`[applyAtomicGroupMemberContribution] No rounds found for account ${accId} (group "${groupName}") — generating a fresh cycle.`);
          }
          const originalRounds = Array.isArray(cycle.rounds) ? cycle.rounds : [];
          const liveRounds = computeLiveRoundStatuses(originalRounds, cycle.endDate, nowDate);
          const activeIndex = liveRounds.findIndex((r) => r.status === "active");
          acctRoundState[accId] = {
            originalRounds,
            liveRounds,
            activeIndex,
            activeRound: activeIndex >= 0 ? liveRounds[activeIndex] : null,
          };
        }
        return acctRoundState[accId];
      };

      const accIdToName = {};
      const pushByAccount = {};
      const txObjects = [];

      for (const line of verifiedLines) {
        const { accountId: accId, resolvedAccountName, amount: lineAmt } = line;
        accIdToName[accId] = resolvedAccountName;

        const as = getAcctState(accId);
        const lineOpening = as.closingRunning;
        as.amountInRunning += lineAmt;
        as.closingRunning = lineOpening + lineAmt;

        const memberLineOpening = memberClosingRunning;
        memberAmountInRunning += lineAmt;
        memberClosingRunning = memberLineOpening + lineAmt;

        const aw = getAcctWiseState(accId);
        aw.amountInRunning += lineAmt;
        aw.totalAmountInRunning += lineAmt;
        aw.closingRunning += lineAmt;

        groupAmountInRunning += lineAmt;
        groupClosingRunning += lineAmt;

        const rs = getAcctRoundState(accId);
        // Prefer the live-computed active round's own roundNumber; fall back
        // to the legacy elapsed-time calculator only if no round's window
        // covers today (e.g. cycle not yet started / already fully closed).
        const effectiveRoundNumber = rs.activeRound?.roundNumber ?? circleInfo.roundNumber;

        const txObject = {
          txId: verifiedLines.length > 1 ? `${txRef}_${accId}` : txRef,
          reference: txRef,
          groupName: targetGroupData.groupName || groupName,
          accountId: accId,
          accountName: resolvedAccountName,
          amount: lineAmt,
          openingBalance: lineOpening,
          closingBalance: as.closingRunning,
          date: nowIso,
          paymentMethod,
          payerPhone: pPhone,
          memberPhone: mPhone,
          circleRound: effectiveRoundNumber,
          type: "credit",
          status: "completed"
        };
        txObjects.push(txObject);

        if (!pushByAccount[accId]) pushByAccount[accId] = [];
        pushByAccount[accId].push(txObject);
      }

      // Write updates to groups-members collection
      const setFields = {};
      const pushFields = {};

      for (const [accId, as] of Object.entries(acctState)) {
        setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.accountVerified`] = accIdToName[accId];
        setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.accountName`] = accIdToName[accId];
        setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.financials.openingBalance`] = as.openingInitial;
        setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.financials.amountIn`] = as.amountInRunning;
        setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.financials.closingBalance`] = as.closingRunning;
      }
      for (const [accId, aw] of Object.entries(acctWiseState)) {
        setFields[`${memPrefix}groupFinancials.accountWise.${accId}.openingBalance`] = aw.openingInitial;
        setFields[`${memPrefix}groupFinancials.accountWise.${accId}.amountIn`] = aw.amountInRunning;
        setFields[`${memPrefix}groupFinancials.accountWise.${accId}.totalAmountIn`] = aw.totalAmountInRunning;
        setFields[`${memPrefix}groupFinancials.accountWise.${accId}.closingBalance`] = aw.closingRunning;
        setFields[`${memPrefix}groupFinancials.accountWise.${accId}.totalClosingBalance`] = aw.closingRunning;
      }
      setFields[`${memPrefix}members.${memberKey}.memberFinancials.openingBalance`] = memberOpeningInitial;
      setFields[`${memPrefix}members.${memberKey}.memberFinancials.amountIn`] = memberAmountInRunning;
      setFields[`${memPrefix}members.${memberKey}.memberFinancials.closingBalance`] = memberClosingRunning;
      setFields[`${memPrefix}groupFinancials.totalOpeningBalance`] = groupOpeningInitial;
      setFields[`${memPrefix}groupFinancials.totalAmountIn`] = groupAmountInRunning;
      setFields[`${memPrefix}groupFinancials.totalClosingBalance`] = groupClosingRunning;
      setFields[memLoc.isNested ? "syncedAt" : "updatedAt"] = nowIso;

      for (const [accId, txArr] of Object.entries(pushByAccount)) {
        const historyPath = `${memPrefix}members.${memberKey}.accounts.${accId}.transactionHistory`;
        pushFields[historyPath] = txArr.length > 1 ? { $each: txArr } : txArr[0];

        const rs = getAcctRoundState(accId);

        if (regeneratedCycles[accId]) {
          // Freshly-built cycle for an account that had none — persist it
          // with LIVE-corrected statuses (rs.liveRounds), not the raw
          // "pending for everyone" shape buildDateIntervalCycle returns, so
          // the round that's actually active today reads "active" right
          // away instead of waiting for a later contribution to fix it up.
          setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.dateIntervalCycle`] = {
            ...regeneratedCycles[accId],
            rounds: rs.liveRounds,
          };
        } else {
          // Real-time round-state sync: write any round whose live-computed
          // status differs from what's stored (pending -> active -> closed),
          // purely from comparing scheduledDate windows against `nowDate`.
          rs.liveRounds.forEach((liveRound, idx) => {
            const storedStatus = rs.originalRounds[idx]?.status;
            if (storedStatus !== liveRound.status) {
              setFields[`${memPrefix}members.${memberKey}.accounts.${accId}.dateIntervalCycle.rounds.${idx}.status`] = liveRound.status;
            }
          });
        }

        // A cycle now always has real rounds (existing or freshly built), so
        // there should always be an active one. If not — every round's
        // window has actually elapsed (cycle ran out) — log it distinctly
        // from the old "rounds don't exist" case instead of guessing an index.
        if (rs.activeIndex >= 0) {
          const rpPath = `${memPrefix}members.${memberKey}.accounts.${accId}.dateIntervalCycle.rounds.${rs.activeIndex}.accountroundPerformance`;
          const perfEntries = txArr.map((tx) => ({
            memberId: mPhone,
            openingBalance: Number(tx.openingBalance || 0),
            amountIn: Number(tx.amount || 0),
            amountOut: 0,
            closingBalance: Number(tx.closingBalance || 0),
            transactionCode: tx.txId,
            transactionDate: tx.date,
            roundNumber: tx.circleRound,
            accountId: tx.accountId,
          }));
          pushFields[rpPath] = perfEntries.length > 1 ? { $each: perfEntries } : perfEntries[0];
        } else {
          console.warn(`[applyAtomicGroupMemberContribution] Cycle exhausted for account ${accId} (group "${groupName}") — every round's window has passed. Contribution recorded in transactionHistory only; the cycle needs to be renewed.`);
        }
      }

      await membersCol.updateOne({ _id: locatedInMembersCol.doc._id }, { $set: setFields, $push: pushFields });

      // Synchronize groups collection as well
      try {
        const grpLoc = locatedInGroups;
        const grpSetFields = {};
        if (grpLoc.layout === "dynamic_constituency") {
          const gPrefix = `${grpLoc.constituencyKey}.${grpLoc.itemIndex}.`;
          grpSetFields[`${gPrefix}groupFinancials.totalClosingBalance`] = groupClosingRunning;
          grpSetFields[`${gPrefix}updatedAt`] = nowIso;
        } else if (grpLoc.layout === "structured_hierarchy" && grpLoc.nestedLocation) {
          const gPrefix = `constituencies.${grpLoc.nestedLocation.cIdx}.wards.${grpLoc.nestedLocation.wIdx}.data.${grpLoc.nestedLocation.gIdx}.`;
          grpSetFields[`${gPrefix}groupFinancials.totalClosingBalance`] = groupClosingRunning;
          grpSetFields[`${gPrefix}updatedAt`] = nowIso;
        }
        if (Object.keys(grpSetFields).length > 0) {
          await groupsCol.updateOne({ _id: locatedInGroups.doc._id }, { $set: grpSetFields });
        }
      } catch (grpSyncErr) {
        console.warn("[applyAtomicGroupMemberContribution] groups sync notice:", grpSyncErr.message);
      }

      // Synchronize regional blocks asynchronously via high-throughput batch queue
      const verifiedTotal = verifiedLines.reduce((s, l) => s + l.amount, 0);
      try {
        enqueueRegionalTransaction({
          txRef,
          nowIso,
          paymentMethod,
          mPhone,
          pPhone,
          groupName,
          targetGroupData,
          locatedInMembersCol,
          verifiedLines,
          verifiedTotal,
        });
      } catch (regSyncErr) {
        console.warn("[applyAtomicGroupMemberContribution] regional queue notice:", regSyncErr.message);
      }

      // Update PersonalAccount statement
      let personalRunning = 0;
      const personalStatements = [];
      await mutatePersonalLeaves(
        (r) => normalizePhone(r.phone) === mPhone,
        (rec) => {
          if (!rec.account) rec.account = {};
          if (!rec.account.personal) {
            rec.account.personal = { personal: 0, openBalance: 0, pendingBalance: 0, reg_fee: 0 };
          }
          personalRunning = Number(rec.account.personal.openBalance || 0);
          if (!rec.transactions) rec.transactions = [];

          for (const line of verifiedLines) {
            const opening = personalRunning;
            const closing = opening + line.amount;
            personalRunning = closing;
            const entry = {
              reference: verifiedLines.length > 1 ? `${txRef}_${line.accountId}` : txRef,
              time: new Date(),
              openingBalance: opening,
              amount: line.amount,
              type: "group_contribution",
              from: { name: "Personal Account", number: mPhone },
              to: { name: targetGroupData.groupName || groupName, number: line.accountId },
              closingBalance: closing,
              environment: paymentMethod,
              notes: notes || `Group contribution to ${targetGroupData.groupName || groupName} (${line.resolvedAccountName})`,
              status: "completed",
            };
            rec.transactions.push(entry);
            personalStatements.push(entry);
          }
          rec.updatedAt = new Date();
          return rec;
        }
      );

      // Send confirmation notification message
      const accountsSummary = verifiedLines.map(l => l.resolvedAccountName).join(", ");
      await saveMessageToMongo({
        to: mPhone,
        groupName: targetGroupData.groupName || groupName,
        type: "group_contribution_success",
        title: "Group Contribution Received",
        content: `Received KES ${verifiedTotal.toLocaleString()} for ${targetGroupData.groupName || groupName} (${accountsSummary}, Round #${circleInfo.roundNumber}). Ref: ${txRef}.`,
        createdAt: nowIso,
        isNew: true,
        meta: {
          reference: txRef,
          amount: verifiedTotal,
          groupName: targetGroupData.groupName || groupName,
          accounts: verifiedLines.map(l => ({ accountId: l.accountId, accountName: l.resolvedAccountName, amount: l.amount })),
          circleRound: circleInfo.roundNumber,
        }
      });

      return {
        success: true,
        fallback: fallbackResults.length > 0,
        partial: fallbackResults.length > 0 && verifiedLines.length > 0,
        groupName: targetGroupData.groupName || groupName,
        memberPhone: mPhone,
        amount: payAmount,
        verifiedAmount: verifiedTotal,
        fallbackAmount: payAmount - verifiedTotal,
        circleRound: circleInfo.roundNumber,
        lines: {
          verified: txObjects.map(t => ({ accountId: t.accountId, accountName: t.accountName, amount: t.amount, txId: t.txId })),
          fallback: fallbackResults,
        },
        statement: personalStatements.length === 1 ? personalStatements[0] : personalStatements,
      };
    } catch (err) {
      if (txRef) processedGroupTxIds.delete(txRef);
      console.error("[applyAtomicGroupMemberContribution] Error:", err.message);
      return { success: false, reason: err.message };
    }
  });
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
  findAgentByPhone,
  findDealerByPhone,
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
  findGroupNameInMongoGroupsCollection,
  findGroupNameInGroupsMembersCollection,
  createPerformanceIndexes,
  cleanupStaleGroupKeys,
  fixGroupKeyIndex,
  saveTbankSettings,
  getTbankSettings,
  PendingAccount,
  flattenPendingAccountDoc,
  getAllPendingFlattened,
  savePendingAccountToMongo,
  findPendingRecord,
  deletePendingRecord,
  deleteAllPendingRecords,
  updatePendingRecord,
  upsertPendingAccount,
  mutatePendingLeaves,
  flattenPersonalAccountDoc,
  getAllPersonalFlattened,
  findPersonalAccountByPhone,
  savePersonalAccountToMongo,
  mutatePersonalLeaves,
  findPersonalRecord,
  updatePersonalRecord,
  upsertPersonalAccount,
  calculateActiveCircle,
  buildDateIntervalCycle,
  computeLiveRoundStatuses,
  applyAtomicGroupMemberContribution,
  updateRegionalHierarchyTransactions,
  enqueueRegionalTransaction,
  getRegionalQueueStats,
};

const findGroupMemberTransactions = async (phone) => {
  const ready = await ensureMongoReady();
  if (!ready || mongoose.connection.readyState !== 1) return [];

  try {
    const db = mongoose.connection.db;
    const membersCol = db.collection("groups-members");
    const groupsCol = db.collection("groups");
    const personalAccountCol = db.collection("PersonalAccount");
    const rawPhone = String(phone || '').trim();
    const nPhone = normalizePhone(rawPhone);
    if (!nPhone) return [];

    const phoneVariants = [
      rawPhone,
      nPhone,
      `0${nPhone}`,
      `254${nPhone}`,
      `+254${nPhone}`
    ];

    const txns = [];
    const groupMembers = [];

    // Helper to process a group object
    const processGroupObj = (g, source) => {
      if (!g) return;
      const gName = g.groupName || g.groupId || "Group Account";

      // 1. Check transactionHistory array
      if (Array.isArray(g.transactionHistory)) {
        g.transactionHistory.forEach(tx => {
          const mP = normalizePhone(tx.memberPhone);
          const pP = normalizePhone(tx.payerPhone);
          if (mP === nPhone || pP === nPhone || phoneVariants.includes(tx.memberPhone) || phoneVariants.includes(tx.payerPhone)) {
            txns.push({
              code: tx.txId || tx.reference || tx.code || "",
              amt: Number(tx.amount || 0),
              date: tx.date || tx.time || new Date().toISOString(),
              type: "group_deposit",
              groupName: gName,
              acc: `Group ${gName} (Account ${tx.accountId || '001'} - ${tx.accountName || 'Saving'})`,
              accountId: tx.accountId || "001",
              accountName: tx.accountName || "Saving",
              from: tx.payerPhone || tx.memberPhone || rawPhone,
              fromNumber: tx.payerPhone || tx.memberPhone || rawPhone,
              to: gName,
              toNumber: gName,
              circleRound: tx.circleRound || 1,
              source: source || "groups-members"
            });
          }
        });
      }

      // 2. Check members map / object
      if (g.members && typeof g.members === "object") {
        for (const [key, mem] of Object.entries(g.members)) {
          const idNorm = normalizePhone(mem && mem.memberId);
          const keyNorm = normalizePhone(key);
          const phoneNorm = normalizePhone(mem && (mem.phone || mem.phoneNumber));
          if (keyNorm === nPhone || phoneVariants.includes(key) || idNorm === nPhone || phoneVariants.includes(mem?.memberId) || phoneNorm === nPhone || phoneVariants.includes(mem?.phone)) {
            if (mem) {
              groupMembers.push({
                groupName: gName,
                groupId: g.groupId || g.accountNumber || "",
                memberId: mem.memberId || key,
                name: mem.name || "",
                phone: mem.phone || mem.phoneNumber || rawPhone,
                memberFinancials: mem.memberFinancials || {
                  openingBalance: 0,
                  amountIn: 0,
                  amountOut: 0,
                  closingBalance: 0
                },
                accounts: mem.accounts || {},
                dateIntervalCycle: mem.dateIntervalCycle || g.dateIntervalCycle || g.groupFinancials?.dateIntervalCycle || {},
                transactions: Array.isArray(mem.transactions) ? mem.transactions : [],
                transactionHistory: Array.isArray(mem.transactionHistory) ? mem.transactionHistory : [],
                source: source || "groups-members"
              });
            }

            if (mem && Array.isArray(mem.transactions)) {
              mem.transactions.forEach(tx => {
                txns.push({
                  code: tx.txId || tx.reference || tx.code || "",
                  amt: Number(tx.amount || 0),
                  date: tx.date || tx.time || new Date().toISOString(),
                  type: "group_deposit",
                  groupName: gName,
                  acc: `Group ${gName} (Account ${tx.accountId || '001'} - ${tx.accountName || 'Saving'})`,
                  accountId: tx.accountId || "001",
                  accountName: tx.accountName || "Saving",
                  from: rawPhone,
                  fromNumber: rawPhone,
                  to: gName,
                  toNumber: gName,
                  circleRound: tx.circleRound || 1,
                  source: source || "groups-members"
                });
              });
            }

            // 2b. Each verified account has its own transactionHistory — this is
            // where applyAtomicGroupMemberContribution records contributions once
            // the group/member/account-name checks pass, complete with
            // accountVerified and opening/closing balance. Surface it here too,
            // so it actually shows up in the member's statement.
            if (mem && mem.accounts && typeof mem.accounts === "object") {
              for (const [accId, acc] of Object.entries(mem.accounts)) {
                if (!acc || !Array.isArray(acc.transactionHistory)) continue;
                acc.transactionHistory.forEach(tx => {
                  const trustedAccountName = acc.accountVerified || acc.accountName || tx.accountName || "Saving";
                  txns.push({
                    code: tx.txId || tx.reference || tx.code || "",
                    amt: Number(tx.amount || 0),
                    date: tx.date || tx.time || new Date().toISOString(),
                    type: "group_deposit",
                    groupName: gName,
                    acc: `Group ${gName} (Account ${accId} - ${trustedAccountName})`,
                    accountId: accId,
                    accountName: trustedAccountName,
                    accountVerified: acc.accountVerified || null,
                    from: tx.payerPhone || rawPhone,
                    fromNumber: tx.payerPhone || rawPhone,
                    to: gName,
                    toNumber: gName,
                    circleRound: tx.circleRound || 1,
                    opening: Number(tx.openingBalance ?? 0),
                    closing: Number(tx.closingBalance ?? 0),
                    source: source ? `${source}-account` : "groups-members-account"
                  });
                });
              }
            }
          }
        }
      }
    };

    // 1. Search root and nested in `groups-members`
    const memberDocs = await membersCol.find({}).toArray();
    memberDocs.forEach(doc => {
      if (Array.isArray(doc.constituencies)) {
        doc.constituencies.forEach(cons => {
          if (Array.isArray(cons.wards)) {
            cons.wards.forEach(ward => {
              if (Array.isArray(ward.data)) {
                ward.data.forEach(g => processGroupObj(g, "groups-members-nested"));
              }
            });
          }
        });
      } else {
        processGroupObj(doc, "groups-members-root");
      }
    });

    // 2. Search root and nested in `groups`
    const groupDocs = await groupsCol.find({}).toArray();
    groupDocs.forEach(doc => {
      if (Array.isArray(doc.constituencies)) {
        doc.constituencies.forEach(cons => {
          if (Array.isArray(cons.wards)) {
            cons.wards.forEach(ward => {
              if (Array.isArray(ward.data)) {
                ward.data.forEach(g => processGroupObj(g, "groups-nested"));
              }
            });
          }
        });
      } else {
        processGroupObj(doc, "groups-root");
      }
    });

    // Deduplicate group members
    const seenGroups = new Set();
    const uniqueGroupMembers = [];
    groupMembers.forEach(gm => {
      const gKey = `${gm.groupName || ''}_${gm.groupId || ''}_${gm.memberId || ''}`;
      if (!seenGroups.has(gKey)) {
        seenGroups.add(gKey);
        uniqueGroupMembers.push(gm);
      }
    });

    // Deduplicate transactions by reference code or composite key
    const seen = new Set();
    const uniqueTxns = [];
    txns.forEach(t => {
      const key = t.code ? String(t.code).trim() : `${t.groupName}_${t.amt}_${t.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTxns.push(t);
      }
    });

    uniqueTxns.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    uniqueTxns.groupMembers = uniqueGroupMembers;
    uniqueTxns.memberRecords = uniqueGroupMembers;

    return uniqueTxns;
  } catch (e) {
    console.error("[findGroupMemberTransactions error]", e.message);
    return [];
  }
};

module.exports.findGroupMemberTransactions = findGroupMemberTransactions;