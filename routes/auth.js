const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const {
  ensureMongoReady,
  getMongoConfigHint,
  saveUserToMongoDB,
  findUserByPhone,
  updateLastLogin,
  updateUserPassword,
  PersonalAccount,
  Agent,
  Dealer,
  normalizePhone,
  getTbankSettings,
  saveTbankSettings,
  findAgentByPhone,
  findDealerByPhone,
  PendingAccount,
  getAllPendingFlattened,
  findPendingRecord,
  updatePendingRecord,
  deletePendingRecord,
} = require("../mongoose");
const {
  consumeVerifiedRegistration,
  handlePesapalCallback,
  findVerifiedRegistrationByPhone,
  findVerifiedRegistrationByOrderTrackingId,
  getLast5Digits,
  phoneMatchesLast5,
  normPhoneDigits,
} = require("./pesapal");
const { creditPendingToPersonalAccount, settlePendingToPersonal, transferRegistrarFeeToPersonal } = require("./trans");

const router = express.Router();
const tbankFile = path.join(__dirname, "../tbank.json");
const statsFile = path.join(__dirname, "../personal_stats.json");
const regPerfLogger = require("../performance/registration-performance");

/* ================= HELPERS ================= */
const readJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error parsing JSON from ${file}:`, e);
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

/**
 * Normalizes county/constituency/ward strings so they can be used as
 * consistent object keys across personalAccounts, groups, and groups-members.
 * Prevents the same case-sensitivity duplicate-branch bug fixed in general.js.
 */
const normRegionKey = (v) => String(v || "").trim();

/**
 * Creates or updates the MongoDB PersonalAccount document for a phone number.
 *
 * This is the ONLY place a PersonalAccount is written from registration —
 * the old parallel write to p_account/personal.json has been removed. That
 * file write ran before the Mongo save and threw on Render's filesystem,
 * which meant the outer catch swallowed the error and the MongoDB
 * PersonalAccount.save() below it never executed. That's the "database
 * error" that was silently dropping personal accounts.
 *
 * Uses findOneAndUpdate + upsert instead of `new PersonalAccount().save()`
 * so re-submitting /complete-registration (e.g. from the resume-payment
 * popup) updates the existing doc instead of throwing an E11000 duplicate
 * key error on the unique `phone` index.
 *
 * If a registration fee was actually paid (amount > 0), it is added to
 * account.personal.reg_fee and account.personal.personal, and a matching
 * transaction entry is recorded.
 */
const upsertPersonalAccountMongo = async ({
  phone,
  county,
  constituency,
  ward,
  amount,
  paymentMethod,
  reference
}) => {
  const countyKey = normRegionKey(county);
  const constituencyKey = normRegionKey(constituency);
  const wardKey = normRegionKey(ward);
  const paidAmount = Number(amount || 0);
  const now = new Date();

  const existing = await PersonalAccount.findOne({ phone }).lean();
  const prevPersonal = existing?.account?.personal?.personal || 0;
  const prevRegFee = existing?.account?.personal?.reg_fee || 0;
  const newPersonal = prevPersonal + paidAmount;
  const newRegFee = prevRegFee + paidAmount;

  const setFields = {
    county: countyKey,
    constituency: constituencyKey,
    ward: wardKey,
    updatedAt: now,
    "account.personal.reg_fee": newRegFee,
    "account.personal.personal": newPersonal
  };

  const update = {
    $setOnInsert: {
      phone,
      createdAt: now,
      "account.business": { name: "", "total-bal": 0, float: 0, benefit: 0 }
    },
    $set: setFields
  };

  if (paidAmount > 0) {
    update.$push = {
      transactions: {
        reference: reference || "",
        time: now,
        openingBalance: prevPersonal,
        amount: paidAmount,
        type: "received",
        to: { name: "Personal Account", number: phone },
        closingBalance: newPersonal,
        environment: paymentMethod || "unknown",
        notes: "Registration fee"
      }
    };
  }

  try {
    const doc = await PersonalAccount.findOneAndUpdate({ phone }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    });
    console.log(`[REGISTER] Personal account upserted in MongoDB for ${phone} (fee=${paidAmount})`);
    return doc;
  } catch (mongoPersonalErr) {
    console.error("Error upserting personal account in MongoDB:", mongoPersonalErr.message);
    return null;
  }
};

/**
 * 🔄 Rotates the registration passkey after an account is created.
 * This ensures "variation" for each new user.
 */
const rotatePasskey = () => {
  const tbank = readJSON(tbankFile, {});
  if (tbank.compliance?.personal_account_registration) {
    const reg = tbank.compliance.personal_account_registration;
    if (reg.paymentMethod === 'mpesa') {
      reg.passkey = Math.floor(10000 + Math.random() * 90000).toString(); // 5 digits
    } else if (reg.paymentMethod === 'passkey') {
      reg.passkey = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
    }
    reg.updatedAt = new Date().toISOString();
    writeJSON(tbankFile, tbank);
  }
};

/* ================= ROUTES ================= */

/* 🏠 Home → redirect to login */
router.get("/", (req, res) => res.redirect("/login"));

/* 📝 Register (GET form) */
router.get("/register", (req, res) => {
  const qmsg = (req.query.message || "").toString().slice(0, 500);
  res.render("register", {
    message: qmsg || null,
    form: req.query.form ? req.query.form : {},
    resumePayment: null
  });
});

router.get("/register/pesapal-callback", handlePesapalCallback);

/**
 * 🔍 Check if a phone number has an active Pesapal payment session.
 * Called from register.ejs Step 1 "Next" button before advancing.
 * Returns: { found: bool, nonce, fullName, amount, currency, orderTrackingId, registrationDataEncoded }
 */
router.post("/api/check-payment-session", async (req, res) => {
  const phone = String(req.body.phone || "").trim();
  if (!phone) return res.json({ found: false });

  let paymentSession = null;
  try {
    paymentSession = await findVerifiedRegistrationByPhone(req, phone);
  } catch (e) {
    console.error("[api/check-payment-session] findVerifiedRegistrationByPhone threw:", e.message);
    paymentSession = null;
  }
  if (!paymentSession) return res.json({ found: false });

  const regData = typeof paymentSession.registrationData === "string"
    ? (() => { try { return JSON.parse(paymentSession.registrationData); } catch(e) { return {}; } })()
    : (paymentSession.registrationData || {});

  const fullName = [
    regData.FirstName || regData.firstName,
    regData.MiddleName || regData.middleName,
    regData.LastName || regData.lastName
  ].filter(Boolean).join(" ") || "Valued Member";

  return res.json({
    found: true,
    nonce: paymentSession.nonce,
    fullName,
    amount: paymentSession.amount,
    currency: paymentSession.currency || "KES",
    orderTrackingId: paymentSession.orderTrackingId,
    registrationDataEncoded: JSON.stringify(paymentSession.registrationData || {})
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  });
});

/**
 * 🔍 Check if a phone number is already registered in the MongoDB counties
 * collection. Called from register.ejs Step 1 "Next" button BEFORE allowing
 * the user to advance to the regional block (county/constituency/ward picker).
 * Prevents duplicate registrations by redirecting the user to /login with a
 * friendly message instead of letting them re-enter the regional block
 * they've already filled before.
 *
 * Also checks Agent / Dealer / Admin / SuperAdmin collections so no account
 * type can be used to bypass the "already registered" prompt.
 *
 * Returns: { registered: boolean, user?: { firstName, lastName, phoneNumber } }
 */
router.post("/api/check-phone-registered", async (req, res) => {
  const phone = String(req.body.phone || "").trim();
  if (!phone) return res.json({ registered: false });

  let user = null;
  try {
    if (await ensureMongoReady()) {
      user = await findUserByPhone(phone);
    }
  } catch (e) {
    console.error("[api/check-phone-registered] findUserByPhone error:", e.message);
    user = null;
  }

  if (user) {
    return res.json({
      registered: true,
      user: {
        firstName: user.FirstName,
        middleName: user.MiddleName,
        lastName: user.LastName,
        phoneNumber: user.phoneNumber,
      }
    });
  }

  // Also check Agent / Dealer / Admin / SuperAdmin tables — a user might
  // have an account in another role and shouldn't be able to register a
  // duplicate personal account with the same phone.
  try {
    if (await ensureMongoReady()) {
      const { normalizePhone, Agent, Dealer, Admin, SuperAdmin } = require("../mongoose");
      const nPhone = normalizePhone(phone);
      const match = { phoneNumber: nPhone };
      const agent = await Agent && Agent.findOne ? await Agent.findOne(match).lean() : null;
      const dealer = await Dealer && Dealer.findOne ? await Dealer.findOne(match).lean() : null;
      const admin = await Admin && Admin.findOne ? await Admin.findOne(match).lean() : null;
      const superAdmin = await SuperAdmin && SuperAdmin.findOne ? await SuperAdmin.findOne(match).lean() : null;
      const roleMatch = agent || dealer || admin || superAdmin;
      if (roleMatch) {
        const roleName = agent ? "Agent" : dealer ? "Dealer" : admin ? "Admin" : "SuperAdmin";
        return res.json({
          registered: true,
          user: {
            firstName: roleMatch.name ? roleMatch.name.split(" ")[0] : "",
            lastName: roleMatch.name ? roleMatch.name.split(" ").slice(-1)[0] : "",
            phoneNumber: roleMatch.phoneNumber,
          },
          accountRole: roleName,
        });
      }
    }
  } catch (e) {
    console.error("[api/check-phone-registered] role-tables check error:", e.message);
  }

  return res.json({ registered: false });
});

/**
 * 🔍 Check if a phone number exists in the County collection.
 * Called from register.ejs Step 1 "Next" button BEFORE allowing any
 * further registration steps. If found → redirect to /login (existing user).
 *
 * Returns: { found: boolean, county?: string, constituency?: string, ward?: string }
 */
router.post("/api/check-phone-county", async (req, res) => {
  const phone = String(req.body.phone || "").trim();
  if (!phone) return res.json({ found: false });

  try {
    if (!(await ensureMongoReady())) {
      return res.json({ found: false });
    }
    const { verifyPhoneInCounty } = require("./trans");
    const result = await verifyPhoneInCounty(phone);
    return res.json(result);
  } catch (e) {
    console.error("[api/check-phone-county] error:", e.message);
    return res.json({ found: false });
  }
});

/**
 * 🔍 Check if a phone number has an entry in PendingAccount collection
 * with a verified/completed payment status. Returns all PendingAccount
 * fields so the frontend can populate the "Complete Registration" popup
 * with callback data and other stored values.
 *
 * Returns:
 *   { found: false }  OR
 *   { found: true, _id, FirstName, MiddleName, LastName, email, gender,
 *     ageBracket, idNumber, county, constituency, ward, phoneNumber,
 *     amount, currency, orderTrackingId, merchantReference,
 *     paymentMethod, paymentStatusDescription, status, verificationNonce }
 */
router.post("/api/check-phone-pendingaccount", async (req, res) => {
  const phone = String(req.body.phone || "").trim();
  if (!phone) return res.json({ found: false });

  try {
    if (!(await ensureMongoReady()) || !PendingAccount || !getAllPendingFlattened) {
      return res.json({ found: false });
    }

    const { normalizePhone } = require("../mongoose");
    const target = normalizePhone(phone);
    const targetLast5 = getLast5Digits(phone);

    const statuses = [
      "VERIFIED_PENDING_COMPLETION",
      "COMPLETED",
      "INITIATED",
      "PAID",
    ];

    let pending = null;

    const allRecent = await getAllPendingFlattened({
      newerThanMs: 20 * 60 * 1000,
      filter: (r) => statuses.includes(String(r.status || "")),
    });

    const firstExact = allRecent.find((r) => {
      const pRaw = r.phoneNumber || "";
      return String(pRaw) === phone || normalizePhone(String(pRaw)) === target;
    });
    pending = firstExact || null;

    if (!pending && targetLast5) {
      pending = allRecent.find((r) => phoneMatchesLast5(r.phoneNumber || "", phone)) || null;
      if (pending) {
        console.log(
          `[api/check-phone-pendingaccount] Matched via LAST-5: input=${phone} vs db.phone=${pending.phoneNumber}`
        );
      }
    }

    if (!pending) {
      return res.json({ found: false });
    }

    const statusOk =
      Number(pending.statusCode) === 1 ||
      String(pending.statusCode || "").toUpperCase() === "COMPLETED" ||
      String(pending.paymentStatusDescription || "").toUpperCase() ===
        "COMPLETED" ||
      String(pending.status || "").toUpperCase() !== "FAILED";

    if (!statusOk && String(pending.status || "").toUpperCase() === "FAILED") {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      _id: pending._id,
      FirstName: pending.FirstName,
      MiddleName: pending.MiddleName,
      LastName: pending.LastName,
      email: pending.email,
      gender: pending.gender,
      ageBracket: pending.ageBracket,
      idNumber: pending.idNumber,
      county: pending.county,
      constituency: pending.constituency,
      ward: pending.ward,
      phoneNumber: pending.phoneNumber,
      password: undefined,
      passkey: undefined,
      startky: undefined,
      amount: pending.amount,
      chargedAmount: pending.chargedAmount,
      currency: pending.currency || "KES",
      orderTrackingId: pending.orderTrackingId,
      merchantReference: pending.merchantReference,
      paymentMethod: pending.paymentMethod,
      paymentAccount: pending.paymentAccount,
      confirmationCode: pending.confirmationCode,
      paymentStatusDescription: pending.paymentStatusDescription,
      status: pending.status,
      verificationNonce: pending.verificationNonce,
      orderId: pending.orderId,
    });
  } catch (e) {
    console.error("[api/check-phone-pendingaccount] error:", e.message);
    return res.json({ found: false });
  }
});

/**
 * ✅ Finalize a registration from an existing PendingAccount record
 * (accepted from the frontend "Complete Registration" popup).
 *
 * 🔒 SECURITY: Every value used to create the County member + PersonalAccount
 * transaction is RE-READ from the PendingAccount document server-side. The
 * client only sends a *lookup key* (_id / orderTrackingId / phoneNumber),
 * and even that key is cross-validated against the other fields. No user-
 * editable popup content (hidden inputs, text content) is ever trusted.
 *
 * Steps performed:
 *   1. Load PendingAccount doc. If duplicate keys sent, require them ALL to
 *      resolve to the SAME document (cross-key tamper check).
 *   2. Validate payment status ∈ {VERIFIED_PENDING_COMPLETION, PAID, COMPLETED}
 *      and amount > 0 (FAILED/INITIATED-only records are rejected).
 *   3. Re-validate every required field *directly from the PendingAccount* doc.
 *   4. Dedup: if user already in County → DELETE pending doc → success.
 *   5. Save member to County collection.
 *   6. Registrar → Personal transfer (uses PendingAccount amount/region only).
 *   7. DELETE the PendingAccount document (not just mark COMPLETED) so it
 *      can never be replayed or re-consumed.
 *   8. Rotate passkey + log performance → redirect client to /login.
 *
 * Returns: { success: boolean, message?: string }
 */
router.post("/api/complete-from-pendingaccount", async (req, res) => {
  const rawBody = req.body || {};
  const { pendingAccountId, orderTrackingId, phoneNumber } = rawBody;
  const normInputPhone = norm(phoneNumber || "");

  if (!pendingAccountId && !orderTrackingId && !normInputPhone) {
    return res.status(400).json({
      success: false,
      message: "Pending account identifier missing.",
    });
  }

  // Allow only explicitly named fields. Reject any payload with extra keys
  // or stringified-object values that might bypass validation via coercion.
  const ALLOWED_KEYS = new Set(["pendingAccountId", "orderTrackingId", "phoneNumber"]);
  for (const k of Object.keys(rawBody)) {
    if (!ALLOWED_KEYS.has(k)) {
      return res.status(400).json({
        success: false,
        message: "Unrecognized field in request.",
      });
    }
    if (typeof rawBody[k] !== "string" && typeof rawBody[k] !== "undefined") {
      return res.status(400).json({
        success: false,
        message: "Invalid field type in request.",
      });
    }
    if (typeof rawBody[k] === "string" && rawBody[k].length > 120) {
      return res.status(400).json({
        success: false,
        message: "Field value too long.",
      });
    }
  }

  try {
    if (!(await ensureMongoReady())) {
      return res.status(500).json({
        success: false,
        message: "Database unavailable. Please try again.",
      });
    }

    const { normalizePhone } = require("../mongoose");
    const ObjectId = mongoose.Types.ObjectId;
    const validStatuses = new Set([
      "VERIFIED_PENDING_COMPLETION",
      "PAID",
      "COMPLETED",
    ]);

    // ---- Step 1a: load candidate PendingAccount by each provided key ----
    async function loadPendingBy(key, value) {
      if (!value) return null;
      if (!getAllPendingFlattened || !findPendingRecord) return null;

      const statusArr = Array.from(validStatuses);
      if (key === "_id") {
        let oidStr;
        try { oidStr = String(new ObjectId(String(value).trim())); } catch { return null; }
        const rec = await findPendingRecord(
          (r) => r._id && String(r._id) === oidStr,
          { filterStatuses: statusArr }
        );
        return rec || null;
      }
      if (key === "orderTrackingId") {
        return await findPendingRecord(
          (r) => r.orderTrackingId === String(value).trim(),
          { filterStatuses: statusArr }
        ) || null;
      }
      if (key === "phoneNumber") {
        const raw = String(value).trim();
        const n = normalizePhone(raw);
        let found = null;
        const all = await getAllPendingFlattened({
          newerThanMs: 20 * 60 * 1000,
          filter: (r) => statusArr.includes(String(r.status || "")),
        });
        all.sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        });
        const exact = all.find((r) => {
          const pRaw = String(r.phoneNumber || "");
          return pRaw === raw || normalizePhone(pRaw) === n;
        });
        found = exact || null;
        if (!found && getLast5Digits(raw)) {
          for (const doc of all) {
            if (phoneMatchesLast5(doc.phoneNumber || "", raw)) {
              found = doc;
              console.log(
                `[api/complete-from-pendingaccount] loadPendingBy(phone) matched via LAST-5: input=${raw} vs db.phone=${doc.phoneNumber}`
              );
              break;
            }
          }
        }
        return found;
      }
      return null;
    }

    const byId = pendingAccountId ? await loadPendingBy("_id", pendingAccountId) : null;
    const byOtid = orderTrackingId ? await loadPendingBy("orderTrackingId", orderTrackingId) : null;
    const byPhone = normInputPhone ? await loadPendingBy("phoneNumber", phoneNumber) : null;

    // ---- Step 1b: if more than one key provided, all must resolve to the SAME doc ----
    const candidates = [byId, byOtid, byPhone].filter(Boolean);
    if (candidates.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending registration not found.",
      });
    }
    const canonicalIds = new Set(candidates.map((c) => String(c._id)));
    if (canonicalIds.size !== 1) {
      return res.status(400).json({
        success: false,
        message: "Lookup keys do not match the same pending record.",
      });
    }
    const pending = candidates[0];

    // ---- Step 1c: status + payment validation ----
    if (!validStatuses.has(String(pending.status || ""))) {
      return res.status(400).json({
        success: false,
        message:
          "Pending registration is not in a completable state (status=" +
          pending.status +
          ").",
      });
    }
    const amount = Number(pending.amount || pending.chargedAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "No valid payment amount recorded.",
      });
    }
    const currency = String(pending.currency || "KES").toUpperCase();
    if (currency !== "KES") {
      return res.status(400).json({
        success: false,
        message: "Unsupported currency in pending registration.",
      });
    }

    // ---- Step 2: derive ALL values DIRECTLY from PendingAccount (never client) ----
    const userInfo = (
      typeof pending.registrationData === "string"
        ? (() => {
            try {
              return JSON.parse(pending.registrationData);
            } catch (_) {
              return {};
            }
          })()
        : pending.registrationData || {}
    );

    const FirstName = (
      pending.FirstName ||
      userInfo.FirstName ||
      userInfo.firstName ||
      ""
    ).trim();
    const MiddleName = (
      pending.MiddleName ||
      userInfo.MiddleName ||
      userInfo.middleName ||
      ""
    ).trim();
    const LastName = (
      pending.LastName ||
      userInfo.LastName ||
      userInfo.lastName ||
      ""
    ).trim();
    const email = (pending.email || userInfo.email || "").trim();
    const gender = (pending.gender || userInfo.gender || "").trim();
    const ageBracket = (pending.ageBracket || userInfo.ageBracket || "").trim();
    const idNumber = (pending.idNumber || userInfo.idNumber || "").trim();
    const county = (pending.county || userInfo.county || "").trim();
    const constituency = (pending.constituency || userInfo.constituency || "").trim();
    const ward = (pending.ward || userInfo.ward || "").trim();
    const finalPhoneRaw = pending.phoneNumber || phoneNumber || "";
    const finalPhone = normalizePhone(String(finalPhoneRaw));

    // Phone cross-check: if client sent phone and PendingAccount also has a
    // phone, they must normalize to the same value (popup tamper guard).
    if (normInputPhone && pending.phoneNumber) {
      if (normalizePhone(String(pending.phoneNumber)) !== normInputPhone) {
        return res.status(400).json({
          success: false,
          message: "Phone number mismatch on pending record.",
        });
      }
    }

    if (
      !FirstName ||
      !LastName ||
      !finalPhone ||
      !pending.password ||
      !county ||
      !constituency ||
      !ward
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Incomplete registration data. Please restart registration from scratch.",
      });
    }

    // ---- Step 3: ensure user is NOT already registered in County ----
    const existingUser = await findUserByPhone(finalPhone);
    if (existingUser) {
      // Already registered → clean up pending doc and succeed (idempotent).
      try {
        if (deletePendingRecord) await deletePendingRecord((r) => r._id && String(r._id) === String(pending._id));
      } catch (_) {}
      return res.json({
        success: true,
        message: "Already registered. Redirecting to login.",
      });
    }

    // ---- Step 4: save user to County collection ----
    const newUser = {
      FirstName,
      MiddleName,
      LastName,
      email,
      phoneNumber: finalPhone,
      password: pending.password,
      gender: gender || "Other",
      county,
      constituency,
      ward,
      ageBracket: ageBracket || "18-25",
      idNumber: idNumber || null,
      passkey: pending.passkey || undefined,
      personalPin: undefined,
      startky: pending.startky || undefined,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveUserToMongoDB(newUser);
    } catch (saveErr) {
      console.error(
        "[complete-from-pendingaccount] saveUserToMongoDB error:",
        saveErr.message
      );
      return res.status(500).json({
        success: false,
        message: "Failed to register member in county register.",
      });
    }

    // ---- Step 5: Settle pending holding → PersonalAccount (trans.js) ----
    // Moves the registration fee from account.pending.value INTO account.personal,
    // and records a "completed" settlement transaction. Falls back to
    // transferRegistrarFeeToPersonal if no pending holding exists yet.
    const {
      settlePendingToPersonal,
      transferRegistrarFeeToPersonal,
    } = require("./trans");
    try {
      // Attempt settle (pending.value → personal). If there is no pending holding
      // (e.g. creditPendingHolding was never called), fall back to a direct transfer.
      const settleResult = await settlePendingToPersonal({
        phone: finalPhone,
        amount,
        reference: pending.orderTrackingId || pending.merchantReference || "SETTLE-PENDING",
        paymentMethod: pending.paymentMethod || "pesapal",
        notes: "Pending holding → Personal account (registration completed)",
      });
      if (!settleResult.success) {
        console.warn(
          `[complete-from-pendingaccount] settlePendingToPersonal failed (${settleResult.reason}) — ` +
            `falling back to transferRegistrarFeeToPersonal for ${finalPhone}`,
        );
        await transferRegistrarFeeToPersonal({
          phone: finalPhone,
          county,
          constituency,
          ward,
          amount,
          reference: pending.orderTrackingId || pending.merchantReference || "REG-FEE",
          paymentMethod: pending.paymentMethod || "pesapal",
          notes: "Registrar → Personal account transfer (registration fee — fallback)",
        });
      }
    } catch (txErr) {
      console.error(
        "[complete-from-pendingaccount] settlement error:",
        txErr.message
      );
    }

    // ---- Step 6: DELETE PendingAccount (prevents replay / double-consume) ----
    try {
      if (deletePendingRecord) {
        await deletePendingRecord((r) => r._id && String(r._id) === String(pending._id));
      }
    } catch (pendErr) {
      console.error(
        "[complete-from-pendingaccount] PendingAccount delete error:",
        pendErr.message
      );
    }

    // ---- Step 7: rotate passkey, log performance ----
    try {
      rotatePasskey();
      if (typeof regPerfLogger?.logRegistration === "function") {
        regPerfLogger.logRegistration(county, constituency, ward, "members");
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: "Registration completed successfully.",
    });
  } catch (err) {
    console.error(
      "[api/complete-from-pendingaccount] Unhandled error:",
      err.message
    );
    return res.status(500).json({
      success: false,
      message: "Server error processing registration.",
    });
  }
});

/**
 * Send registration passkey from tbank personal_account_registration
 * to the user's email or phone (3-minute client countdown).
 */
router.post("/register/send-passkey", async (req, res) => {
  try {
    const channel = String(req.body.channel || "").toLowerCase();
    const email = String(req.body.email || "").trim();
    const phoneNumber = String(req.body.phoneNumber || "").trim();

    if (channel !== "email" && channel !== "phone") {
      return res.json({ success: false, message: "Choose email or phone." });
    }
    if (channel === "email" && !email) {
      return res.json({ success: false, message: "Email address is required." });
    }
    if (channel === "phone" && !phoneNumber) {
      return res.json({ success: false, message: "Phone number is required." });
    }

    let personalReg = null;
    try {
      const tbankSettings = await getTbankSettings();
      if (tbankSettings && tbankSettings.compliance) {
        personalReg = tbankSettings.compliance.personal_account_registration || null;
      }
    } catch (mongoErr) {
      console.error("[auth] send-passkey MongoDB read failed:", mongoErr.message);
    }

    if (!personalReg) {
      const tbankData = readJSON(tbankFile, {});
      personalReg = tbankData.compliance?.personal_account_registration || null;
    }

    if (!personalReg || !personalReg.paymentMethod) {
      return res.json({ success: false, message: "Registration passkey is not configured." });
    }

    const method = String(personalReg.paymentMethod).toLowerCase();
    if (method !== "passkey" && String(personalReg.amount) !== "0") {
      return res.json({ success: false, message: "Passkey delivery is not enabled for the current fee setting." });
    }

    let passkey = personalReg.passkey;
    if (!passkey) {
      passkey = Math.floor(1000 + Math.random() * 9000).toString();
      const updatedReg = {
        ...personalReg,
        passkey,
        updatedAt: new Date().toISOString(),
      };

      try {
        await saveTbankSettings({
          "compliance.personal_account_registration": updatedReg,
        });
      } catch (e) {
        console.error("[auth] Failed to save generated passkey to MongoDB:", e.message);
      }

      try {
        const tbankData = readJSON(tbankFile, {});
        if (!tbankData.compliance) tbankData.compliance = {};
        tbankData.compliance.personal_account_registration = updatedReg;
        writeJSON(tbankFile, tbankData);
      } catch (e) {
        console.error("[auth] Failed to save generated passkey to tbank.json:", e.message);
      }
    }

    req.session.registrationPasskeyDelivery = {
      channel,
      email: channel === "email" ? email : null,
      phoneNumber: channel === "phone" ? phoneNumber : null,
      sentAt: Date.now(),
      expiresAt: Date.now() + 3 * 60 * 1000,
    };

    if (channel === "email") {
      console.log(`\n📨 [DEV] Registration passkey for ${email}: ${passkey}\n`);
      try {
        if (process.env.SMTP_USER && process.env.SMTP_PASS) {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
          });

          await transporter.sendMail({
            from: `"Tbank Investment" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Your Tbank Registration Passkey",
            text: `Your registration verification code is: ${passkey}. It expires in 3 minutes.`,
            html: `
              <div style="font-family: sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px; margin: 0 auto;">
                <h2 style="color: #0f9d58; margin-bottom: 8px;">Tbank Investment</h2>
                <p style="color: #475569; font-size: 14px;">Use this code to complete your account registration.</p>
                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #1e293b; margin: 20px 0;">
                  ${passkey}
                </div>
                <p style="font-size: 12px; color: #64748b;">This code is valid for 3 minutes.</p>
              </div>
            `,
          });
        }
      } catch (mailErr) {
        console.error("[auth] Registration passkey email error:", mailErr.message);
      }

      return res.json({
        success: true,
        message: process.env.SMTP_USER && process.env.SMTP_PASS
          ? "Verification code sent to your email."
          : "Dev Mode: verification code printed to server console.",
        channel: "email",
      });
    }

    // Phone channel — SMS provider not configured; log for delivery / future SMS hook
    console.log(`\n📱 [DEV] Registration passkey for ${phoneNumber}: ${passkey}\n`);
    return res.json({
      success: true,
      message: "Verification code sent to your phone.",
      channel: "phone",
    });
  } catch (err) {
    console.error("[auth] /register/send-passkey error:", err);
    return res.json({ success: false, message: "Server error sending verification code." });
  }
});

