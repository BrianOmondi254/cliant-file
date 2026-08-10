const { creditPendingHolding, creditWalletTopUp } = require("./trans");

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const {
  submitOrderRequest,
  requestPayment,
  getTransactionStatus,
  registerIpnUrl,
  getIpnList,
  getAccessToken,
  callbackUrl: envCallbackUrl,
  ipnUrl: envIpnUrl,
  ipnId: envIpnId,
} = require("../config/pesapal");

let PendingAccount = null;
let upsertPendingAccount = null;
let getAllPendingFlattened = null;
let deleteAllPendingRecords = null;
let findPendingRecord = null;
try {
  const mongoose = require("../mongoose");
  PendingAccount = mongoose.PendingAccount;
  upsertPendingAccount = mongoose.upsertPendingAccount;
  getAllPendingFlattened = mongoose.getAllPendingFlattened;
  deleteAllPendingRecords = mongoose.deleteAllPendingRecords;
  findPendingRecord = mongoose.findPendingRecord;
} catch (e) {
  console.warn("[Pesapal] Could not load PendingAccount model/helpers:", e.message);
}

const router = express.Router();

const ENV_PATH = path.resolve(__dirname, "..", ".env");

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return "";
  return fs.readFileSync(ENV_PATH, "utf8");
}

function writeEnvWithIpnId(newIpnId) {
  const prev = readEnvFile();
  const lines = prev ? prev.split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    if (/^\s*PESAPAL_IPN_ID\s*=/.test(line)) {
      found = true;
      return `PESAPAL_IPN_ID=${newIpnId}`;
    }
    return line;
  });
  if (!found) out.push(`PESAPAL_IPN_ID=${newIpnId}`);
  fs.writeFileSync(ENV_PATH, out.join("\n") + (out.length ? "\n" : ""));
}

async function ensureValidIpn(options = {}) {
  const { preferredNotifType = "POST", writeFile = true, log = false } = options;

  const logOut = (...args) => {
    if (log) console.log(...args);
  };

  logOut("== Pesapal ensureValidIpn start ==");
  logOut("  loaded env PESAPAL_ENVIRONMENT  =", process.env.PESAPAL_ENVIRONMENT);
  logOut("  loaded env PESAPAL_IPN_URL       =", envIpnUrl);
  logOut("  loaded env PESAPAL_IPN_ID        =", envIpnId);

  const token = await getAccessToken();
  if (token.error) {
    throw new Error(`Pesapal auth failed: ${JSON.stringify(token.error)}`);
  }
  logOut("  ✔ Pesapal access token OK");

  const list = await getIpnList();
  logOut("  Existing registered IPNs on Pesapal:", JSON.stringify(list, null, 2).split("\n").map((l, i) => i === 0 ? l : "      " + l).join("\n"));

  let chosenIpnId = null;
  let actionTaken = "none";
  let matchedEntry = null;
  let registerResult = null;

  const matchById = Array.isArray(list)
    ? list.find((x) => x.ipn_id && envIpnId && String(x.ipn_id).trim() === String(envIpnId).trim())
    : null;
  const matchByUrl = Array.isArray(list)
    ? list.find((x) => {
        const a = String(x.url || "").replace(/\/$/, "").toLowerCase();
        const b = String(envIpnUrl || "").replace(/\/$/, "").toLowerCase();
        return !!a && !!b && a === b;
      })
    : null;
  const matchByUrlPost = Array.isArray(list)
    ? list.find((x) => {
        const a = String(x.url || "").replace(/\/$/, "").toLowerCase();
        const b = String(envIpnUrl || "").replace(/\/$/, "").toLowerCase();
        const type = String(x.ipn_notification_type_description || "").toUpperCase();
        return !!a && !!b && a === b && type === preferredNotifType;
      })
    : null;

  if (matchById) {
    const type = String(matchById.ipn_notification_type_description || "").toUpperCase();
    logOut(`  ✔ Current PESAPAL_IPN_ID matches a registered IPN by id. Type=${type} status=${matchById.ipn_status_decription || matchById.ipn_status}`);
    if (type === preferredNotifType) {
      chosenIpnId = matchById.ipn_id;
      actionTaken = "reused-id";
      matchedEntry = matchById;
    } else {
      logOut(`  ⚠ Existing IPN is ${type}, preferred is ${preferredNotifType}. Will register a ${preferredNotifType} IPN.`);
    }
  } else if (matchByUrlPost) {
    logOut(`  ✔ Found registered ${preferredNotifType} IPN matching PESAPAL_IPN_URL. ipn_id=${matchByUrlPost.ipn_id}`);
    chosenIpnId = matchByUrlPost.ipn_id;
    actionTaken = "reused-post";
    matchedEntry = matchByUrlPost;
  } else if (matchByUrl) {
    const type = String(matchByUrl.ipn_notification_type_description || "").toUpperCase();
    logOut(`  ℹ Found registered IPN matching env PESAPAL_IPN_URL but it's ${type}, not ${preferredNotifType}. Registering ${preferredNotifType} variant.`);
  } else if (envIpnId) {
    logOut(`  ⚠ PESAPAL_IPN_ID in .env (${envIpnId}) was NOT found on Pesapal for this merchant (cause of "specified IPN ID is invalid"). Registering new ${preferredNotifType} IPN for ${envIpnUrl}.`);
  } else {
    logOut(`  ℹ No PESAPAL_IPN_ID set in .env yet. Registering a new ${preferredNotifType} IPN for ${envIpnUrl}.`);
  }

  if (!chosenIpnId) {
    if (!envIpnUrl) {
      throw new Error("PESAPAL_IPN_URL env var is empty. Cannot register an IPN without a public URL.");
    }
    logOut(`  Registering new ${preferredNotifType} IPN URL: ${envIpnUrl}`);
    const registered = await registerIpnUrl(envIpnUrl, preferredNotifType);
    registerResult = registered;
    chosenIpnId = registered?.ipn_id || null;
    if (!chosenIpnId) {
      throw new Error(
        `Pesapal RegisterIPN response did not include ipn_id: ${JSON.stringify(registered)}`
      );
    }
    actionTaken = "registered-new";
    logOut(`  ✔ New ${preferredNotifType} IPN registered. ipn_id = ${chosenIpnId}`);
  }

  if (writeFile) {
    writeEnvWithIpnId(chosenIpnId);
    logOut(`  ✔ Wrote PESAPAL_IPN_ID=${chosenIpnId} into ${ENV_PATH}`);
  }

  return {
    ipnId: chosenIpnId,
    ipnUrl: envIpnUrl,
    preferredNotifType,
    actionTaken,
    matchedEntry,
    registerResult,
    registeredList: list,
    envPath: ENV_PATH,
    envWritten: !!writeFile,
  };
}

