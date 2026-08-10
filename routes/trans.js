/**
 * trans.js
 *
 * Handles the post-"Complete Registration" money movement into the
 * PersonalAccount collection.
 *
 * PersonalAccount is stored in the SAME regional nesting pattern as
 * PendingAccount / County:
 *   county doc → constituencies[].wards[].data[]  (one leaf per user/phone)
 *
 * The county / constituency / ward strings exist ONLY on the document
 * hierarchy — they are NOT duplicated inside the leaf record (except when
 * we return a flat projection where we re-attach them manually).
 *
 * Flow:
 *   STEP A — Pesapal callback runs creditPendingHolding(phone, amount, ...)
 *        → Creates/updates the nested PersonalAccount
 *        → Adds amount to account.pending.value (holding bucket)
 *        → Logs a "pending" transaction: Registrar → Pending Holding
 *
 *   STEP B — Complete Registration runs settlePendingToPersonal(phone, amount, ...)
 *        → Deducts amount from account.pending.value
 *        → Adds amount to account.personal.{personal, reg_fee, openBalance, pendingBalance}
 *        → Logs a settlement transaction
 *        → On failure, falls back to transferRegistrarFeeToPersonal which skips
 *          the holding bucket entirely and writes directly to personal counters.
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

const {
  County,
  PersonalAccount,
  normalizePhone,
  findPersonalAccountByPhone,
  savePersonalAccountToMongo,
  mutatePersonalLeaves,
  findPersonalRecord,
} = require("../mongoose");

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
 * STEP A — Called from Pesapal callback immediately after a successful
 * payment. Creates or updates the PersonalAccount for this phone number and
 * parks the registration fee in account.pending.value so it appears in the
 * ledger immediately. The money stays there until the member completes
 * registration (settlePendingToPersonal moves it to account.personal).
 *
 * NOTE: This can be called BEFORE the user exists in the County collection,
 * so it does NOT call verifyPhoneInCounty. The caller must supply county,
 * constituency, ward explicitly.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.county
 * @param {string} params.constituency
 * @param {string} params.ward
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]
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
  if (!holdAmount || holdAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }
  if (!county || !constituency || !ward) {
    return { success: false, reason: "MISSING_REGION" };
  }

  const now = new Date();
  let savedDoc = null;

  try {
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === normalizePhone(phone),
      (rec) => {
        const prevPendingValue =
          (rec && rec.account && rec.account.pending &&
            typeof rec.account.pending.value === "number")
            ? rec.account.pending.value
            : 0;
        const newPendingValue = prevPendingValue + holdAmount;

        if (!rec.account) rec.account = {};
        if (!rec.account.pending) rec.account.pending = {};
        if (!rec.account.business) {
          rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
        }
        if (!rec.account.personal) {
          rec.account.personal = {
            reg_fee: 0, personal: 0, openBalance: 0, pendingBalance: 0,
          };
        }
        rec.account.pending.value = newPendingValue;

        const prevOpenBalance = rec.account.personal.openBalance || 0;
        const newTxn = {
          reference: reference || "PENDING-HOLDING",
          time: now,
          openingBalance: prevOpenBalance,
          amount: holdAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Pending Holding", number: phone },
          closingBalance: prevOpenBalance,
          environment: paymentMethod,
          notes: notes || "Registration fee received — held pending account completion",
          status: "pending",
        };

        if (!rec.transactions) rec.transactions = [];
        rec.transactions.push(newTxn);
        rec.updatedAt = now;

        savedDoc = rec;
        return rec;
      },
    );

    if (!savedDoc) {
      const leaf = {
        phone,
        account: {
          business: { name: "", "total-bal": 0, float: 0, benefit: 0 },
          pending: { value: holdAmount },
          personal: { reg_fee: 0, personal: 0, openBalance: 0, pendingBalance: 0 },
        },
        transactions: [{
          reference: reference || "PENDING-HOLDING",
          time: now,
          openingBalance: 0,
          amount: holdAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Pending Holding", number: phone },
          closingBalance: 0,
          environment: paymentMethod,
          notes: notes || "Registration fee received — held pending account completion",
          status: "pending",
        }],
        createdAt: now,
        updatedAt: now,
      };
      savedDoc = await savePersonalAccountToMongo({
        county, constituency, ward, ...leaf,
      });
    }

    const newPendingValue =
      (savedDoc && savedDoc.account && savedDoc.account.pending)
        ? savedDoc.account.pending.value
        : holdAmount;

    console.log(
      `[trans] creditPendingHolding: parked ${holdAmount} in account.pending.value for ${phone} ` +
        `(new pending.value=${newPendingValue})`,
    );
    return { success: true, account: savedDoc };
  } catch (err) {
    console.error("[trans] Error in creditPendingHolding:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

/**
 * STEP B — Called when Complete Registration is clicked (from any of the
 * three completion paths). Moves `amount` FROM account.pending.value TO
 * account.personal. All four personal counters (reg_fee, personal,
 * openBalance, pendingBalance) are incremented by `amount`. Records a
 * settlement transaction.
 *
 * Precondition: the phone number MUST already exist in the County register
 * (member was saved). If verifyPhoneInCounty fails this returns NOT_REGISTERED
 * so the caller can fall back to transferRegistrarFeeToPersonal.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} [params.county]
 * @param {string} [params.constituency]
 * @param {string} [params.ward]
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object}>}
 */