/* 📝 Register (POST submission) */
router.post("/register", async (req, res) => {
  let {
    FirstName,
    MiddleName,
    LastName,
    email,
    phoneNumber,
    password,
    gender,
    county,
    constituency,
    ward,
    ageBracket,
    idNumber,
    name
  } = req.body;
  phoneNumber = (phoneNumber || "").trim();

  if (!phoneNumber || !password) {
    return res.render("register", {
      message: "Phone number and password are required!",
      form: {}
    });
  }

  // Derive first/middle/last from a single name field if provided
  if (!FirstName && !MiddleName && !LastName && name) {
    const nameParts = String(name).trim().split(/\s+/);
    FirstName = nameParts[0] || "";
    MiddleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : (nameParts.length === 2 ? "" : nameParts[1] || "");
    LastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
  }

  let existingUser = null;
  try {
    if (await ensureMongoReady()) {
      existingUser = await findUserByPhone(phoneNumber);
    }
  } catch (dbErr) {
    console.error("MongoDB check during registration:", dbErr.message);
  }

  if (existingUser) {
    return res.render("register", {
      message: "Phone already registered! Please login instead.",
      form: { phoneNumber }
    });
  }

  let personalReg = null;

  try {
    const { getTbankSettings } = require('./../mongoose');
    const tbankSettings = await getTbankSettings();
    if (tbankSettings && tbankSettings.compliance) {
      personalReg = tbankSettings.compliance.personal_account_registration;
    }
  } catch (mongoErr) {
    console.error("[auth] Failed to read personal_account_registration from MongoDB:", mongoErr.message);
  }

  if (!personalReg) {
    const tbankData = readJSON(tbankFile, {});
    personalReg = tbankData.compliance?.personal_account_registration;
  }

  // Tracks the fee actually verified/confirmed below, so the PersonalAccount
  // write further down records the real amount + method + reference instead
  // of always writing zeros.
  let paidFeeAmount = 0;
  let paidFeeMethod = "none";
  let paidFeeReference = "";

  if (personalReg && personalReg.amount && personalReg.paymentMethod) {
    const amount = Number(personalReg.amount || 0);
    const paymentMethod = personalReg.paymentMethod;
    const paymentConfirmed = req.body.paymentConfirmed === 'true';
    const moneyMatches = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

    if (paymentMethod === 'passkey') {
      const userPasskey = req.body.passkey;
      if (!userPasskey || userPasskey !== personalReg.passkey) {
          return res.render('payment', {
              paymentMethod: 'passkey',
              passkey: personalReg.passkey,
              amount: personalReg.amount,
              registrationData: JSON.stringify(req.body),
              hasPasskey: false
          });
      }
      paidFeeAmount = amount;
      paidFeeMethod = 'passkey';
      paidFeeReference = userPasskey;
    } else if (paymentMethod === 'pesapal') {
      const orderTrackingId = String(req.body.__order_tracking_id || req.body.__verification_nonce || "");
      if (!orderTrackingId) {
        return res.render('payment', {
            paymentMethod: 'pesapal',
            passkey: personalReg.passkey,
            amount: personalReg.amount,
            registrationData: JSON.stringify(req.body),
            hasPasskey: !!personalReg.passkey
        });
      }

      let verifiedPayload = null;
      try {
        verifiedPayload = await findVerifiedRegistrationByOrderTrackingId(orderTrackingId);
      } catch (e) {
        console.error("[register] findVerifiedRegistrationByOrderTrackingId threw:", e.message);
        verifiedPayload = null;
      }

      if (!verifiedPayload) {
        try {
          verifiedPayload = consumeVerifiedRegistration(req, orderTrackingId);
        } catch (e) {
          console.error("[register] consumeVerifiedRegistration fallback threw:", e.message);
          verifiedPayload = null;
        }
      }

      if (!verifiedPayload) {
        return res.render('payment', {
            paymentMethod: 'pesapal',
            passkey: personalReg.passkey,
            amount: personalReg.amount,
            registrationData: JSON.stringify(req.body),
            hasPasskey: !!personalReg.passkey,
            message: "Payment session expired or already used. Please restart the Pesapal payment."
        });
      }

      const chargedOk = moneyMatches(Number(verifiedPayload.amount || 0), amount);
      const statusOk =
        Number(verifiedPayload.statusCode) === 1 ||
        String(verifiedPayload.statusCode || "").toUpperCase() === "COMPLETED" ||
        String(verifiedPayload.paymentStatusDescription || "").toUpperCase() === "COMPLETED";

      if (!chargedOk || !statusOk) {
        return res.render('payment', {
            paymentMethod: 'pesapal',
            passkey: personalReg.passkey,
            amount: personalReg.amount,
            registrationData: JSON.stringify(req.body),
            hasPasskey: !!personalReg.passkey,
            message: "Payment verification mismatch. Contact support if you were already charged."
        });
      }

      const callbackPhone = String(verifiedPayload.phoneNumber || "").trim();
      const userInputPhone = String(phoneNumber || "").trim();
      if (callbackPhone && userInputPhone) {
        if (phoneMatchesLast5(callbackPhone, userInputPhone)) {
          console.log(
            `[register] LAST-5 MATCH OK: callback(${callbackPhone}) vs input(${userInputPhone}). ` +
              `Using USER INPUT phone as canonical for County + transactions.`
          );
          phoneNumber = userInputPhone;
        } else {
          console.warn(
            `[register] LAST-5 MISMATCH: callback(${callbackPhone} last5=${getLast5Digits(callbackPhone)}) ` +
              `vs input(${userInputPhone} last5=${getLast5Digits(userInputPhone)}). ` +
              `Using USER INPUT phone (user's preferred format takes precedence).`
          );
          phoneNumber = userInputPhone;
        }
      } else if (callbackPhone && !userInputPhone) {
        console.warn(
          `[register] No user input phone — using callback phone ${callbackPhone} as fallback.`
        );
        phoneNumber = callbackPhone;
      }

      paidFeeAmount = Number(verifiedPayload.amount || amount);
      paidFeeMethod = 'pesapal';
      paidFeeReference = verifiedPayload.orderTrackingId || orderTrackingId;
    } else if (paymentMethod === 'mpesa') {
      if (!paymentConfirmed) {
        return res.render('payment', {
            paymentMethod: paymentMethod,
            passkey: personalReg.passkey,
            amount: personalReg.amount,
            registrationData: JSON.stringify(req.body),
            hasPasskey: !!personalReg.passkey
        });
      }
      paidFeeAmount = amount;
      paidFeeMethod = 'mpesa';
      paidFeeReference = req.body.mpesaReceiptNumber || '';
    }
  }

// Save registration ONLY to MongoDB
    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash personalPin if present and plaintext
    let hashedPersonalPin = null;
    if (req.body.personalPin) {
      hashedPersonalPin = req.body.personalPin.startsWith('$2') 
        ? req.body.personalPin 
        : await bcrypt.hash(req.body.personalPin, 10);
    }

    const newUser = {
      FirstName,
      MiddleName,
      LastName,
      email,
      phoneNumber,
      password: hashedPassword,
      gender,
      county,
      constituency,
      ward,
      ageBracket,
      idNumber: idNumber || null,
      createdAt: new Date().toISOString(),
      ...(hashedPersonalPin && { personalPin: hashedPersonalPin })
    };

  try {
    await saveUserToMongoDB(newUser);
    if (PendingAccount && updatePendingRecord && getAllPendingFlattened) {
      try {
        const queryNonce = req.body.__verification_nonce;
        if (queryNonce) {
          await updatePendingRecord(
            (r) => r.verificationNonce === String(queryNonce),
            { status: "COMPLETED", completedAt: new Date() }
          );
        } else if (phoneNumber) {
          const toUpdate = await getAllPendingFlattened({
            filter: (r) => {
              const p = String(r.phoneNumber || "");
              const target = String(phoneNumber || "");
              return r.status === "VERIFIED_PENDING_COMPLETION" &&
                (p === target || normalizePhone(p) === normalizePhone(target));
            },
          });
          for (const r of toUpdate) {
            if (r._id) {
              await updatePendingRecord(
                (rr) => rr._id && String(rr._id) === String(r._id),
                { status: "COMPLETED", completedAt: new Date() }
              );
            }
          }
        }
      } catch (pendingErr) {
        console.error("Error updating pendingaccount status upon registration:", pendingErr.message);
      }
    }
  } catch (mongoErr) {
    console.error("Error: Failed to save to MongoDB during registration:", mongoErr.message);
    return res.render("register", {
      message: "Registration failed: Database connection issue. Please try again.",
      form: req.body
    });
  }

  try {
    await upsertPersonalAccountMongo({
      phone: phoneNumber,
      county,
      constituency,
      ward,
      amount: paidFeeAmount,
      paymentMethod: paidFeeMethod,
      reference: paidFeeReference
    });
  } catch (personalErr) {
    console.error("Error creating personal account during registration:", personalErr.message);
  }

  if (paidFeeAmount > 0) {
    try {
      const settleResult = await settlePendingToPersonal({
        phone: phoneNumber,
        amount: paidFeeAmount,
        reference: paidFeeReference || "SETTLE-PENDING",
        paymentMethod: paidFeeMethod || "mpesa",
        notes: "Pending holding → Personal account (registration completed)",
      });
      if (!settleResult.success) {
        console.warn(
          `[register] settlePendingToPersonal failed (${settleResult.reason}) — ` +
            `falling back to transferRegistrarFeeToPersonal for ${phoneNumber}`,
        );
        const { transferRegistrarFeeToPersonal } = require('./trans');
        await transferRegistrarFeeToPersonal({
          phone: phoneNumber,
          county,
          constituency,
          ward,
          amount: paidFeeAmount,
          reference: paidFeeReference || "REG-FEE",
          paymentMethod: paidFeeMethod || "mpesa",
          notes: "Registrar → Personal account transfer (registration fee — fallback)",
        });
      }
    } catch (transErr) {
      console.error("[register] trans.js settlement error:", transErr.message);
    }
  }

  // Log Performance
  try {
      regPerfLogger.logRegistration(newUser.county, newUser.constituency, newUser.ward, 'members');
  } catch (e) {
      console.error("Member registration performance log error:", e);
  }

  // 🔄 Rotate passkey for the next user
  rotatePasskey();

  res.render("login", buildLoginContext({ alert: "Registration successful. Login now." }));
});