async function runColdStartVerification(expectedIpnId) {
  const verifyCode = `
    require("dotenv").config({ override: true });
    const cfg = require(${JSON.stringify(path.resolve(__dirname, "..", "config", "pesapal.js"))});
    console.log("coldStart.config.ipnId  =", cfg.ipnId);
    console.log("coldStart.config.ipnUrl =", cfg.ipnUrl);
    if (cfg.ipnId === ${JSON.stringify(expectedIpnId)}) {
      console.log("✅ COLD-START CONFIRMATION: config/pesapal.js correctly loaded the new IPN ID from .env.");
      process.exit(0);
    } else {
      console.log("❌ MISMATCH — expected =", ${JSON.stringify(expectedIpnId)});
      process.exit(7);
    }
  `;
  const child = child_process.spawnSync(process.execPath, ["-e", verifyCode], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.resolve(__dirname, ".."),
  });
  process.stdout.write(child.stdout || Buffer.alloc(0));
  process.stderr.write(child.stderr || Buffer.alloc(0));
  return child.status ?? 99;
}

const getBaseUrl = (req) => {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (req.connection.encrypted ? "https" : "http");
  return `${proto}://${req.get("host")}`;
};

const globalPendingPayments = new Map();
const globalVerifiedRegistrations = new Map();

// Automatically clean up old pending items older than 2 hours to avoid memory leaks
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of globalPendingPayments.entries()) {
    if (val.initiatedAtMs && val.initiatedAtMs < cutoff) {
      globalPendingPayments.delete(key);
    }
  }
  for (const [key, val] of globalVerifiedRegistrations.entries()) {
    if (val.expiresAt && val.expiresAt < Date.now()) {
      globalVerifiedRegistrations.delete(key);
    }
  }
  if (PendingAccount && deleteAllPendingRecords) {
    deleteAllPendingRecords((r) => {
      const cutoffMs = 2 * 60 * 60 * 1000;
      const t = r.createdAt ? new Date(r.createdAt).getTime() : 0;
      return r.status === "INITIATED" && (Date.now() - t > cutoffMs);
    }).catch((e) => {
      console.error("[Pesapal] Failed to clean up expired pending accounts from MongoDB:", e.message);
    });
  }
}, 15 * 60 * 1000);

const getPendingPayment = async (req) => {
  const sessionPayments = (req && req.session && req.session.pesapalPayments) ? req.session.pesapalPayments : {};
  const merged = { ...sessionPayments };
  for (const [key, val] of globalPendingPayments.entries()) {
    if (!merged[key]) {
      merged[key] = val;
    }
  }
  if (PendingAccount && getAllPendingFlattened) {
    try {
      const dbPayments = await getAllPendingFlattened({
        newerThanMs: 2 * 60 * 60 * 1000,
        filter: (r) => r.status === "INITIATED",
      });
      for (const doc of dbPayments) {
        const key = doc.orderId;
        if (key && !merged[key]) {
          merged[key] = {
            orderId: doc.orderId,
            orderTrackingId: doc.orderTrackingId,
            merchantReference: doc.merchantReference,
            amount: doc.amount,
            expectedAmount: doc.amount,
            currency: doc.currency,
            registrationData: doc.registrationData,
            status: doc.status,
            initiatedAtMs: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
            purpose: (doc.registrationData && doc.registrationData.purpose) || undefined,
            creditPhone: (doc.registrationData && doc.registrationData.creditPhone) || undefined,
            payerPhone: (doc.registrationData && (doc.registrationData.payerPhone || doc.registrationData.phoneNumber)) || undefined,
          };
        }
      }
    } catch (e) {
      console.error("[Pesapal] Failed to load pending payments from MongoDB:", e.message);
    }
  }
  return merged;
};

const setPendingPayment = async (req, orderId, data) => {
  if (req && req.session) {
    if (!req.session.pesapalPayments) req.session.pesapalPayments = {};
    req.session.pesapalPayments[orderId] = data;
  }
  if (orderId) {
    globalPendingPayments.set(orderId, data);
  }
  if (data && data.orderTrackingId) {
    globalPendingPayments.set(data.orderTrackingId, data);
  }
  if (data && data.merchantReference) {
    globalPendingPayments.set(data.merchantReference, data);
  }
  if (PendingAccount && upsertPendingAccount) {
    try {
      let regData = data.registrationData || {};
      if (typeof regData === "string") {
        try { regData = JSON.parse(regData); } catch (_) { regData = {}; }
      }
      await upsertPendingAccount({
        orderId,
        orderTrackingId: data.orderTrackingId || null,
        merchantReference: data.merchantReference || null,
        amount: data.amount,
        currency: data.currency || "KES",
        phoneNumber: regData.phoneNumber || regData.PhoneNumber || regData.phone || "",
        FirstName: regData.FirstName || regData.firstName || "",
        MiddleName: regData.MiddleName || regData.middleName || "",
        LastName: regData.LastName || regData.lastName || "",
        email: regData.email || "",
        gender: regData.gender || "",
        ageBracket: regData.ageBracket || "",
        idNumber: regData.idNumber || "",
        county: regData.county || "",
        constituency: regData.constituency || "",
        ward: regData.ward || "",
        password: regData.password || "",
        passkey: regData.passkey || "",
        startky: regData.startky || "",
        registrationData: regData,
        status: "INITIATED",
        createdAt: new Date(data.initiatedAtMs || Date.now()),
      });
    } catch (e) {
      console.error("[Pesapal] Failed to persist pending payment to MongoDB (pendingaccount):", e.message);
    }
  }
};

const clearPendingPayment = async (req, orderId) => {
  if (req && req.session && req.session.pesapalPayments) {
    delete req.session.pesapalPayments[orderId];
  }
  if (orderId) {
    const data = globalPendingPayments.get(orderId);
    globalPendingPayments.delete(orderId);
    if (data) {
      if (data.orderTrackingId) globalPendingPayments.delete(data.orderTrackingId);
      if (data.merchantReference) globalPendingPayments.delete(data.merchantReference);
    }
  }
  // Do NOT delete from pendingaccount — we keep the record for auditing.
  // Status will be updated to VERIFIED_PENDING_COMPLETION or COMPLETED later.
};

const getVerifiedRegistrations = (req) => {
  const sessionMap = (req && req.session && req.session.pesapalVerifiedRegistrations) ? req.session.pesapalVerifiedRegistrations : {};
  const merged = { ...sessionMap };
  for (const [key, val] of globalVerifiedRegistrations.entries()) {
    if (!merged[key]) {
      merged[key] = val;
    }
  }
  return merged;
};

