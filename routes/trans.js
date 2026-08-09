/**
 * trans.js
 *
 * Handles the post-"Complete Registration" money movement into the
 * PersonalAccount collection.
 *
 * Flow:
 *   1. verifyPhoneInCounty(phone)   -> confirms the phone number exists in
 *      the County collection (i.e. the member registration actually landed
 *      there) before any money is touched.
 *   2. creditPendingToPersonalAccount(...) -> looks up the PersonalAccount
 *      by phone, adds `amount` to account.personal.openBalance, appends a
 *      transaction entry with status "pending", and adds `amount` to
 *      account.personal.pendingBalance.
 *
 * openBalance vs pendingBalance:
 *   - openBalance is incremented immediately so the funds show up on the
 *     account right away.
 *   - pendingBalance tracks the same amount separately until it is
 *     reconciled/cleared elsewhere (e.g. an admin/HQ confirmation step or a
 *     payment-provider webhook that flips the transaction's status to
 *     "completed"). Nothing in this file clears pendingBalance — that is a
 *     separate reconciliation step to be wired up wherever "pending"
 *     transactions get confirmed.
 */

const { County, PersonalAccount, normalizePhone } = require("../mongoose");

/**
 * Confirms a phone number exists somewhere in the County collection's
 * nested county -> constituency -> ward -> data hierarchy.
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

/**
 * Records a registration-fee bookkeeping transfer FROM the "Registrar"
 * holding account TO a newly activated personal account.
 *
 * This mirrors the double-entry bookkeeping performed by
 * creditPendingToPersonalAccount but additionally bumps the
 * `account.personal.reg_fee` and `account.personal.personal` counters
 * (the same counters the POST /register path updates via
 * upsertPersonalAccountMongo in auth.js). The transaction entry is
 * marked as a "received" from the member's point of view, with the
 * counterparty explicitly set to `from: { name: "Registrar", ... }` so
 * any audit trace clearly shows where the opening balance originated.
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
  creditPendingToPersonalAccount,
  transferRegistrarFeeToPersonal,
};