router.post("/complete-registration", async (req, res) => {
    const { registrationData, startky, passkey } = req.body;
    const userData = JSON.parse(registrationData || "{}");

    const {
        FirstName,
        MiddleName,
        LastName,
        email,
        phoneNumber,
        password,
        gender,
        county,
        constituency,
        ward,
        ageBracket,
        idNumber
    } = userData;

    let personalReg = null;

    try {
      const { getTbankSettings } = require('./../mongoose');
      const tbankSettings = await getTbankSettings();
      if (tbankSettings && tbankSettings.compliance) {
        personalReg = tbankSettings.compliance.personal_account_registration;
      }
    } catch (mongoErr) {
      console.error("[auth] Failed to read personal_account_registration from MongoDB:", mongoErr.message);
    }

    if (!personalReg) {
      const tbankData = readJSON(tbankFile, {});
      personalReg = tbankData.compliance?.personal_account_registration;
    }

    // Tracks the fee actually verified/confirmed below, so the PersonalAccount
    // write further down records the real amount + method + reference instead
    // of always writing zeros.
    let paidFeeAmount = 0;
    let paidFeeMethod = "none";
    let paidFeeReference = "";

    if (personalReg && personalReg.amount && personalReg.paymentMethod) {
      const expectedAmount = Number(personalReg.amount || 0);
      const paymentMethod = personalReg.paymentMethod;
      const paymentConfirmed = req.body.paymentConfirmed === 'true';
      const providedNonce = String(req.body.__verification_nonce || "");
      const moneyMatches = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

      if (paymentMethod === 'passkey') {
        if (!passkey || passkey !== personalReg.passkey) {
            return res.render("register", {
                message: "Registration failed: Invalid Passkey.",
                form: userData
            });
        }
        paidFeeAmount = expectedAmount;
        paidFeeMethod = 'passkey';
        paidFeeReference = passkey;
      } else if (paymentMethod === 'pesapal') {
        const orderTrackingId = String(req.body.__order_tracking_id || providedNonce || "");
        if (!orderTrackingId) {
          console.warn(
            `[complete-registration] PESAPAL PAYMENT GATE BLOCKED: no __order_tracking_id supplied. ` +
              `client claimed paymentConfirmed=${paymentConfirmed}. phone=${userData.phoneNumber}`
          );
          return res.render("register", {
            message: `To register your account, you need to pay a registration fee of ${expectedAmount} KES via Pesapal. Please complete the Pesapal checkout and wait for redirect before submitting any form.`,
            form: userData,
            requirePayment: true,
            paymentAmount: expectedAmount,
            paymentMethod: paymentMethod
          });
        }

        let verifiedPayload = null;
        try {
          verifiedPayload = await findVerifiedRegistrationByOrderTrackingId(orderTrackingId);
        } catch (e) {
          console.error("[complete-registration] findVerifiedRegistrationByOrderTrackingId threw:", e.message);
          verifiedPayload = null;
        }

        if (!verifiedPayload) {
          try {
            verifiedPayload = consumeVerifiedRegistration(req, orderTrackingId);
          } catch (e) {
            console.error("[complete-registration] consumeVerifiedRegistration fallback threw:", e.message);
            verifiedPayload = null;
          }
        }

        if (!verifiedPayload) {
          console.warn(
            `[complete-registration] PESAPAL PAYMENT GATE BLOCKED: orderTrackingId not found/expired/already consumed. phone=${userData.phoneNumber}. otid_prefix=${orderTrackingId.slice(0,8)}...`
          );
          return res.render("register", {
            message: `Payment session expired or already used. If you were charged, contact support. Otherwise, restart the Pesapal payment flow. Do NOT attempt to resubmit this form directly.`,
            form: userData,
            requirePayment: true,
            paymentAmount: expectedAmount,
            paymentMethod: paymentMethod
          });
        }

        const chargedOk = moneyMatches(Number(verifiedPayload.amount || 0), expectedAmount);
        const statusOk =
          Number(verifiedPayload.statusCode) === 1 ||
          String(verifiedPayload.statusCode || "").toUpperCase() === "COMPLETED" ||
          String(verifiedPayload.paymentStatusDescription || "").toUpperCase() === "COMPLETED";

        if (!chargedOk || !statusOk) {
          console.error(
            `[complete-registration] PESAPAL PAYMENT GATE BLOCKED: server-verified payload does not match required. ` +
              `expectedAmount=${expectedAmount} db.amount=${verifiedPayload.amount} db.statusCode=${verifiedPayload.statusCode}. phone=${userData.phoneNumber}`
          );
          return res.render("register", {
            message: `Payment verification mismatch. Expected ${expectedAmount} KES / completed. Contact support if already charged.`,
            form: userData,
            requirePayment: true,
            paymentAmount: expectedAmount,
            paymentMethod: paymentMethod
          });
        }

        const cbPhone = String(verifiedPayload.phoneNumber || "").trim();
        const uInputPhone = String(userData.phoneNumber || "").trim();
        if (cbPhone && uInputPhone) {
          if (phoneMatchesLast5(cbPhone, uInputPhone)) {
            console.log(
              `[complete-registration] LAST-5 MATCH OK: callback(${cbPhone}) vs input(${uInputPhone}). ` +
                `Using USER INPUT phone as canonical for County + transactions.`
            );
            userData.phoneNumber = uInputPhone;
          } else {
            console.warn(
              `[complete-registration] LAST-5 MISMATCH: callback(${cbPhone} last5=${getLast5Digits(cbPhone)}) ` +
                `vs input(${uInputPhone} last5=${getLast5Digits(uInputPhone)}). ` +
                `Using USER INPUT phone (user's preferred format takes precedence).`
            );
            userData.phoneNumber = uInputPhone;
          }
        } else if (cbPhone && !uInputPhone) {
          console.warn(
            `[complete-registration] No user input phone — using callback phone ${cbPhone} as fallback.`
          );
          userData.phoneNumber = cbPhone;
        }

        paidFeeAmount = Number(verifiedPayload.amount || expectedAmount);
        paidFeeMethod = 'pesapal';
        paidFeeReference = verifiedPayload.orderTrackingId || orderTrackingId;
      } else if (paymentMethod === 'mpesa') {
        if (!paymentConfirmed) {
          return res.render("register", {
              message: `To register your account, you need to pay a registration fee of ${expectedAmount} KES via M-Pesa. Please complete the payment and try again.`,
              form: userData,
              requirePayment: true,
              paymentAmount: expectedAmount,
              paymentMethod: paymentMethod
          });
        }
        paidFeeAmount = expectedAmount;
        paidFeeMethod = 'mpesa';
        paidFeeReference = req.body.mpesaReceiptNumber || '';
      }
    }

    // Normalize phone number — prefer userData.phoneNumber (may be overridden by
    // Pesapal gate with paymentAccount from callback) over early-destructured value
    let normPhone = (userData.phoneNumber || phoneNumber || "").trim();

    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash personalPin if present and plaintext
    let hashedPersonalPin = null;
    if (userData.personalPin) {
      hashedPersonalPin = userData.personalPin.startsWith('$2') 
        ? userData.personalPin 
        : await bcrypt.hash(userData.personalPin, 10);
    }

    const newUser = {
        FirstName,
        MiddleName,
        LastName,
        email,
        phoneNumber: normPhone,
        password: hashedPassword,
        gender,
        county,
        constituency,
        ward,
        ageBracket,
        idNumber: idNumber || null,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        ...(hashedPersonalPin && { personalPin: hashedPersonalPin })
    };

    if (passkey) {
        newUser.passkey = passkey;
    }
    if (startky) {
        newUser.startky = startky;
    }

    // Save to MongoDB
    try {
      await saveUserToMongoDB(newUser);
      if (PendingAccount && updatePendingRecord && getAllPendingFlattened) {
        try {
          const queryNonce = req.body.__verification_nonce || providedNonce;
          if (queryNonce) {
            await updatePendingRecord(
              (r) => r.verificationNonce === String(queryNonce),
              { status: "COMPLETED", completedAt: new Date() }
            );
          } else if (normPhone) {
            const toUpdate = await getAllPendingFlattened({
              filter: (r) => {
                const p = String(r.phoneNumber || "");
                const target = String(normPhone || "");
                return r.status === "VERIFIED_PENDING_COMPLETION" &&
                  (p === target || normalizePhone(p) === normalizePhone(target));
              },
            });
            for (const r of toUpdate) {
              if (r._id) {
                await updatePendingRecord(
                  (rr) => rr._id && String(rr._id) === String(r._id),
                  { status: "COMPLETED", completedAt: new Date() }
                );
              }
            }
          }
        } catch (pendingErr) {
          console.error("Error updating pendingaccount status upon completion:", pendingErr.message);
        }
      }
    } catch (mongoErr) {
      console.error("Error: Failed to save to MongoDB during completion:", mongoErr.message);
      return res.render("register", {
          message: "Registration failed: Database connection issue. Please try again.",
          form: userData
      });
    }

    try {
      await upsertPersonalAccountMongo({
        phone: normPhone,
        county,
        constituency,
        ward,
        amount: paidFeeAmount,
        paymentMethod: paidFeeMethod,
        reference: paidFeeReference
      });
    } catch (personalErr) {
      console.error("Error creating personal account during completion:", personalErr.message);
    }

    // trans.js: settles the pending holding (if any) from account.pending.value
    // INTO account.personal, and logs a "completed" settlement transaction.
    // Falls back to transferRegistrarFeeToPersonal if no pending holding exists.
    // Runs only when a fee was actually paid; failures are logged but never
    // block registration completion.
    if (paidFeeAmount > 0) {
      try {
        const settleResult = await settlePendingToPersonal({
          phone: normPhone,
          amount: paidFeeAmount,
          reference: paidFeeReference || "SETTLE-PENDING",
          paymentMethod: paidFeeMethod || "unknown",
          notes: "Pending holding → Personal account (registration completed)",
        });
        if (!settleResult.success) {
          console.warn(
            `[complete-registration] settlePendingToPersonal failed (${settleResult.reason}) — ` +
              `falling back to transferRegistrarFeeToPersonal for ${normPhone}`,
          );
          await transferRegistrarFeeToPersonal({
            phone: normPhone,
            county,
            constituency,
            ward,
            amount: paidFeeAmount,
            reference: paidFeeReference || "REG-FEE",
            paymentMethod: paidFeeMethod || "unknown",
            notes: "Registrar → Personal account transfer (registration fee — fallback)",
          });
        }
      } catch (transErr) {
        console.error("[complete-registration] trans.js settlement error:", transErr.message);
      }
    }

    // Log Performance
    try {
        regPerfLogger.logRegistration(newUser.county, newUser.constituency, newUser.ward, 'members');
    } catch (e) {
        console.error("Member registration performance log error:", e);
    }

    // Update statistics
    const stats = readJSON(statsFile, { totalRegistrations: 0, mpesaPayments: 0, passkeyPayments: 0 });
    stats.totalRegistrations++;
    if (personalReg && personalReg.paymentMethod === 'mpesa') {
        stats.mpesaPayments++;
    } else if (personalReg && personalReg.paymentMethod === 'passkey') {
        stats.passkeyPayments++;
    }
    writeJSON(statsFile, stats);

    // 🔄 Rotate passkey for the next user
    rotatePasskey();

  res.render("login", buildLoginContext({ alert: "Registration successful. Login now." }));
});