async function settlePendingToPersonal({
  phone,
  county,
  constituency,
  ward,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const settleAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!settleAmount || settleAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }

  const membership = await verifyPhoneInCounty(phone);
  if (!membership.found) {
    console.warn(
      `[trans] settlePendingToPersonal: phone not in County yet — ${phone}`,
    );
    return { success: false, reason: "NOT_REGISTERED" };
  }
  const c = county || membership.county;
  const cn = constituency || membership.constituency;
  const w = ward || membership.ward;

  const existing = await findPersonalAccountByPhone(phone);
  if (!existing) {
    console.warn(`[trans] settlePendingToPersonal: no PersonalAccount found for ${phone}`);
    return { success: false, reason: "ACCOUNT_NOT_FOUND" };
  }

  const now = new Date();
  let savedDoc = null;

  try {
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === normalizePhone(phone),
      (rec) => {
        const prevPendingValue =
          (rec.account && rec.account.pending &&
            typeof rec.account.pending.value === "number")
            ? rec.account.pending.value
            : 0;
        const prevOpenBalance = rec.account?.personal?.openBalance || 0;
        const prevPendingBalance = rec.account?.personal?.pendingBalance || 0;
        const prevRegFee = rec.account?.personal?.reg_fee || 0;
        const prevPersonal = rec.account?.personal?.personal || 0;

        const newPendingValue = Math.max(0, prevPendingValue - settleAmount);
        const newOpenBalance = prevOpenBalance + settleAmount;
        const newPendingBalance = prevPendingBalance + settleAmount;
        const newRegFee = prevRegFee + settleAmount;
        const newPersonal = prevPersonal + settleAmount;

        if (!rec.account) rec.account = {};
        if (!rec.account.pending) rec.account.pending = {};
        if (!rec.account.business) {
          rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
        }
        if (!rec.account.personal) rec.account.personal = {};

        rec.account.pending.value = newPendingValue;
        rec.account.personal.reg_fee = newRegFee;
        rec.account.personal.personal = newPersonal;
        rec.account.personal.openBalance = newOpenBalance;
        rec.account.personal.pendingBalance = newPendingBalance;

        if (!rec.transactions) rec.transactions = [];
        rec.transactions.push({
          reference: reference || "SETTLE-PENDING",
          time: now,
          openingBalance: prevOpenBalance,
          amount: settleAmount,
          type: "received",
          from: { name: "Pending Holding", number: phone },
          to: { name: "Personal Account", number: phone },
          closingBalance: newOpenBalance,
          environment: paymentMethod,
          notes: notes || "Pending holding → Personal account (registration completed)",
          status: "completed",
        });
        rec.updatedAt = now;

        savedDoc = rec;
        return rec;
      },
    );

    if (savedDoc) {
      const flat = await findPersonalAccountByPhone(phone);
      const pendingValue =
        (flat && flat.account && flat.account.pending) ? flat.account.pending.value : 0;
      const openBal = flat?.account?.personal?.openBalance || 0;
      const pendBal = flat?.account?.personal?.pendingBalance || 0;
      console.log(
        `[trans] settlePendingToPersonal: moved ${settleAmount} from pending.value to personal for ${phone} ` +
          `— pending.value=${pendingValue}, personal.openBalance=${openBal}, ` +
          `personal.pendingBalance=${pendBal}`,
      );
      return { success: true, account: flat };
    }
    return { success: false, reason: "ACCOUNT_NOT_FOUND" };
  } catch (err) {
    console.error("[trans] Error in settlePendingToPersonal:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

/**
 * Legacy / direct path. Credits amount into account.personal.openBalance and
 * a pending transaction + pendingBalance. Used where the holding-bucket
 * pattern is bypassed entirely.
 *
 * Looks up the phone in the County collection first — if the number isn't
 * a registered member there, the credit is refused (NOT_REGISTERED).
 */
async function creditPendingToPersonalAccount({
  phone,
  amount,
  reference = "",
  paymentMethod = "unknown",
  notes = "",
}) {
  const creditAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!creditAmount || creditAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }

  const membership = await verifyPhoneInCounty(phone);
  if (!membership.found) {
    console.warn(`[trans] Refusing credit — phone not found in County collection: ${phone}`);
    return { success: false, reason: "NOT_REGISTERED" };
  }

  const now = new Date();
  let savedDoc = null;

  try {
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === normalizePhone(phone),
      (rec) => {
        const prevOpenBalance = rec.account?.personal?.openBalance || 0;
        const prevPendingBalance = rec.account?.personal?.pendingBalance || 0;
        const prevRegFee = rec.account?.personal?.reg_fee || 0;
        const prevPersonal = rec.account?.personal?.personal || 0;

        const newOpenBalance = prevOpenBalance + creditAmount;
        const newPendingBalance = prevPendingBalance + creditAmount;
        const newRegFee = prevRegFee + creditAmount;
        const newPersonal = prevPersonal + creditAmount;

        if (!rec.account) rec.account = {};
        if (!rec.account.business) {
          rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
        }
        if (!rec.account.personal) rec.account.personal = {};
        if (!rec.account.pending) rec.account.pending = { value: 0 };

        rec.account.personal.reg_fee = newRegFee;
        rec.account.personal.personal = newPersonal;
        rec.account.personal.openBalance = newOpenBalance;
        rec.account.personal.pendingBalance = newPendingBalance;

        if (!rec.transactions) rec.transactions = [];
        rec.transactions.push({
          reference,
          time: now,
          openingBalance: prevOpenBalance,
          amount: creditAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Personal Account", number: phone },
          closingBalance: newOpenBalance,
          environment: paymentMethod,
          notes: notes || "Registrar → Personal (registration credit)",
          status: "pending",
        });
        rec.updatedAt = now;

        savedDoc = rec;
        return rec;
      },
    );

    if (!savedDoc) {
      const leaf = {
        phone,
        account: {
          business: { name: "", "total-bal": 0, float: 0, benefit: 0 },
          pending: { value: 0 },
          personal: {
            reg_fee: creditAmount,
            personal: creditAmount,
            openBalance: creditAmount,
            pendingBalance: creditAmount,
          },
        },
        transactions: [{
          reference,
          time: now,
          openingBalance: 0,
          amount: creditAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Personal Account", number: phone },
          closingBalance: creditAmount,
          environment: paymentMethod,
          notes: notes || "Registrar → Personal (registration credit)",
          status: "pending",
        }],
        createdAt: now,
        updatedAt: now,
      };
      savedDoc = await savePersonalAccountToMongo({
        county: membership.county,
        constituency: membership.constituency,
        ward: membership.ward,
        ...leaf,
      });
    } else {
      savedDoc = await findPersonalAccountByPhone(phone);
    }

    const newRegFee = savedDoc?.account?.personal?.reg_fee || creditAmount;
    const newPersonal = savedDoc?.account?.personal?.personal || creditAmount;
    const newOpenBalance = savedDoc?.account?.personal?.openBalance || creditAmount;
    const newPendingBalance = savedDoc?.account?.personal?.pendingBalance || creditAmount;
    console.log(
      `[trans] Credited ${creditAmount} to ${phone} ` +
        `— reg_fee=${newRegFee}, personal=${newPersonal}, ` +
        `openBalance=${newOpenBalance}, pendingBalance=${newPendingBalance}`,
    );
    return { success: true, account: savedDoc };
  } catch (err) {
    console.error("[trans] Error crediting PersonalAccount:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

/**
 * Records a registration-fee bookkeeping transfer FROM the "Registrar"
 * holding account TO a newly activated personal account.
 *
 * This is the FALLBACK for when settlePendingToPersonal fails, or the
 * holding-bucket Phase 1 was never run at all. It does NOT debit
 * account.pending.value. Instead it directly bumps all four personal
 * counters and records a transaction with an explicit `from: Registrar`
 * counterparty so the audit trail is clear this bypassed the holding bucket.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.county
 * @param {string} params.constituency
 * @param {string} params.ward
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod]
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
  let savedDoc = null;

  try {
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === normalizePhone(phone),
      (rec) => {
        const prevOpenBalance = rec.account?.personal?.openBalance || 0;
        const prevPendingBalance = rec.account?.personal?.pendingBalance || 0;
        const prevRegFee = rec.account?.personal?.reg_fee || 0;
        const prevPersonal = rec.account?.personal?.personal || 0;

        const newOpenBalance = prevOpenBalance + transferAmount;
        const newPendingBalance = prevPendingBalance + transferAmount;
        const newRegFee = prevRegFee + transferAmount;
        const newPersonal = prevPersonal + transferAmount;

        if (!rec.account) rec.account = {};
        if (!rec.account.business) {
          rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
        }
        if (!rec.account.personal) rec.account.personal = {};
        if (!rec.account.pending) rec.account.pending = { value: 0 };

        rec.account.personal.reg_fee = newRegFee;
        rec.account.personal.personal = newPersonal;
        rec.account.personal.openBalance = newOpenBalance;
        rec.account.personal.pendingBalance = newPendingBalance;

        if (!rec.transactions) rec.transactions = [];
        rec.transactions.push({
          reference: reference || "REGISTRAR-TRANSFER",
          time: now,
          openingBalance: prevOpenBalance,
          amount: transferAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Personal Account", number: phone },
          closingBalance: newOpenBalance,
          environment: paymentMethod,
          notes: notes || "Registrar → Personal (registration fee)",
          status: "pending",
        });
        rec.updatedAt = now;

        savedDoc = rec;
        return rec;
      },
    );

    if (!savedDoc) {
      const leaf = {
        phone,
        account: {
          business: { name: "", "total-bal": 0, float: 0, benefit: 0 },
          pending: { value: 0 },
          personal: {
            reg_fee: transferAmount,
            personal: transferAmount,
            openBalance: transferAmount,
            pendingBalance: transferAmount,
          },
        },
        transactions: [{
          reference: reference || "REGISTRAR-TRANSFER",
          time: now,
          openingBalance: 0,
          amount: transferAmount,
          type: "received",
          from: { name: "Registrar", number: "REGISTRAR-HOLDING" },
          to: { name: "Personal Account", number: phone },
          closingBalance: transferAmount,
          environment: paymentMethod,
          notes: notes || "Registrar → Personal (registration fee)",
          status: "pending",
        }],
        createdAt: now,
        updatedAt: now,
      };
      savedDoc = await savePersonalAccountToMongo({
        county, constituency, ward, ...leaf,
      });
    } else {
      savedDoc = await findPersonalAccountByPhone(phone);
    }

    const newRegFee = savedDoc?.account?.personal?.reg_fee || transferAmount;
    const newPersonal = savedDoc?.account?.personal?.personal || transferAmount;
    const newOpenBalance = savedDoc?.account?.personal?.openBalance || transferAmount;
    const newPendingBalance = savedDoc?.account?.personal?.pendingBalance || transferAmount;
    console.log(
      `[trans] Registrar transfer ${transferAmount} → ${phone} ` +
        `— reg_fee=${newRegFee}, personal=${newPersonal}, ` +
        `openBalance=${newOpenBalance}, pendingBalance=${newPendingBalance}`,
    );
    return { success: true, account: savedDoc };
  } catch (err) {
    console.error(
      "[trans] Error in transferRegistrarFeeToPersonal:",
      err.message,
    );
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

/**
 * Wallet Add-Fund / top-up. Credits account.personal (personal + openBalance)
 * and appends a completed "received" ledger transaction. Does NOT touch reg_fee.
 *
 * @param {Object} params
 * @param {string} params.phone - PersonalAccount leaf phone to credit
 * @param {number} params.amount
 * @param {string} [params.reference]
 * @param {string} [params.paymentMethod] - pesapal | mpesa | …
 * @param {string} [params.payerPhone] - phone that paid (STK / Pesapal)
 * @param {string} [params.notes]
 * @returns {Promise<{success: boolean, reason?: string, account?: object, balance?: number}>}
 */
async function creditWalletTopUp({
  phone,
  amount,
  reference = "",
  paymentMethod = "unknown",
  payerPhone = "",
  notes = "",
}) {
  const creditAmount = Number(amount || 0);
  if (!phone) return { success: false, reason: "NO_PHONE" };
  if (!creditAmount || creditAmount <= 0) {
    return { success: false, reason: "INVALID_AMOUNT" };
  }

  const membership = await verifyPhoneInCounty(phone);
  if (!membership.found) {
    console.warn(`[trans] Refusing wallet top-up — phone not in County: ${phone}`);
    return { success: false, reason: "NOT_REGISTERED" };
  }

  const now = new Date();
  let savedDoc = null;
  let newOpenBalance = 0;

  try {
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === normalizePhone(phone),
      (rec) => {
        if (!rec.account) rec.account = {};
        if (!rec.account.business) {
          rec.account.business = { name: "", "total-bal": 0, float: 0, benefit: 0 };
        }
        if (!rec.account.pending) rec.account.pending = { value: 0 };
        if (!rec.account.personal) {
          rec.account.personal = {
            reg_fee: 0, personal: 0, openBalance: 0, pendingBalance: 0,
          };
        }

        const prevOpen = Number(rec.account.personal.openBalance || 0);
        const prevPersonal = Number(rec.account.personal.personal || 0);
        newOpenBalance = prevOpen + creditAmount;
        const newPersonal = prevPersonal + creditAmount;

        rec.account.personal.openBalance = newOpenBalance;
        rec.account.personal.personal = newPersonal;

        if (!rec.transactions) rec.transactions = [];
        rec.transactions.push({
          reference: reference || `TOPUP-${Date.now()}`,
          time: now,
          openingBalance: prevOpen,
          amount: creditAmount,
          type: "received",
          from: {
            name: paymentMethod === "mpesa" ? "M-Pesa" : (paymentMethod === "pesapal" ? "Pesapal" : "Wallet Top-up"),
            number: payerPhone || "PAYER",
          },
          to: { name: "Personal Account", number: phone },
          closingBalance: newOpenBalance,
          environment: paymentMethod,
          notes: notes || "Wallet Add Fund",
          status: "completed",
        });
        rec.updatedAt = now;
        savedDoc = rec;
        return rec;
      },
    );

    if (!savedDoc) {
      const leaf = {
        phone,
        account: {
          business: { name: "", "total-bal": 0, float: 0, benefit: 0 },
          pending: { value: 0 },
          personal: {
            reg_fee: 0,
            personal: creditAmount,
            openBalance: creditAmount,
            pendingBalance: 0,
          },
        },
        transactions: [{
          reference: reference || `TOPUP-${Date.now()}`,
          time: now,
          openingBalance: 0,
          amount: creditAmount,
          type: "received",
          from: {
            name: paymentMethod === "mpesa" ? "M-Pesa" : (paymentMethod === "pesapal" ? "Pesapal" : "Wallet Top-up"),
            number: payerPhone || "PAYER",
          },
          to: { name: "Personal Account", number: phone },
          closingBalance: creditAmount,
          environment: paymentMethod,
          notes: notes || "Wallet Add Fund",
          status: "completed",
        }],
        createdAt: now,
        updatedAt: now,
      };
      savedDoc = await savePersonalAccountToMongo({
        county: membership.county,
        constituency: membership.constituency,
        ward: membership.ward,
        ...leaf,
      });
      newOpenBalance = creditAmount;
    } else {
      savedDoc = await findPersonalAccountByPhone(phone);
      newOpenBalance = savedDoc?.account?.personal?.openBalance || newOpenBalance;
    }

    console.log(
      `[trans] Wallet top-up ${creditAmount} → ${phone} via ${paymentMethod} ` +
        `openBalance=${newOpenBalance}`,
    );
    return { success: true, account: savedDoc, balance: newOpenBalance };
  } catch (err) {
    console.error("[trans] Error in creditWalletTopUp:", err.message);
    return { success: false, reason: "DB_ERROR", error: err.message };
  }
}

module.exports = {
  verifyPhoneInCounty,
  creditPendingHolding,
  settlePendingToPersonal,
  creditPendingToPersonalAccount,
  transferRegistrarFeeToPersonal,
  creditWalletTopUp,
};