const setVerifiedRegistration = (req, verificationNonce, data) => {
  if (req && req.session) {
    if (!req.session.pesapalVerifiedRegistrations) {
      req.session.pesapalVerifiedRegistrations = {};
    }
    req.session.pesapalVerifiedRegistrations[verificationNonce] = data;
  }
  if (verificationNonce) {
    globalVerifiedRegistrations.set(verificationNonce, data);
  }
};

const consumeVerifiedRegistration = (req, verificationNonce) => {
  let found = null;
  if (req && req.session && req.session.pesapalVerifiedRegistrations) {
    found = req.session.pesapalVerifiedRegistrations[verificationNonce];
    if (found) delete req.session.pesapalVerifiedRegistrations[verificationNonce];
  }
  if (!found && verificationNonce) {
    found = globalVerifiedRegistrations.get(verificationNonce) || null;
    if (found) globalVerifiedRegistrations.delete(verificationNonce);
  }
  return found || null;
};

const normPhoneDigits = (s) => String(s || "").replace(/\D/g, "").replace(/^254/, "");

const getLast5Digits = (s) => {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(-5) : "";
};

const phoneMatchesLast5 = (a, b) => {
  const la = getLast5Digits(a);
  const lb = getLast5Digits(b);
  return !!la && !!lb && la === lb;
};

const findVerifiedRegistrationByPhone = async (req, inputPhone) => {
  if (!inputPhone) return null;
  const target = normPhoneDigits(inputPhone);
  const targetLast5 = getLast5Digits(inputPhone);
  if (!target && !targetLast5) return null;

  if (PendingAccount && getAllPendingFlattened) {
    try {
      const docs = await getAllPendingFlattened({
        newerThanMs: 20 * 60 * 1000,
        filter: (r) => r.status === "VERIFIED_PENDING_COMPLETION",
      });
      for (const doc of docs) {
        const phoneInDoc = normPhoneDigits(doc.phoneNumber || "");
        const exactMatch = phoneInDoc && target && phoneInDoc === target;
        const last5Match = targetLast5 && phoneMatchesLast5(doc.phoneNumber || "", inputPhone);
        if (exactMatch || last5Match) {
          let regData = doc.registrationData || {};
          if (typeof regData === "string") {
            try { regData = JSON.parse(regData); } catch (_) { regData = {}; }
          }
          if (last5Match && !exactMatch) {
            console.log(`[findVerifiedRegistrationByPhone] Matched by last-5-digits: input=${inputPhone} vs doc.phone=${doc.phoneNumber}. Will prefer user's input format.`);
          }
          return {
            nonce: doc.verificationNonce || doc.orderTrackingId,
            orderTrackingId: doc.orderTrackingId,
            amount: Number(doc.amount || 0),
            chargedAmount: Number(doc.chargedAmount || 0),
            currency: doc.currency || "KES",
            statusCode: doc.statusCode,
            paymentStatusDescription: doc.paymentStatusDescription,
            paymentMethod: doc.paymentMethod,
            paymentAccount: doc.paymentAccount,
            confirmationCode: doc.confirmationCode,
            phoneNumber: doc.phoneNumber,
            registrationData: regData,
            createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
          };
        }
      }
    } catch (e) {
      console.error("[findVerifiedRegistrationByPhone] DB lookup failed:", e.message);
    }
  }

  const map = getVerifiedRegistrations(req);
  for (const [nonce, data] of Object.entries(map)) {
    if (!data) continue;
    if (data.expiresAt && data.expiresAt < Date.now()) continue;

    const phoneInPayload = normPhoneDigits(data.phoneNumber || "");
    const exactMatch = phoneInPayload && target && phoneInPayload === target;
    const last5Match = targetLast5 && phoneMatchesLast5(data.phoneNumber || "", inputPhone);
    if (exactMatch || last5Match) {
      if (last5Match && !exactMatch) {
        console.log(`[findVerifiedRegistrationByPhone] In-memory matched by last-5-digits: input=${inputPhone} vs data.phone=${data.phoneNumber}`);
      }
      return { nonce, ...data };
    }
  }
  return null;
};

const findVerifiedRegistrationByOrderTrackingId = async (orderTrackingId) => {
  if (!orderTrackingId) return null;
  if (!PendingAccount || !findPendingRecord) return null;
  try {
    const doc = await findPendingRecord(
      (r) => r.orderTrackingId === orderTrackingId,
      {
        filterStatuses: ["VERIFIED_PENDING_COMPLETION"],
        newerThanMs: 20 * 60 * 1000,
      }
    );
    if (!doc) return null;
    let regData = doc.registrationData || {};
    if (typeof regData === "string") {
      try { regData = JSON.parse(regData); } catch (_) { regData = {}; }
    }
    return {
      nonce: doc.verificationNonce || doc.orderTrackingId,
      orderId: doc.orderId,
      orderTrackingId: doc.orderTrackingId,
      merchantReference: doc.merchantReference,
      amount: Number(doc.amount || 0),
      chargedAmount: Number(doc.chargedAmount || 0),
      currency: doc.currency || "KES",
      statusCode: doc.statusCode,
      paymentStatusDescription: doc.paymentStatusDescription,
      paymentMethod: doc.paymentMethod,
      paymentAccount: doc.paymentAccount,
      confirmationCode: doc.confirmationCode,
      phoneNumber: doc.phoneNumber,
      FirstName: doc.FirstName,
      MiddleName: doc.MiddleName,
      LastName: doc.LastName,
      email: doc.email,
      gender: doc.gender,
      ageBracket: doc.ageBracket,
      idNumber: doc.idNumber,
      county: doc.county,
      constituency: doc.constituency,
      ward: doc.ward,
      registrationData: regData,
      createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
      expiresAt: (doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now()) + 20 * 60 * 1000,
      _doc: doc
    };
  } catch (e) {
    console.error("[findVerifiedRegistrationByOrderTrackingId] DB error:", e.message);
    return null;
  }
};

function isAdminSession(req) {
  const hq = req.session && req.session.hqUser;
  if (!hq) return false;
  const role = String(hq.role || "").toLowerCase();
  return role === "superadmin" || role === "admin";
}

function requireAdminOrInternalSecret(req, res, next) {
  if (isAdminSession(req)) return next();
  const envSecret = process.env.PESAPAL_ADMIN_API_SECRET || "";
  const headerSecret =
    req.headers["x-pesapal-admin-secret"] ||
    req.headers["X-Pesapal-Admin-Secret"] ||
    "";
  if (envSecret && headerSecret && envSecret === headerSecret) return next();
  return res.status(403).json({
    success: false,
    message: "Admin authentication required for this Pesapal management endpoint.",
  });
}