/* 🔑 Login (GET form) */
router.get("/login", async (req, res) => {
  // If already logged in, redirect to dashboard to 'hide' the login URL
  if (req.session && req.session.user) {
    return res.redirect("/personal");
  }

  // Reflect the HQ-selected auth option (Email / OTP / login)
  let authOption = "login";
  let suspended = false;
  try {
    if (await ensureMongoReady()) {
      const settings = await getTbankSettings();
      const opt =
        settings && settings.lastSelectedAuthOption && settings.lastSelectedAuthOption.option
          ? String(settings.lastSelectedAuthOption.option).toLowerCase()
          : "";
      if (opt === "suspend") {
        suspended = true;
      } else if (opt === "email" || opt === "otp") {
        authOption = opt;
      }
    }
  } catch (e) {
    console.error("Error reading auth option:", e.message);
  }

  res.render("login", buildLoginContext({ alert: null, authOption, suspended }));
});

/**
 * Builds the full set of variables the login.ejs template requires,
 * so every render path (GET and POST-failure) supplies firebaseConfig,
 * authOption and suspended consistently.
 */
function buildLoginContext(extra = {}) {
  return Object.assign({
    alert: null,
    authOption: "login",
    suspended: false,
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    }
  }, extra);
}

/* 🔑 Firebase Login Success Callback */
router.post("/firebase-login", async (req, res) => {
  let loginPhone = (req.body.phoneNumber || "").trim();

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.render("login", buildLoginContext({ alert: getMongoConfigHint() }));
  }

  try {
    let user = await findUserByPhone(loginPhone);
    if (!user) {
      // Check if there is a live Pesapal payment session for this phone
      let paymentSession = null;
      try {
        paymentSession = await findVerifiedRegistrationByPhone(req, loginPhone);
      } catch (e) {
        console.error("[firebase-login] findVerifiedRegistrationByPhone threw:", e.message);
        paymentSession = null;
      }
      if (paymentSession) {
        const regData = typeof paymentSession.registrationData === "string"
          ? (() => { try { return JSON.parse(paymentSession.registrationData); } catch(e) { return {}; } })()
          : (paymentSession.registrationData || {});
        return res.render("register", {
          message: null,
          form: regData,
          resumePayment: {
            nonce: paymentSession.nonce,
            fullName: [regData.FirstName || regData.firstName, regData.LastName || regData.lastName].filter(Boolean).join(" ") || "Valued Member",
            amount: paymentSession.amount,
            currency: paymentSession.currency || "KES",
            orderTrackingId: paymentSession.orderTrackingId,
            registrationDataEncoded: JSON.stringify(paymentSession.registrationData || {})
              .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
          }
        });
      }
      return res.render("register", {
        message: "Phone number not registered. Please create an account.",
        form: { phoneNumber: loginPhone },
        resumePayment: null
      });
    }

    // Update last login
    await updateLastLogin(loginPhone);

    // Save session user
    req.session.user = { 
      phoneNumber: user.phoneNumber,
      firstName: user.FirstName,
      lastName: user.LastName,
      idNumber: user.idNumber
    };

    const tbankData = readJSON(tbankFile, {});
    req.session.loginSeason = tbankData.compliance?.periods?.season || "Annual";

    const normalizedUserPhone = normalizePhone(user.phoneNumber || loginPhone || "");
    const rawPhone = user.phoneNumber || loginPhone || "";
    const phoneVariants = [...new Set([
      rawPhone,
      normalizedUserPhone,
      "0" + normalizedUserPhone,
      "254" + normalizedUserPhone,
      "+254" + normalizedUserPhone
    ])];
    let mongoAgent = await Agent.findOne({ phoneNumber: { $in: phoneVariants } }).lean();
    let mongoDealer = await Dealer.findOne({ phoneNumber: { $in: phoneVariants } }).lean();

    req.session.isAgent = !!mongoAgent;
    req.session.isDealer = !!mongoDealer;
    req.session.agent = mongoAgent ? mongoAgent : (req.session.isAgent ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasAgentPin = req.session.agent ? !!req.session.agent.pin : false;
    
    req.session.dealer = mongoDealer ? mongoDealer : (req.session.isDealer ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasDealerPin = req.session.dealer ? !!req.session.dealer.pin : false;

    req.session.save((err) => {
      res.redirect("/personal");
    });
  } catch (err) {
    console.error("Firebase Login DB Error:", err);
    return res.render("login", buildLoginContext({ alert: "Database error during login." }));
  }
});

/* 🔑 Login (POST submission) */
router.post("/login", async (req, res) => {
  let loginPhone = (req.body.phoneNumber || "").trim();
  let loginPassword = req.body.password || "";

  console.log("\n🔐 LOGIN ATTEMPT:");
  console.log("   Phone entered :", loginPhone, "-> norm:", norm(loginPhone));
  console.log("   Password length:", loginPassword.length);

  let user = null;

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    console.log("   ❌ MongoDB not connected during login");
    return res.render("login", buildLoginContext({
      alert: getMongoConfigHint(),
    }));
  }

  // 1️⃣ Find user in MongoDB counties collection (primary registry)
  try {
    user = await findUserByPhone(loginPhone);
    if (user) {
      console.log("   ✅ User found in MongoDB:", user.FirstName, user.LastName);
    }
  } catch (dbErr) {
    console.error("❌ Database query error during login:", dbErr.message);
    return res.render("login", buildLoginContext({
      alert: "Could not verify your account. Please try again shortly.",
    }));
  }

  // 3️⃣ Not registered anywhere
  if (!user) {
    console.log("   ❌ Phone not found in MongoDB counties registry");
    // Check if there is a live Pesapal payment session for this phone
    let paymentSession = null;
    try {
      paymentSession = await findVerifiedRegistrationByPhone(req, loginPhone);
    } catch (e) {
      console.error("[login POST] findVerifiedRegistrationByPhone threw:", e.message);
      paymentSession = null;
    }
    if (paymentSession) {
      const regData = typeof paymentSession.registrationData === "string"
        ? (() => { try { return JSON.parse(paymentSession.registrationData); } catch(e) { return {}; } })()
        : (paymentSession.registrationData || {});
      return res.render("register", {
        message: null,
        form: regData,
        resumePayment: {
          nonce: paymentSession.nonce,
          fullName: [regData.FirstName || regData.firstName, regData.LastName || regData.lastName].filter(Boolean).join(" ") || "Valued Member",
          amount: paymentSession.amount,
          currency: paymentSession.currency || "KES",
          orderTrackingId: paymentSession.orderTrackingId,
          registrationDataEncoded: JSON.stringify(paymentSession.registrationData || {})
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        }
      });
    }
    return res.render("register", {
      message: "Phone number not registered. Please create an account.",
      form: { phoneNumber: req.body.phoneNumber },
      resumePayment: null
    });
  }

  // 4️⃣ Verify password
  if (!user.password) {
    console.log("   ❌ No password hash in user record!");
    return res.render("login", buildLoginContext({ alert: "Account error: No password set. Contact admin." }));
  }

  const valid = await bcrypt.compare(loginPassword, user.password);
  console.log("   bcrypt result :", valid ? "✅ MATCH" : "❌ NO MATCH");

  if (!valid) return res.render("login", buildLoginContext({ alert: "Wrong password! Check your password and try again." }));

  // Update last login in MongoDB
  try {
    await updateLastLogin(loginPhone);
  } catch (dbErr) {
    console.error("❌ Failed to update last login in MongoDB:", dbErr.message);
  }

  // ✅ Save session user
  req.session.user = { 
    phoneNumber: user.phoneNumber,
    firstName: user.FirstName,
    lastName: user.LastName,
    idNumber: user.idNumber
  };

  // Set season in session
  const tbankData = readJSON(tbankFile, {});
  const currentSeason = tbankData.compliance?.periods?.season || "Annual";
  req.session.loginSeason = currentSeason;

  // Determine if user is agent or dealer and save to session (MongoDB only).
  // findAgentByPhone / findDealerByPhone tolerate any stored phone format.
  let mongoAgent = null;
  let mongoDealer = null;
  try {
    const dbReady = await ensureMongoReady();
    if (dbReady) {
      mongoAgent = await findAgentByPhone(loginPhone);
      mongoDealer = await findDealerByPhone(loginPhone);
    }
  } catch (dbErr) {
    console.error("MongoDB agent/dealer lookup error during login:", dbErr.message);
  }

  req.session.isAgent = !!mongoAgent;
  req.session.isDealer = !!mongoDealer;

  if (req.session.isAgent) {
    req.session.agent = mongoAgent || { phoneNumber: user.phoneNumber };
    req.session.hasAgentPin = !!req.session.agent.pin;
  } else {
    req.session.agent = null;
    req.session.hasAgentPin = false;
  }

  if (req.session.isDealer) {
    req.session.dealer = mongoDealer || { phoneNumber: user.phoneNumber };
    req.session.hasDealerPin = !!req.session.dealer.pin;
  } else {
    req.session.dealer = null;
    req.session.hasDealerPin = false;
  }

  // ✅ Save session before redirecting to prevent session write race conditions
  req.session.save((err) => {
    if (err) {
      console.error("❌ Session save error during login redirect:", err);
    }
    res.redirect("/personal");
  });
});

