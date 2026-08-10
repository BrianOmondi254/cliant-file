/**
 * trans.js
 *
 * Handles post-registration money movement into the PersonalAccount collection.
 *
 * Account flow:
 *
 *   STEP A — PendingAccount updated (payment received, not yet completed):
 *     creditPendingHolding(phone, amount, ...)
 *       → Creates/updates PersonalAccount
 *       → Adds amount to account.pending.value
 *       → Logs a "pending" transaction: Registrar → Pending Holding
 *
 *   STEP B — Complete Registration executed:
 *     settlePendingToPersonal(phone, amount, ...)
 *       → Deducts amount from account.pending.value
 *       → Adds amount to account.personal.personal + reg_fee + openBalance
 *       → Clears account.personal.pendingBalance by the same amount
 *       → Logs a "received" (completed) transaction: Pending Holding → Personal
 *
 *   transferRegistrarFeeToPersonal(...)  (legacy / direct-register path)
 *       → Used for direct POST /register (passkey/Pesapal/M-Pesa paid inline).
 *       → Credits account.personal directly + logs transaction.
 *
 *   creditPendingToPersonalAccount(...)  (legacy / complete-registration path)
 *       → Used by POST /complete-registration (Pesapal callback confirmation).
 *       → Credits account.personal openBalance + pendingBalance.
 */

const { County, PersonalAccount, normalizePhone } = require("../mongoose");

// ---------------------------------------------------------------------------
// Helper: verify phone in county collection
// ---------------------------------------------------------------------------
/**
 * Confirms a phone number exists somewhere in the County collection's
 * nested county → constituency → ward → data hierarchy.
 *
 * @param {string} phoneNumber
 * @returns {Promise<{found: boolean, county?: string, constituency?: string, ward?: string}>}
 */
async function verifyPhoneInCounty(phoneNumber) {
  const target = normalizePhone(phoneNumber);
  if (!target) return { found: false };

  const countyDoc = await County.findOne({
    "constituencies.wards.data.phoneNumber": phoneNumber,
  }).lean();

  if (!countyDoc) return { found: false };

  for (const cons of countyDoc.constituencies || []) {
    for (const ward of cons.wards || []) {
      const match = (ward.data || []).find(
        (u) => normalizePhone(u.phoneNumber) === target,
      );
      if (match) {
        return {
          found: true,
          county: countyDoc.county,
          constituency: cons.name,
          ward: ward.name,
        };
      }
    }
  }

  return { found: false };
}

// ---------------------------------------------------------------------------
// STEP A: Credit pending holding (PendingAccount stage)
// ---------------------------------------------------------------------------
/**
 * Called when a PendingAccount record is created/updated with a verified
 * payment. Creates or updates the PersonalAccount for this phone number and
 * parks the registration fee in account.pending.value so it appears in the
 * ledger immediately. The money stays there until the member completes
 * registration (settlePendingToPersonal moves it to account.personal).
 *
 * NOTE: This can be called BEFORE the user exists in the County collection,
 * so it does NOT call verifyPhoneInCounty. The caller must supply county,
 * constituency, and ward from the PendingAccount record.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.county
 * @param {string} params.constituency
 * @param {string} params.ward
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]  e.g. "pesapal" | "mpesa" | "passkey"
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object}>}
 */