async function loadRegistrationFeeSettings() {
  const fallback = { amount: 0, paymentMethod: "none" };
  let source = "none";
  try {
    const { getTbankSettings } = require("./../mongoose");
    const tbankSettings = await getTbankSettings();
    if (tbankSettings && tbankSettings.compliance && tbankSettings.compliance.personal_account_registration) {
      source = "mongodb";
      return { settings: tbankSettings.compliance.personal_account_registration, source };
    }
  } catch (_mongoErr) {
    /* fall through */
  }
  try {
    const fsLib = require("fs");
    const tbankFile = path.resolve(__dirname, "..", "tbank.json");
    if (fsLib.existsSync(tbankFile)) {
      const raw = JSON.parse(fsLib.readFileSync(tbankFile, "utf8"));
      if (raw && raw.compliance && raw.compliance.personal_account_registration) {
        source = "tbank.json";
        return { settings: raw.compliance.personal_account_registration, source };
      }
    }
  } catch (_fsErr) {
    /* fall through */
  }
  return { settings: fallback, source };
}

const moneyEq = (a, b, cents = 0) => {
  const na = Number(a) || 0;
  const nb = Number(b) || 0;
  const mult = Math.pow(10, cents);
  return Math.round(na * mult) === Math.round(nb * mult);
};

const isSuccessStatus = (statusCode) => {
  const COMPLETED = 1;
  const FAILED = 2;
  const REVERSED = 3;
  const PENDING = 0;
  const PROCESSING = 101;
  const SUCCESS_CODES = new Set([COMPLETED]);
  return SUCCESS_CODES.has(Number(statusCode));
};

const isTerminalFailure = (statusCode) => {
  const FAILED = 2;
  const REVERSED = 3;
  const INVALID = 4;
  return new Set([FAILED, REVERSED, INVALID]).has(Number(statusCode));
};

const isPesapalIpnInvalid = (err) => {
  const data = err?.response?.data || {};
  const msg =
    String(
      data?.error?.message ||
        data?.message ||
        data?.error ||
        err?.message ||
        ""
    ).toLowerCase();
  return (
    msg.includes("ipn id") ||
    msg.includes("ipn_id") ||
    msg.includes("notification id") ||
    msg.includes("notification_id") ||
    msg.includes("specified ipn") ||
    msg.includes("invalid ipn")
  );
};

router.post("/initiate", async (req, res) => {
  try {
    const now = Date.now();
    if (!req.session.pesapalRateLimit) req.session.pesapalRateLimit = [];
    const recent = (req.session.pesapalRateLimit || []).filter(
      (t) => now - t < 2 * 60 * 1000
    );
    if (recent.length >= 6) {
      return res.status(429).json({
        success: false,
        message: "Too many payment attempts. Please wait 2 minutes and try again.",
      });
    }
    recent.push(now);
    req.session.pesapalRateLimit = recent;

    const { amount, registrationData } = req.body;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid amount provided." });
    }

    const { settings: feeSettings, source } = await loadRegistrationFeeSettings();
    if (!feeSettings || feeSettings.paymentMethod !== "pesapal") {
      return res.status(400).json({
        success: false,
        message: `Pesapal is not the currently enabled registration payment method on this server (source=${source}, method=${
          feeSettings?.paymentMethod || "none"
        }). No charges were made.`,
      });
    }
    const expectedAmount = Number(feeSettings.amount || 0);
    const requestedAmount = Number(amount);
    if (!moneyEq(requestedAmount, expectedAmount, 0)) {
      console.warn(
        `[Pesapal initiate] Amount mismatch from client: requested=${requestedAmount} expected=${expectedAmount} (source=${source}). Rejecting as tampering.`
      );
      return res.status(400).json({
        success: false,
        message: `Incorrect registration fee amount. Expected ${expectedAmount.toFixed(
          2
        )} KES.`,
      });
    }

    let userData = {};
    try {
      if (registrationData) {
        userData =
          typeof registrationData === "string"
            ? JSON.parse(registrationData)
            : registrationData;
      }
    } catch (parseErr) {
      console.warn("Pesapal initiate: Could not parse registrationData");
      userData = {};
    }

    const orderId = crypto.randomBytes(16).toString("hex");
    const baseUrl = getBaseUrl(req);

    const callbackUrl =
      envCallbackUrl || `${baseUrl}/api/payment/pesapal/callback`;
    const notificationId = envIpnId || "";

    const firstName = userData.FirstName || userData.firstName || "";
    const middleName = userData.MiddleName || userData.middleName || "";
    const lastName = userData.LastName || userData.lastName || "";
    const email = userData.email || "";
    const phoneNumber =
      userData.phoneNumber ||
      userData.PhoneNumber ||
      userData.phone ||
      "";

    let orderResult = null;
    let usedFallback = false;

    try {
      orderResult = await submitOrderRequest(
        {
          id: orderId,
          amount: expectedAmount,
          currency: "KES",
          description: "Cliant Account Registration Fee",
          callbackUrl: callbackUrl,
          notificationId: notificationId,
          firstName,
          middleName,
          lastName,
          email,
          phoneNumber,
        },
        { skipNotificationId: false }
      );
    } catch (primaryErr) {
      if (isPesapalIpnInvalid(primaryErr)) {
        console.warn(
          "[Pesapal initiate] IPN ID rejected by Pesapal, retrying without notification_id.",
          "Original error:",
          primaryErr.response?.data || primaryErr.message
        );
        usedFallback = true;
        try {
          orderResult = await submitOrderRequest(
            {
              id: orderId,
              amount: expectedAmount,
              currency: "KES",
              description: "Cliant Account Registration Fee",
              callbackUrl: callbackUrl,
              notificationId: "",
              firstName,
              middleName,
              lastName,
              email,
              phoneNumber,
            },
            { skipNotificationId: true }
          );
        } catch (fallbackErr) {
          throw fallbackErr;
        }
      } else {
        throw primaryErr;
      }
    }

    if (!orderResult || !orderResult.redirect_url) {
      console.error(
        "Pesapal initiate: No redirect_url returned:",
        orderResult
      );
      return res.status(500).json({
        success: false,
        message:
          orderResult?.error?.message ||
      "Failed to initiate Pesapal payment. Please check your Pesapal credentials.",
    });
  }

  await setPendingPayment(req, orderId, {
      amount: expectedAmount,
      expectedAmount: expectedAmount,
      registrationData:
        typeof registrationData === "string"
          ? registrationData
          : JSON.stringify(registrationData || {}),
      orderTrackingId: orderResult.order_tracking_id || null,
      merchantReference: orderResult.merchant_reference || orderId,
      createdAt: new Date().toISOString(),
      initiatedAtMs: now,
      status: "INITIATED",
      ipnUsed: !usedFallback && !!notificationId,
    });

    return res.json({
      success: true,
      redirect_url: orderResult.redirect_url,
      orderId: orderId,
      warning: usedFallback
        ? "Warning: Your Pesapal PESAPAL_IPN_ID value is not recognized by Pesapal. Payment will still complete via browser callback, but server webhooks (IPN) will be skipped until you fix the IPN ID. See /api/payment/pesapal/ipn-list or /api/payment/pesapal/register-ipn."
        : null,
    });
  } catch (err) {
    console.error(
      "Pesapal initiate error:",
      err.message,
      err.response?.data
    );
    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.error?.message ||
        "Server error initiating Pesapal payment. Please try again later.",
    });
  }
});