/* 🔑 Forgot PIN (POST /forgot-pin) */
router.post("/forgot-pin", async (req, res) => {
  const phoneNumber = (req.body.phoneNumber || "").trim();

  if (!phoneNumber) {
    return res.json({ success: false, message: "Phone number is required" });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database not available. Please try again later." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "Phone number not registered." });
    }

    // TODO: Implement start key generation and SMS dispatch
    return res.json({ success: true, message: "Start key request received. Please contact support for assistance." });
  } catch (err) {
    console.error("Forgot PIN error:", err);
    return res.json({ success: false, message: "Server error. Please try again." });
  }
});

/* 🛠️ Admin: Reset a user's password (POST /admin/reset-password) */
/* Usage: POST with { adminCode, phoneNumber, newPassword } */
router.post("/admin/reset-password", async (req, res) => {
  const { adminCode, phoneNumber, newPassword } = req.body;

  // Protect with the admin code from the login page
  if (adminCode !== "35951444") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!phoneNumber || !newPassword) {
    return res.status(400).json({ error: "Phone and new password required" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);

  // 1️⃣ Try to reset password in MongoDB
  try {
    const mongoUser = await findUserByPhone(phoneNumber);
    if (mongoUser) {
      await updateUserPassword(phoneNumber, hashed);
      console.log("🛠️ Password reset in MongoDB for:", phoneNumber);
      return res.json({ success: true, message: "Password updated in MongoDB for " + phoneNumber });
    }
  } catch (dbErr) {
    console.error("❌ Database error during admin password reset:", dbErr.message);
  }

  return res.status(404).json({ error: "User not found" });
});

/* 📨 Send Email OTP Code */
router.post("/send-email-otp", async (req, res) => {
  let { phoneNumber, email } = req.body;
  phoneNumber = (phoneNumber || "").trim();
  email = (email || "").trim();

  if (!phoneNumber || !email) {
    return res.json({ success: false, message: "Phone number and email are required." });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database not available. Please try again later." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "Phone number is not registered. Please create an account first." });
    }

    // Generate a 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in session with 5 minutes expiration
    req.session.emailOtp = {
      code,
      phoneNumber: user.phoneNumber,
      email,
      expires: Date.now() + 5 * 60 * 1000
    };

    console.log(`\n📨 [DEV MODE] Email OTP generated for ${email}: ${code}\n`);

    // Attempt to send email
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const mailOptions = {
          from: `"Tbank Investment" <${process.env.SMTP_USER}>`,
          to: email,
          subject: "Your Tbank Verification Code",
          text: `Your verification code is: ${code}. It expires in 5 minutes.`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px; margin: 0 auto;">
              <h2 style="color: #0f9d58; margin-bottom: 8px;">Tbank Investment</h2>
              <p style="color: #475569; font-size: 14px;">You requested a one-time code to sign in to your Tbank account.</p>
              <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #1e293b; margin: 20px 0;">
                ${code}
              </div>
              <p style="font-size: 12px; color: #64748b; margin-top: 20px;">This code is valid for 5 minutes. If you did not request this code, please ignore this email.</p>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
        console.log(`[SMTP] Verification email sent successfully to ${email}`);
      } else {
        console.warn("[SMTP] Credentials not found in .env file. Running in dev-print mode only.");
      }
    } catch (mailErr) {
      console.error("[SMTP] Mail send error:", mailErr.message);
      // Fallback gracefully so local dev doesn't crash: still succeed and let them check node terminal console
    }

    return res.json({ 
      success: true, 
      message: process.env.SMTP_USER && process.env.SMTP_PASS 
        ? "Verification code sent to your email address." 
        : "Dev Mode: Verification code printed to Server Console log."
    });
  } catch (err) {
    console.error("Send Email OTP Error:", err);
    return res.json({ success: false, message: "Server error sending OTP." });
  }
});