async function creditPendingHolding({
  phone,
  county,
  constituency,
  ward,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const holdAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!holdAmount || holdAmount <= 0) return { success: false, reason: "INVALID_AMOUNT" };
  if (!county || !constituency || !ward) return { success: false, reason: "MISSING_REGION" };

  const now = new Date();
  const existing = await PersonalAccount.findOne({ phone }).lean();
  const prevPendingValue = existing?.account?.pending?.value || 0;
  const newPendingValue = prevPendingValue + holdAmount;
  const prevOpenBalance = existing?.account?.personal?.openBalance || 0;

  const update = {
    $setOnInsert: {
      phone,
      county,
      constituency,
      ward,
      createdAt: now,
      "account.business": { name: "", "total-bal": 0, float: 0, benefit: 0 },
    },
    $set: {
      updatedAt: now,
      "account.pending.value": newPendingValue,
    },
    $push: {
      transactions: {
        reference: reference || "PENDING-HOLD",
        time: now,
        openingBalance: prevOpenBalance,
        amount: holdAmount,
        type: "received",
        from: {
          name: "Registrar",
          number: "REGISTRAR-HOLDING",
        },
        to: { name: "Pending Holding", number: phone },
        closingBalance: prevOpenBalance, // personal balance unchanged at this stage
        environment: paymentMethod,
        notes: notes || "Registration fee received — held pending account completion",
        status: "pending",
      },
    },
  };

  try {
    const doc = await PersonalAccount.findOneAndUpdate({ phone }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    console.log(
      `[trans] creditPendingHolding: parked ${holdAmount} in account.pending.value for ${phone} ` +
        `(new pending.value=${newPendingValue})`,
    );
    return { success: true, account: doc };
  } catch (err) {
    console.error("[trans] Error in creditPendingHolding:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// STEP B: Settle pending → personal (Complete Registration stage)
// ---------------------------------------------------------------------------
/**
 * Called when the member clicks "Complete Registration" from the pending
 * account popup. Moves `amount` FROM account.pending.value TO account.personal,
 * and records the settlement as a completed transaction.
 *
 * The function verifies the phone is now registered in the County collection
 * before moving funds.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object}>}
 */
async function settlePendingToPersonal({
  phone,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const settleAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!settleAmount || settleAmount <= 0) return { success: false, reason: "INVALID_AMOUNT" };

  // Verify the phone is now in the County collection (registration must have landed).
  const membership = await verifyPhoneInCounty(phone);
  if (!membership.found) {
    console.warn(
      `[trans] settlePendingToPersonal: phone not in County yet — ${phone}`,
    );
    return { success: false, reason: "NOT_REGISTERED" };
  }

  const now = new Date();
  const existing = await PersonalAccount.findOne({ phone }).lean();

  const prevPendingValue = existing?.account?.pending?.value || 0;
  const prevOpenBalance = existing?.account?.personal?.openBalance || 0;
  const prevPendingBalance = existing?.account?.personal?.pendingBalance || 0;
  const prevRegFee = existing?.account?.personal?.reg_fee || 0;
  const prevPersonal = existing?.account?.personal?.personal || 0;

  // Deduct from pending holding (floor at 0 to avoid negative).
  const newPendingValue = Math.max(0, prevPendingValue - settleAmount);

  // Credit personal balances.
  const newOpenBalance = prevOpenBalance + settleAmount;
  const newPendingBalance = Math.max(0, prevPendingBalance - settleAmount); // clear the pending entry
  const newRegFee = prevRegFee + settleAmount;
  const newPersonal = prevPersonal + settleAmount;

  const update = {
    $set: {
      updatedAt: now,
      "account.pending.value": newPendingValue,
      "account.personal.reg_fee": newRegFee,
      "account.personal.personal": newPersonal,
      "account.personal.openBalance": newOpenBalance,
      "account.personal.pendingBalance": newPendingBalance,
    },
    $push: {
      transactions: {
        reference: reference || "SETTLE-PENDING",
        time: now,
        openingBalance: prevOpenBalance,
        amount: settleAmount,
        type: "received",
        from: {
          name: "Pending Holding",
          number: "PENDING-HOLDING",
        },
        to: { name: "Personal Account", number: phone },
        closingBalance: newOpenBalance,
        environment: paymentMethod,
        notes: notes || "Pending holding → Personal account (registration completed)",
        status: "completed",
      },
    },
  };

  try {
    const doc = await PersonalAccount.findOneAndUpdate({ phone }, update, {
      new: true,
      runValidators: true,
    });
    if (!doc) {
      console.warn(`[trans] settlePendingToPersonal: no PersonalAccount found for ${phone}`);
      return { success: false, reason: "ACCOUNT_NOT_FOUND" };
    }
    console.log(
      `[trans] settlePendingToPersonal: moved ${settleAmount} from pending.value to personal for ${phone} ` +
        `— pending.value=${newPendingValue}, personal.openBalance=${newOpenBalance}, ` +
        `personal.pendingBalance=${newPendingBalance}`,
    );
    return { success: true, account: doc };
  } catch (err) {
    console.error("[trans] Error in settlePendingToPersonal:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Legacy: creditPendingToPersonalAccount (used by /complete-registration)
// ---------------------------------------------------------------------------
/**
 * Credits `amount` into a member's PersonalAccount, keyed by phone number.
 * Adds to openBalance immediately and logs a "pending" transaction that
 * also adds to pendingBalance.
 *
 * Looks up the phone in the County collection first — if the number isn't
 * a registered member there, the credit is refused (NOT_REGISTERED).
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]  e.g. "mpesa" | "pesapal" | "passkey"
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object}>}
 */
async function creditPendingToPersonalAccount({
  phone,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const creditAmount = Number(amount || 0);
  if (!phone) {
    return { success: false, reason: "NO_PHONE" };
  }
  if (!creditAmount || creditAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }

  // 1. Verify the phone number is a registered member in the County collection.
  const membership = await verifyPhoneInCounty(phone);
  if (!membership.found) {
    console.warn(`[trans] Refusing credit — phone not found in County collection: ${phone}`);
    return { success: false, reason: "NOT_REGISTERED" };
  }

  // 2. Locate (or lazily create) the PersonalAccount for this phone.
  const existing = await PersonalAccount.findOne({ phone }).lean();
  const prevOpenBalance = existing?.account?.personal?.openBalance || 0;
  const prevPendingBalance = existing?.account?.personal?.pendingBalance || 0;
  const prevRegFee = existing?.account?.personal?.reg_fee || 0;
  const prevPersonal = existing?.account?.personal?.personal || 0;

  const newOpenBalance = prevOpenBalance + creditAmount;
  const newPendingBalance = prevPendingBalance + creditAmount;
  const newRegFee = prevRegFee + creditAmount;
  const newPersonal = prevPersonal + creditAmount;
  const now = new Date();

  const update = {
    $setOnInsert: {
      phone,
      county: membership.county,
      constituency: membership.constituency,
      ward: membership.ward,
      createdAt: now,
      "account.business": { name: "", "total-bal": 0, float: 0, benefit: 0 },
    },
    $set: {
      updatedAt: now,
      "account.personal.reg_fee": newRegFee,
      "account.personal.personal": newPersonal,
      "account.personal.openBalance": newOpenBalance,
      "account.personal.pendingBalance": newPendingBalance,
    },
    $push: {
      transactions: {
        reference,
        time: now,
        openingBalance: prevOpenBalance,
        amount: creditAmount,
        type: "received",
        from: {
          name: "Registrar",
          number: "REGISTRAR-HOLDING",
        },
        to: { name: "Personal Account", number: phone },
        closingBalance: newOpenBalance,
        environment: paymentMethod,
        notes: notes || "Registrar → Personal (registration credit)",
        status: "pending",
      },
    },
  };

  try {
    const doc = await PersonalAccount.findOneAndUpdate({ phone }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    console.log(
      `[trans] Credited ${creditAmount} to ${phone} ` +
        `— reg_fee=${newRegFee}, personal=${newPersonal}, ` +
        `openBalance=${newOpenBalance}, pendingBalance=${newPendingBalance}`,
    );
    return { success: true, account: doc };
  } catch (err) {
    console.error("[trans] Error crediting PersonalAccount:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Legacy: transferRegistrarFeeToPersonal (used by direct POST /register)
// ---------------------------------------------------------------------------
/**
 * Records a registration-fee bookkeeping transfer FROM the "Registrar"
 * holding account TO a newly activated personal account.
 *
 * Used when a member registers directly via POST /register (passkey,
 * Pesapal inline, or M-Pesa) — bypassing the PendingAccount stage entirely.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.county
 * @param {string} params.constituency
 * @param {string} params.ward
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]  "mpesa" | "pesapal" | "passkey" etc
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object}>}
 */
async function transferRegistrarFeeToPersonal({
  phone,
  county,
  constituency,
  ward,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const transferAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!transferAmount || transferAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }
  if (!county || !constituency || !ward) {
    return { success: false, reason: "MISSING_REGION" };
  }

  const now = new Date();
  const existing = await PersonalAccount.findOne({ phone }).lean();

  const prevOpenBalance = existing?.account?.personal?.openBalance || 0;
  const prevPendingBalance = existing?.account?.personal?.pendingBalance || 0;
  const prevRegFee = existing?.account?.personal?.reg_fee || 0;
  const prevPersonal = existing?.account?.personal?.personal || 0;

  const newOpenBalance = prevOpenBalance + transferAmount;
  const newPendingBalance = prevPendingBalance + transferAmount;
  const newRegFee = prevRegFee + transferAmount;
  const newPersonal = prevPersonal + transferAmount;

  const update = {
    $setOnInsert: {
      phone,
      county,
      constituency,
      ward,
      createdAt: now,
      "account.business": { name: "", "total-bal": 0, float: 0, benefit: 0 },
    },
    $set: {
      updatedAt: now,
      "account.personal.reg_fee": newRegFee,
      "account.personal.personal": newPersonal,
      "account.personal.openBalance": newOpenBalance,
      "account.personal.pendingBalance": newPendingBalance,
    },
    $push: {
      transactions: {
        reference: reference || "REGISTRAR-TRANSFER",
        time: now,
        openingBalance: prevOpenBalance,
        amount: transferAmount,
        type: "received",
        from: {
          name: "Registrar",
          number: "REGISTRAR-HOLDING",
        },
        to: {
          name: "Personal Account",
          number: phone,
        },
        closingBalance: newOpenBalance,
        environment: paymentMethod,
        notes: notes || "Registrar → Personal (registration fee)",
        status: "pending",
      },
    },
  };

  try {
    const doc = await PersonalAccount.findOneAndUpdate({ phone }, update, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    console.log(
      `[trans] Registrar transfer ${transferAmount} → ${phone} ` +
        `— reg_fee=${newRegFee}, personal=${newPersonal}, ` +
        `openBalance=${newOpenBalance}, pendingBalance=${newPendingBalance}`,
    );
    return { success: true, account: doc };
  } catch (err) {
    console.error(
      "[trans] Error in transferRegistrarFeeToPersonal:",
      err.message,
    );
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

module.exports = {
  verifyPhoneInCounty,
  creditPendingHolding,
  settlePendingToPersonal,
  creditPendingToPersonalAccount,
  transferRegistrarFeeToPersonal,
};