/**
 * POST /request-payment
 * Wallet Add Fund via Pesapal. Honours tbank.compliance.personal_account_registration.paymentMethod.
 * Amount is client-chosen (top-up). On successful callback, credits PersonalAccount.account.personal.
 */
router.post("/request-payment", async (req, res) => {
  try {
    const sessionUser = (req.session && req.session.user) || null;
    if (!sessionUser || !sessionUser.phoneNumber) {
      return res.status(401).json({ success: false, message: "Please log in to add funds." });
    }

    const { settings: feeSettings, source } = await loadRegistrationFeeSettings();
    const method = String(feeSettings?.paymentMethod || "").toLowerCase();
    if (method !== "pesapal") {
      return res.status(400).json({
        success: false,
        message: `Pesapal is not the active payment method (source=${source}, method=${method || "none"}).`,
        paymentMethod: method || "none",
      });
    }

    const amount = Number(req.body.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount provided." });
    }

    const creditPhone = String(sessionUser.phoneNumber).trim();
    const payerPhone = String(req.body.phone || req.body.payerPhone || creditPhone).trim();
    if (!payerPhone) {
      return res.status(400).json({ success: false, message: "Payer phone number is required." });
    }

    const orderId = crypto.randomBytes(16).toString("hex");
    const baseUrl = getBaseUrl(req);
    const callbackUrl = envCallbackUrl || `${baseUrl}/api/payment/pesapal/callback`;
    const notificationId = envIpnId || "";

    const firstName = sessionUser.FirstName || sessionUser.firstName || sessionUser.name || "";
    const middleName = sessionUser.MiddleName || sessionUser.middleName || "";
    const lastName = sessionUser.LastName || sessionUser.lastName || "";
    const email = sessionUser.email || "";

    const registrationData = {
      purpose: "wallet_topup",
      creditPhone,
      payerPhone,
      phoneNumber: payerPhone,
      FirstName: firstName,
      MiddleName: middleName,
      LastName: lastName,
      email,
      county: sessionUser.county || "",
      constituency: sessionUser.constituency || "",
      ward: sessionUser.ward || "",
    };

    let orderResult = null;
    let usedFallback = false;
    const orderPayload = {
      id: orderId,
      amount,
      currency: "KES",
      description: "Cliant Wallet Add Fund",
      callbackUrl,
      notificationId,
      firstName,
      middleName,
      lastName,
      email,
      phoneNumber: payerPhone,
    };

    try {
      orderResult = await requestPayment(orderPayload, { skipNotificationId: false });
    } catch (primaryErr) {
      if (isPesapalIpnInvalid(primaryErr)) {
        usedFallback = true;
        orderResult = await requestPayment(
          { ...orderPayload, notificationId: "" },
          { skipNotificationId: true }
        );
      } else {
        throw primaryErr;
      }
    }

    if (!orderResult || !orderResult.redirect_url) {
      return res.status(500).json({
        success: false,
        message:
          orderResult?.error?.message ||
          "Failed to initiate Pesapal wallet payment.",
      });
    }

    const now = Date.now();
    await setPendingPayment(req, orderId, {
      purpose: "wallet_topup",
      creditPhone,
      payerPhone,
      amount,
      expectedAmount: amount,
      registrationData: JSON.stringify(registrationData),
      orderTrackingId: orderResult.order_tracking_id || null,
      merchantReference: orderResult.merchant_reference || orderId,
      createdAt: new Date().toISOString(),
      initiatedAtMs: now,
      status: "INITIATED",
      ipnUsed: !usedFallback && !!notificationId,
    });

    return res.json({
      success: true,
      paymentMethod: "pesapal",
      redirect_url: orderResult.redirect_url,
      orderId,
      warning: usedFallback
        ? "Pesapal IPN ID may be invalid; payment will complete via browser callback."
        : null,
    });
  } catch (err) {
    console.error("Pesapal request-payment error:", err.message, err.response?.data);
    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.error?.message ||
        "Server error initiating Pesapal wallet payment.",
    });
  }
});