/* 📨 Verify Email OTP Code */
router.post("/verify-email-otp", async (req, res) => {
  const { otp } = req.body;
  
  if (!req.session.emailOtp) {
    return res.json({ success: false, message: "No active verification session. Please request a new code." });
  }

  const { code, phoneNumber, expires } = req.session.emailOtp;

  if (Date.now() > expires) {
    delete req.session.emailOtp;
    return res.json({ success: false, message: "Verification code expired. Please request a new one." });
  }

  if (otp !== code) {
    return res.json({ success: false, message: "Invalid verification code." });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database error during validation." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "User account not found." });
    }

    // Clean up OTP session
    delete req.session.emailOtp;

    // Update last login
    await updateLastLogin(phoneNumber);

    // Save session user
    req.session.user = { 
      phoneNumber: user.phoneNumber,
      firstName: user.FirstName,
      lastName: user.LastName,
      idNumber: user.idNumber
    };

    const tbankData = readJSON(tbankFile, {});
    req.session.loginSeason = tbankData.compliance?.periods?.season || "Annual";

    const normalizedUserPhone = normalizePhone(user.phoneNumber || "");
    const rawPhone = user.phoneNumber || "";
    const phoneVariants = [...new Set([
      rawPhone,
      normalizedUserPhone,
      "0" + normalizedUserPhone,
      "254" + normalizedUserPhone,
      "+254" + normalizedUserPhone
    ])];
    let mongoAgent = await Agent.findOne({ phoneNumber: { $in: phoneVariants } }).lean();
    let mongoDealer = await Dealer.findOne({ phoneNumber: { $in: phoneVariants } }).lean();

    req.session.isAgent = !!mongoAgent;
    req.session.isDealer = !!mongoDealer;
    req.session.agent = mongoAgent ? mongoAgent : (req.session.isAgent ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasAgentPin = req.session.agent ? !!req.session.agent.pin : false;
    
    req.session.dealer = mongoDealer ? mongoDealer : (req.session.isDealer ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasDealerPin = req.session.dealer ? !!req.session.dealer.pin : false;

    req.session.save((err) => {
      return res.json({ success: true, redirect: "/personal" });
    });
  } catch (err) {
    console.error("Verify Email OTP DB Error:", err);
    return res.json({ success: false, message: "Database validation error." });
  }
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;