async function handlePesapalCallback(req, res) {
  const {
    OrderTrackingId,
    OrderMerchantReference,
    OrderNotificationType,
  } = req.query;

  if (!OrderTrackingId) {
    return res
      .status(400)
      .send("Invalid Pesapal callback: Missing OrderTrackingId.");
  }

  const payments = await getPendingPayment(req);
  let matchedOrderId = null;
  let pending = null;

  for (const [orderId, data] of Object.entries(payments)) {
    if (
      data.orderTrackingId === OrderTrackingId ||
      orderId === OrderMerchantReference ||
      data.merchantReference === OrderMerchantReference
    ) {
      matchedOrderId = orderId;
      pending = data;
      break;
    }
  }

  if (!pending || !matchedOrderId) {
    console.warn(
      "Pesapal callback: Could not find pending payment for tracking id:",
      OrderTrackingId
    );
    return res.redirect(
      "/register?message=Payment%20session%20not%20found.%20Please%20try%20again."
    );
  }

  try {
    const statusResult = await getTransactionStatus(OrderTrackingId);
    const statusCode = statusResult?.status_code;
    const paymentStatusDescription = statusResult?.payment_status_description || "";
    const chargedAmount = Number(statusResult?.amount || pending.amount || 0);
    const currency = String(statusResult?.currency || "KES").toUpperCase();
    const paymentMethod = statusResult?.payment_method || "MPESA";
    const paymentAccount = statusResult?.payment_account || "";
    const confirmationCode = statusResult?.confirmation_code || "";

    console.log(
      `[Pesapal Callback] Order=${matchedOrderId} status_code=${statusCode} desc=${paymentStatusDescription} amount=${chargedAmount} currency=${currency} method=${paymentMethod} account=${paymentAccount} code=${confirmationCode}`
    );

    const expectedAmount = Number(pending.expectedAmount ?? pending.amount ?? 0);
    const amountOk = moneyEq(chargedAmount, expectedAmount, 0);
    const currencyOk = currency === "KES" || currency === "";

     if (isSuccessStatus(statusCode) && amountOk && currencyOk) {
       await clearPendingPayment(req, matchedOrderId);
      const createdAt = Date.now();
      const strOrderTrackingId = String(OrderTrackingId || "");

      let userData = {};
      try {
        userData =
          typeof pending.registrationData === "string"
            ? JSON.parse(pending.registrationData)
            : pending.registrationData || {};
      } catch (_e) { userData = {}; }

      const fullName = [
        userData.FirstName || userData.firstName || "",
        userData.MiddleName || userData.middleName || "",
        userData.LastName || userData.lastName || ""
      ].filter(Boolean).join(" ") || "Valued Member";

      const phoneNumber =
        userData.phoneNumber ||
        userData.PhoneNumber ||
        userData.phone ||
        "";

      let resolvedPhone = String(phoneNumber || paymentAccount || "");
      if (paymentAccount && phoneNumber) {
        if (phoneMatchesLast5(paymentAccount, phoneNumber)) {
          resolvedPhone = String(phoneNumber).trim();
          console.log(
            `[Pesapal Callback] LAST-5 MATCH OK: callback(${paymentAccount}) vs input(${phoneNumber}). ` +
              `Using USER INPUT phone as canonical for PendingAccount.`
          );
        } else {
          console.warn(
            `[Pesapal Callback] LAST-5 MISMATCH: callback(${paymentAccount} last5=${getLast5Digits(paymentAccount)}) ` +
              `vs input(${phoneNumber} last5=${getLast5Digits(phoneNumber)}). ` +
              `Using USER INPUT phone anyway (user's format preferred).`
          );
          resolvedPhone = String(phoneNumber).trim();
        }
      } else if (paymentAccount && !phoneNumber) {
        console.warn(
          `[Pesapal Callback] No user input phone available — falling back to callback paymentAccount=${paymentAccount}`
        );
        resolvedPhone = String(paymentAccount).trim();
      }

      const purpose = String(pending.purpose || userData.purpose || "").toLowerCase();
      if (purpose === "wallet_topup") {
        const creditPhone = String(
          pending.creditPhone || userData.creditPhone || resolvedPhone || ""
        ).trim();
        const payerPhone = String(
          pending.payerPhone || userData.payerPhone || resolvedPhone || paymentAccount || ""
        ).trim();
        try {
          const topUp = await creditWalletTopUp({
            phone: creditPhone,
            amount: expectedAmount,
            reference: confirmationCode || strOrderTrackingId || OrderMerchantReference || "",
            paymentMethod: "pesapal",
            payerPhone,
            notes: "Wallet Add Fund via Pesapal",
          });
          console.log(
            `[Pesapal Callback] Wallet top-up result for ${creditPhone}:`,
            topUp.success ? `OK balance=${topUp.balance}` : topUp.reason
          );
        } catch (topErr) {
          console.error("[Pesapal Callback] creditWalletTopUp error:", topErr.message);
        }

        return res.send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Wallet Top-up Successful</title>
            <style>
              body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
                background:linear-gradient(160deg,#0f2027,#203a43,#2c5364);font-family:system-ui,sans-serif;padding:16px;}
              .card{background:#fff;border-radius:12px;max-width:420px;width:100%;padding:28px 22px;text-align:center;
                box-shadow:0 20px 50px rgba(0,0,0,.3);}
              h1{font-size:20px;margin:0 0 8px;color:#166534;}
              p{font-size:14px;color:#475569;line-height:1.5;margin:0 0 18px;}
              a{display:inline-block;padding:12px 18px;background:linear-gradient(135deg,#0c8f44,#34d399);
                color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;}
            </style>
            <script>setTimeout(function(){ window.location.replace('/personal'); }, 2500);</script>
          </head>
          <body>
            <div class="card">
              <h1>Payment Successful</h1>
              <p>KSh ${Number(expectedAmount).toLocaleString()} has been added to your personal wallet.</p>
              <a href="/personal">Back to Wallet</a>
            </div>
          </body>
        </html>`);
      }

      if (PendingAccount && upsertPendingAccount) {
        try {
          await upsertPendingAccount({
            orderId: matchedOrderId,
            orderTrackingId: strOrderTrackingId,
            merchantReference: OrderMerchantReference || pending.merchantReference || matchedOrderId,
            amount: expectedAmount,
            chargedAmount,
            currency,
            statusCode,
            paymentStatusDescription,
            paymentMethod,
            paymentAccount,
            confirmationCode,
            verificationNonce: strOrderTrackingId,
            phoneNumber: resolvedPhone,
            FirstName: userData.FirstName || userData.firstName || "",
            MiddleName: userData.MiddleName || userData.middleName || "",
            LastName: userData.LastName || userData.lastName || "",
            email: userData.email || "",
            gender: userData.gender || "",
            ageBracket: userData.ageBracket || "",
            idNumber: userData.idNumber || "",
            county: userData.county || "",
            constituency: userData.constituency || "",
            ward: userData.ward || "",
            password: userData.password || "",
            passkey: userData.passkey || "",
            startky: userData.startky || "",
            registrationData: userData,
            status: "VERIFIED_PENDING_COMPLETION",
            createdAt: new Date(createdAt),
          });
          console.log(`[Pesapal Callback] Saved callback info to Mongoose 'pendingaccount' collection (OrderTrackingId: ${strOrderTrackingId})`);

          if (resolvedPhone && expectedAmount > 0) {
            try {
              await creditPendingHolding({
                phone: resolvedPhone,
                county: userData.county || "",
                constituency: userData.constituency || "",
                ward: userData.ward || "",
                amount: expectedAmount,
                reference: strOrderTrackingId || OrderMerchantReference || "",
                paymentMethod: paymentMethod || "pesapal",
                notes: "Registration fee received — held pending account completion",
              });
            } catch (holdErr) {
              console.error("[Pesapal Callback] creditPendingHolding error:", holdErr.message);
            }
          }
        } catch (dbErr) {
          console.error("[Pesapal Callback] Error saving to pendingaccount collection:", dbErr.message);
        }
      }

      const rdEscaped = String(pending.registrationData || "{}")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      const uName = userData.name || [userData.FirstName || userData.firstName, userData.MiddleName || userData.middleName, userData.LastName || userData.lastName].filter(Boolean).join(' ') || fullName || '';
      const uEmail = userData.email || '';
      const uPhone = resolvedPhone || userData.phoneNumber || userData.phone || '';
      const uIdNumber = userData.idNumber || '';
      const uGender = userData.gender || '';
      const uAgeBracket = userData.ageBracket || '';
      const uCounty = pending.county || userData.county || '';
      const uConstituency = pending.constituency || userData.constituency || '';
      const uWard = pending.ward || userData.ward || '';

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
            <title>Tbank Investment - Complete Your Registration</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
              }
              body {
                min-height: 100vh;
                min-height: -webkit-fill-available;
                display: flex;
                justify-content: center;
                align-items: center;
                background: linear-gradient(160deg, #0f2027, #203a43, #2c5364);
                padding: 12px;
              }
              html {
                height: -webkit-fill-available;
              }
              .container {
                width: 100%;
                max-width: 480px;
              }
              .card {
                background: #ffffff;
                border-radius: 8px;
                box-shadow: 0 25px 60px rgba(0, 0, 0, 0.35);
                overflow: hidden;
              }
              .header {
                text-align: center;
                background: linear-gradient(135deg, #0f9d58, #34d399);
                padding: 30px 20px;
                color: white;
              }
              .header h1 {
                font-size: 24px;
                font-weight: 800;
                color: white;
                margin: 0;
                letter-spacing: -0.5px;
                text-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
              .header p {
                font-size: 11px;
                color: rgba(255,255,255,0.95);
                text-transform: uppercase;
                letter-spacing: 2px;
                font-weight: 700;
                margin-top: 4px;
              }
              .card-body {
                padding: 24px 20px;
              }
              .status-badge {
                background: #f0fdf4;
                border: 1px solid #bbf7d0;
                color: #15803d;
                padding: 10px 14px;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 600;
                text-align: center;
                margin-bottom: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
              }
              .details-grid {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                padding: 12px 16px;
                margin-bottom: 20px;
              }
              .detail-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid #e2e8f0;
              }
              .detail-row:last-child {
                border-bottom: none;
              }
              .detail-label {
                font-size: 12px;
                font-weight: 600;
                color: #64748b;
                text-transform: uppercase;
                letter-spacing: 0.5px;
              }
              .detail-value {
                font-size: 14px;
                font-weight: 600;
                color: #0f172a;
                text-align: right;
                word-break: break-word;
                max-width: 65%;
              }
              .btn {
                width: 100%;
                padding: 15px;
                background: linear-gradient(135deg, #0f9d58, #34d399);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 16px;
                font-weight: 700;
                cursor: pointer;
                transition: 0.3s;
                box-shadow: 0 4px 15px rgba(15, 157, 88, 0.3);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                -webkit-tap-highlight-color: transparent;
              }
              .btn:hover {
                background: linear-gradient(135deg, #0b8046, #2ebd85);
                box-shadow: 0 6px 20px rgba(15, 157, 88, 0.45);
              }
              .btn:active {
                transform: scale(0.98);
              }
              .btn-spinner {
                display: none;
                width: 18px;
                height: 18px;
                border: 2px solid rgba(255,255,255,0.3);
                border-top-color: white;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
              }
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
              .btn.loading .btn-text {
                opacity: 0.8;
              }
              .btn.loading .btn-spinner {
                display: inline-block;
              }
              .btn.loading {
                pointer-events: none;
                opacity: 0.85;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="card">
                <div class="header">
                  <h1>TBANK INVESTMENT</h1>
                  <p>Complete Your Registration</p>
                </div>
                <div class="card-body">
                  <div class="status-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Payment Successful & Account Ready
                  </div>

                  <div class="details-grid">
                    ${uName ? `<div class="detail-row"><span class="detail-label">Name</span><span class="detail-value">${uName}</span></div>` : ''}
                    ${uPhone ? `<div class="detail-row"><span class="detail-label">Phone</span><span class="detail-value">${uPhone}</span></div>` : ''}
                    ${uEmail ? `<div class="detail-row"><span class="detail-label">Email</span><span class="detail-value">${uEmail}</span></div>` : ''}
                    ${uIdNumber ? `<div class="detail-row"><span class="detail-label">ID Number</span><span class="detail-value">${uIdNumber}</span></div>` : ''}
                    ${uGender ? `<div class="detail-row"><span class="detail-label">Gender</span><span class="detail-value">${uGender}</span></div>` : ''}
                    ${uAgeBracket ? `<div class="detail-row"><span class="detail-label">Age Bracket</span><span class="detail-value">${uAgeBracket}</span></div>` : ''}
                    ${(uCounty || uConstituency || uWard) ? `<div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">${[uWard, uConstituency, uCounty].filter(Boolean).join(', ')}</span></div>` : ''}
                  </div>

                  <form id="completeForm" action="/complete-registration" method="POST">
                    <input type="hidden" name="registrationData" value="${rdEscaped}">
                    <input type="hidden" name="paymentConfirmed" value="true">
                    <input type="hidden" name="paymentProvider" value="pesapal">
                    <input type="hidden" name="__order_tracking_id" value="${strOrderTrackingId}">
                    <input type="hidden" name="passkey" value="">
                    <button type="submit" class="btn" id="submitBtn">
                      <span class="btn-spinner"></span>
                      <span class="btn-text">Complete Registration</span>
                    </button>
                  </form>
                </div>
              </div>
            </div>

            <script>
              const form = document.getElementById('completeForm');
              const btn = document.getElementById('submitBtn');
              form.addEventListener('submit', function() {
                btn.classList.add('loading');
              });
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (isSuccessStatus(statusCode) && (!amountOk || !currencyOk)) {
      console.error(
       `[Pesapal Callback] FRAUD SUSPICION: status=COMPLETED but amount/currency mismatch. ` +
           `expectedAmount=${expectedAmount} chargedAmount=${chargedAmount} expectedCurrency=KES chargedCurrency=${currency}. orderId=${matchedOrderId}. Clearing session.`
       );
       await clearPendingPayment(req, matchedOrderId);
       const msg = encodeURIComponent(
        "Payment verification mismatch. Please contact support if you have already been charged. Do NOT submit multiple duplicate forms."
      );
      return res.redirect(`/register?message=${msg}`);
    }

     if (isTerminalFailure(statusCode)) {
       await clearPendingPayment(req, matchedOrderId);
       const msg = encodeURIComponent(
         `Pesapal payment failed: ${paymentStatusDescription || "Transaction was not completed."} Please try again.`
      );
      return res.redirect(`/register?message=${msg}`);
    }

    const msg = encodeURIComponent(
      `Pesapal payment is still processing. Status: ${
        paymentStatusDescription || "Pending"
      }. Please wait a moment then try registering again.`
    );
    return res.redirect(`/register?message=${msg}`);
  } catch (err) {
    console.error("Pesapal callback error:", err.message);
    const msg = encodeURIComponent(
      "Server error verifying Pesapal payment. Please try again later."
    );
    return res.redirect(`/register?message=${msg}`);
  }
}

async function hasPendingTrackingId(req, orderTrackingId) {
  if (!orderTrackingId) return false;
  const payments = await getPendingPayment(req) || {};
  for (const data of Object.values(payments)) {
    if (data && data.orderTrackingId === orderTrackingId) return true;
    if (data && data.merchantReference && (
      data.merchantReference === orderTrackingId
    )) return true;
  }
  return false;
}

async function handlePesapalIpnGet(req, res) {
  const { OrderTrackingId, OrderNotificationType } = req.query;
  const envSecret = process.env.PESAPAL_IPN_SECRET || "";
  const suppliedSecret = String(req.query.ipn_secret || req.query.secret || "");
  if (envSecret && suppliedSecret !== envSecret) {
    console.warn(
      "[Pesapal IPN (GET)] Ignoring request without matching IPN secret (configured in PESAPAL_IPN_SECRET).",
      "OTID=", OrderTrackingId
    );
    return res.status(204).end();
  }
  console.log(
    `[Pesapal IPN (GET)] OrderTrackingId=${OrderTrackingId} Type=${OrderNotificationType}`
  );

  if (OrderTrackingId && await hasPendingTrackingId(req, OrderTrackingId)) {
    try {
      const status = await getTransactionStatus(OrderTrackingId);
      console.log(
        `[Pesapal IPN] Verified status for ${OrderTrackingId}:`,
        status?.payment_status_description,
        "code:",
        status?.status_code
      );
    } catch (err) {
      console.error("[Pesapal IPN] Verify status error:", err.message);
    }
  }

  res.status(200).end();
}

async function handlePesapalIpnPost(req, res) {
  const body = req.body || {};
  const OrderTrackingId = body.OrderTrackingId || body.order_tracking_id;
  const envSecret = process.env.PESAPAL_IPN_SECRET || "";
  const suppliedSecret = String(
    body.ipn_secret ||
    body.secret ||
    req.query.ipn_secret ||
    req.query.secret ||
    ""
  );
  if (envSecret && suppliedSecret !== envSecret) {
    console.warn(
      "[Pesapal IPN (POST)] Ignoring request without matching IPN secret.",
      "OTID=", OrderTrackingId
    );
    return res.status(204).end();
  }
  console.log(`[Pesapal IPN (POST)] payload:`, body);

  if (OrderTrackingId && await hasPendingTrackingId(req, OrderTrackingId)) {
    try {
      const status = await getTransactionStatus(OrderTrackingId);
      console.log(
        `[Pesapal IPN (POST)] Verified status for ${OrderTrackingId}:`,
        status?.payment_status_description,
        "code:",
        status?.status_code
      );
    } catch (err) {
      console.error("[Pesapal IPN (POST)] Verify status error:", err.message);
    }
  }

  res.status(200).json({ success: true });
}

router.get("/callback", handlePesapalCallback);
router.get("/pesapal-callback", handlePesapalCallback);
router.get("/register/pesapal-callback", handlePesapalCallback);

router.get("/ipn", handlePesapalIpnGet);

router.post("/ipn", handlePesapalIpnPost);

router.post("/register-ipn", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const { ipnUrl, notificationType } = req.body;
    if (!ipnUrl && !envIpnUrl) {
      return res
        .status(400)
        .json({ success: false, message: "IPN URL is required." });
    }
    const result = await registerIpnUrl(
      ipnUrl || envIpnUrl,
      notificationType || "GET"
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Pesapal register IPN error:", err.message);
    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.error?.message ||
        "Failed to register Pesapal IPN URL.",
    });
  }
});

router.get("/ipn-list", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const list = await getIpnList();
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error("Pesapal get IPN list error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to list Pesapal IPNs.",
    });
  }
});

router.post("/ensure-ipn", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const { preferredNotifType, writeFile, log } = req.body || {};
    const result = await ensureValidIpn({
      preferredNotifType: preferredNotifType || "POST",
      writeFile: writeFile !== false,
      log: log === true,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Pesapal ensure-ipn error:", err?.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err?.response?.data?.error?.message || err.message || "Failed to ensure a valid Pesapal IPN configuration.",
      raw: err?.response?.data || null,
    });
  }
});

module.exports = router;
module.exports.handlePesapalCallback = handlePesapalCallback;
module.exports.handlePesapalIpnGet = handlePesapalIpnGet;
module.exports.handlePesapalIpnPost = handlePesapalIpnPost;
module.exports.ensureValidIpn = ensureValidIpn;
module.exports.runColdStartVerification = runColdStartVerification;
module.exports.writeEnvWithIpnId = writeEnvWithIpnId;
module.exports.readEnvFile = readEnvFile;
module.exports.ENV_PATH = ENV_PATH;
module.exports.consumeVerifiedRegistration = consumeVerifiedRegistration;
module.exports.findVerifiedRegistrationByPhone = findVerifiedRegistrationByPhone;
module.exports.findVerifiedRegistrationByOrderTrackingId = findVerifiedRegistrationByOrderTrackingId;
module.exports.requireAdminOrInternalSecret = requireAdminOrInternalSecret;
module.exports.normPhoneDigits = normPhoneDigits;
module.exports.getLast5Digits = getLast5Digits;
module.exports.phoneMatchesLast5 = phoneMatchesLast5;

async function runCliSetup() {
  try {
    require("dotenv").config({ override: true });
    console.log("== Step 0: Loaded env from .env (override mode) ==");
    console.log("  PESAPAL_ENVIRONMENT  =", process.env.PESAPAL_ENVIRONMENT);
    console.log("  PESAPAL_CONSUMER_KEY starts with =", (process.env.PESAPAL_CONSUMER_KEY || "").slice(0, 6) + "...");
    console.log("  PESAPAL_IPN_URL      =", process.env.PESAPAL_IPN_URL);
    console.log("  PESAPAL_IPN_ID       =", process.env.PESAPAL_IPN_ID);

    const result = await ensureValidIpn({
      preferredNotifType: "POST",
      writeFile: true,
      log: true,
    });

    console.log("\n== Summary ==");
    console.log("  Action taken       :", result.actionTaken);
    console.log("  Final IPN ID       :", result.ipnId);
    console.log("  Final IPN URL      :", result.ipnUrl);
    console.log("  IPN notif. type    :", result.preferredNotifType);
    console.log("  .env file updated  :", result.envWritten, " at ", result.envPath);

    console.log("\n== Step 5: Cold-start verification (fresh node process) ==");
    const code = await runColdStartVerification(result.ipnId);
    if (code !== 0) {
      console.log("\n❌ Cold-start verification did not pass, exit code:", code);
      process.exit(code || 7);
    }

    console.log("\nDone. Restart the server (kill old + run npm start / nodemon) so dotenv re-reads .env with override:true.");
    process.exit(0);
  } catch (err) {
    console.error("❌ CLI setup failed:", err?.response?.data || err?.message || err);
    process.exit(99);
  }
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--setup-ipn") || args.includes("setup-ipn") || args.length === 0) {
    runCliSetup();
  } else {
    console.log("routes/pesapal.js — usage:");
    console.log("  node routes/pesapal.js --setup-ipn    Run the Pesapal IPN validator/registrar + write IPN ID to .env");
    process.exit(1);
  }
}
