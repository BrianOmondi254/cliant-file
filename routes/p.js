const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  ensureMongoReady,
  findGroupNameInMongoGroupsCollection,
  findGroupNameInGroupsMembersCollection,
  mutatePersonalLeaves,
  normalizePhone,
  normalizeGroupName,
  computeLiveRoundStatuses,
} = require("../mongoose");

// Locate the group member document in `groups-members` so we can write the
// updated financials back. Returns the doc _id, the dotted member path, the
// member key and the live member record.
//
// `hint` (optional) is the {docId, groupPath} pair already resolved by
// findGroupNameInGroupsMembersCollection during /verify. When present we look
// there FIRST so the write lands on the exact same group doc that verification
// matched, instead of independently re-scanning the whole collection (which
// could resolve a different/duplicate doc and silently miss the real one).
const locateGroupMemberDoc = async (groupName, mPhone, hint) => {
  const db = mongoose.connection.db;
  if (!db) return null;
  const membersCol = db.collection("groups-members");

  if (hint && hint.docId && hint.groupPath) {
    const doc = await membersCol.findOne({ _id: hint.docId });
    if (doc) {
      const g = hint.groupPath.split(".").reduce((o, key) => (o == null ? o : o[key]), doc);
      const members = (g && g.members) || {};
      for (const [key, mem] of Object.entries(members)) {
        const idNorm = normalizePhone(mem && mem.memberId);
        const keyNorm = normalizePhone(key);
        const phoneNorm = normalizePhone(mem && (mem.phone || mem.phoneNumber));
        if (idNorm === mPhone || keyNorm === mPhone || phoneNorm === mPhone) {
          return {
            doc,
            memberKey: key,
            memberPath: `${hint.groupPath}.members.${key}`,
            memberRecord: mem,
          };
        }
      }
    }
    // Hint didn't pan out (doc/group/member moved or was removed between
    // verify and pay) — fall through to the full scan below as a backstop.
  }

  const target = normalizeGroupName(groupName);
  const docs = await membersCol.find({}).toArray();
  for (const doc of docs) {
    if (!doc) continue;
    // Structured hierarchy: constituencies[].wards[].data[].members
    if (Array.isArray(doc.constituencies)) {
      for (let i = 0; i < doc.constituencies.length; i++) {
        const cons = doc.constituencies[i];
        if (!cons || !Array.isArray(cons.wards)) continue;
        for (let j = 0; j < cons.wards.length; j++) {
          const ward = cons.wards[j];
          if (!ward || !Array.isArray(ward.data)) continue;
          for (let k = 0; k < ward.data.length; k++) {
            const g = ward.data[k];
            const gName = normalizeGroupName(g && g.groupName);
            const gId = normalizeGroupName(g && g.groupId);
            const gAcc = normalizeGroupName(g && g.accountNumber);
            if (!(g && (gName === target || gId === target || gAcc === target))) continue;
            const members = (g && g.members) || {};
            for (const [key, mem] of Object.entries(members)) {
              const idNorm = normalizePhone(mem && mem.memberId);
              const keyNorm = normalizePhone(key);
              const phoneNorm = normalizePhone(mem && (mem.phone || mem.phoneNumber));
              if (idNorm === mPhone || keyNorm === mPhone || phoneNorm === mPhone) {
                return {
                  doc,
                  memberKey: key,
                  memberPath: `constituencies.${i}.wards.${j}.data.${k}.members.${key}`,
                  memberRecord: mem,
                };
              }
            }
          }
        }
      }
    }
    // Flat members map at root
    if (doc.members && typeof doc.members === "object") {
      for (const [key, mem] of Object.entries(doc.members)) {
        const idNorm = normalizePhone(mem && mem.memberId);
        const keyNorm = normalizePhone(key);
        const phoneNorm = normalizePhone(mem && (mem.phone || mem.phoneNumber));
        if (idNorm === mPhone || keyNorm === mPhone || phoneNorm === mPhone) {
          return { doc, memberKey: key, memberPath: `members.${key}`, memberRecord: mem };
        }
      }
    }
  }
  return null;
};

// Verify group (both collections) + member + every account, in order,
// BEFORE any money moves. Returns a structured result (no writes).
const verifyTbank = async ({ groupName, phone, accounts }) => {
  // 1. group name in `groups` collection
  const inGroups = await findGroupNameInMongoGroupsCollection(groupName);
  if (!inGroups) {
    return { ok: false, stage: "groups", message: `Group "${groupName}" was not found in the groups collection.` };
  }

  // 2. group name in `groups-members` collection
  const inMembers = await findGroupNameInGroupsMembersCollection(groupName);
  if (!inMembers) {
    return { ok: false, stage: "groups-members", message: `Group "${groupName}" was not found in the groups-members collection.` };
  }

  // 3. member within `groups-members` matched by phone vs memberId / key / phone
  const members = (inMembers.group && inMembers.group.members) || {};
  const mPhone = normalizePhone(phone);
  let memberKey = null;
  let memberRecord = null;
  for (const [key, mem] of Object.entries(members)) {
    const idNorm = normalizePhone(mem && mem.memberId);
    const keyNorm = normalizePhone(key);
    const phoneNorm = normalizePhone(mem && (mem.phone || mem.phoneNumber));
    if (idNorm === mPhone || keyNorm === mPhone || phoneNorm === mPhone) {
      memberKey = key;
      memberRecord = mem;
      break;
    }
  }
  if (!memberRecord) {
    return { ok: false, stage: "member", message: `Member with phone ${phone || "(none)"} was not found within the ${groupName} members.` };
  }

  // Build the lines + the account schema map (mirrors STAGE 3 in applyAtomicGroupMemberContribution)
  const lines = (accounts || [])
    .map((a) => ({
      accountId: String(a.accountNumber || a.accountId || "001"),
      accountName: a.accountName || "",
      amount: Number(a.amount) || 0,
    }))
    .filter((l) => l.amount > 0);

  if (!lines.length) {
    return { ok: false, stage: "accounts", message: "No valid accounts to process." };
  }

  const accountSchemaMap = {
    ...(memberRecord.accounts || {}),
    ...(inMembers.groupData?.accountSchema || {}),
    ...(inGroups.groupData?.accountSchema || {}),
    ...(inMembers.group?.accountSchema || {}),
    ...(inGroups.group?.accountSchema || {}),
  };
  const normStr = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  const failedAccounts = [];
  const verifiedLines = [];
  for (const line of lines) {
    const rawAccId = String(line.accountId || "001");
    const accIdTrim = rawAccId.replace(/^0+/, "") || "0";
    const accIdPadded = rawAccId.padStart(3, "0");
    const schemaEntry =
      accountSchemaMap[rawAccId] ||
      accountSchemaMap[accIdTrim] ||
      accountSchemaMap[accIdPadded];
    const registeredName = schemaEntry?.accountName || null;

    const clientNameNorm = normStr(line.accountName);
    const regNameNorm = normStr(registeredName);
    const nameMatches =
      !clientNameNorm ||
      !regNameNorm ||
      clientNameNorm === regNameNorm ||
      clientNameNorm.includes(regNameNorm) ||
      regNameNorm.includes(clientNameNorm);

    if (!schemaEntry || !nameMatches) {
      failedAccounts.push({
        accountId: rawAccId,
        accountName: line.accountName,
        reason: !schemaEntry ? "ACCOUNT_NOT_FOUND" : "ACCOUNT_NAME_MISMATCH",
      });
    } else {
      verifiedLines.push({ ...line, resolvedAccountName: registeredName || line.accountName });
    }
  }

  // 4. If ANY account failed verification, do NOT proceed.
  if (failedAccounts.length) {
    return {
      ok: false,
      stage: "account",
      message: "Some accounts could not be verified. Payment aborted — no amount was deducted.",
      failedAccounts,
    };
  }

  return {
    ok: true,
    groupName,
    mPhone,
    memberKey,
    memberRecord,
    lines: verifiedLines,
    // Exact doc/path the group was matched at — reused by the payment route
    // so the ledger write lands on the same group verification just checked.
    locationHint: { docId: inMembers.docId, groupPath: inMembers.groupPath },
  };
};

router.get("/", (req, res) => {
  res.json({ message: "ok" });
});

// Verification step only (no deduction). Used to gate the "Proceed" button.
router.post("/verify", async (req, res) => {
  const { groupName, phone, accounts } = req.body || {};
  if (!groupName) {
    return res.json({ success: false, stage: "group", message: "Group name is required." });
  }
  try {
    await ensureMongoReady();
    const result = await verifyTbank({ groupName, phone, accounts });
    if (!result.ok) {
      return res.json({
        success: false,
        stage: result.stage,
        message: result.message,
        failedAccounts: result.failedAccounts,
      });
    }
    res.json({
      success: true,
      stage: "verified",
      groupName,
      memberKey: result.memberKey,
      accounts: result.lines,
    });
  } catch (e) {
    console.error("[p/verify] error:", e.message);
    res.json({ success: false, stage: "error", message: e.message || "Verification failed." });
  }
});

// Payment step: re-verify everything, deduct from the Personal wallet, record
// the transaction, and update the group member's financials (the destination).
router.post("/", async (req, res) => {
  const { groupName, phone, accounts } = req.body || {};
  if (!groupName) {
    return res.json({ success: false, message: "Group name is required." });
  }
  if (!phone) {
    return res.json({ success: false, message: "Member phone is required." });
  }
  try {
    await ensureMongoReady();

    // Re-verify (group, member, ALL accounts) BEFORE any deduction.
    const result = await verifyTbank({ groupName, phone, accounts });
    if (!result.ok) {
      return res.json({
        success: false,
        stage: result.stage,
        message: result.message,
        failedAccounts: result.failedAccounts,
      });
    }

    const lines = result.lines;
    const mPhone = result.mPhone;
    const now = new Date();
    const txRef = "TBANK-" + Date.now().toString(36).toUpperCase();
    const total = lines.reduce((s, l) => s + l.amount, 0);

    let savedDoc = null;
    let finalBalance = 0;

    // --- 1. Deduct from the Personal wallet + record the transaction ---
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === mPhone,
      (rec) => {
        const prevOpenBalance = Number(rec.account?.personal?.openBalance || 0);
        if (!rec.account) rec.account = {};
        if (!rec.account.personal) rec.account.personal = {};
        if (!rec.transactions) rec.transactions = [];

        let running = prevOpenBalance;
        for (const line of lines) {
          const opening = running;
          const closing = opening - line.amount; // DEDUCT from personal wallet
          running = closing;
          rec.transactions.push({
            reference: lines.length > 1 ? `${txRef}_${line.accountId}` : txRef,
            time: now,
            openingBalance: opening,
            amount: line.amount,
            type: "sent",
            from: { name: "Personal Account", number: mPhone },
            to: { name: groupName, number: line.accountId },
            closingBalance: closing,
            environment: "tbank",
            notes: `tBank contribution to ${groupName} (${line.resolvedAccountName})`,
            status: "completed",
          });
        }
        rec.account.personal.openBalance = running;
        finalBalance = running;
        rec.updatedAt = now;
        savedDoc = rec;
        return rec;
      }
    );

    if (!savedDoc) {
      return res.json({
        success: false,
        stage: "wallet",
        message: `Personal account for phone ${phone} was not found.`,
      });
    }

    // --- 2. Credit the group member's financials (the destination) ---
    // NOTE: the wallet has already been debited above. If this step fails we
    // must NOT report success as if the group was credited — that would show
    // the client a stale/unchanged member object while implying it's current,
    // and silently leave the group ledger short by `total`.
    let updatedMember = result.memberRecord;
    let ledgerUpdated = false;
    let ledgerError = null;
    try {
      const loc = await locateGroupMemberDoc(groupName, mPhone, result.locationHint);
      if (loc) {
        const mem = loc.memberRecord || {};
        const fin = mem.memberFinancials || { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 };
        const prevClosing = Number(fin.closingBalance || fin.openingBalance || 0);
        mem.memberFinancials = {
          openingBalance: prevClosing,
          amountIn: (Number(fin.amountIn) || 0) + total,
          amountOut: Number(fin.amountOut) || 0,
          closingBalance: prevClosing + total,
        };

        if (!mem.accounts) mem.accounts = {};
        for (const line of lines) {
          const accId = String(line.accountId || "001");
          const acc = mem.accounts[accId] || {};
          const af = acc.financials || { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 };
          const accPrevClosing = Number(af.closingBalance || af.openingBalance || 0);
          acc.financials = {
            openingBalance: accPrevClosing,
            amountIn: (Number(af.amountIn) || 0) + line.amount,
            amountOut: Number(af.amountOut) || 0,
            closingBalance: accPrevClosing + line.amount,
          };
          mem.accounts[accId] = acc;

          const cycle = acc.dateIntervalCycle;
          let activeRoundNumber = null;
          let activeIndex = -1;
          let activeRound = null;
          if (cycle && Array.isArray(cycle.rounds) && cycle.rounds.length > 0) {
            const liveRounds = computeLiveRoundStatuses(cycle.rounds, cycle.endDate, now);
            activeIndex = liveRounds.findIndex((r) => r.status === "active");
            cycle.rounds = liveRounds;
            if (activeIndex >= 0) {
              activeRound = cycle.rounds[activeIndex];
              activeRoundNumber = activeRound.roundNumber;
            }
          }

          if (!acc.transactionHistory) acc.transactionHistory = [];
          const txCode = lines.length > 1 ? `${txRef}_${accId}` : txRef;
          acc.transactionHistory.push({
            reference: txCode,
            transactionCode: txCode,
            amount: line.amount,
            amountIn: line.amount,
            amountOut: 0,
            openingBalance: accPrevClosing,
            closingBalance: accPrevClosing + line.amount,
            accountName: line.resolvedAccountName,
            type: "contribution",
            date: now,
            status: "completed",
            roundNumber: activeRoundNumber,
            accountId: accId,
          });

          if (cycle && Array.isArray(cycle.rounds) && cycle.rounds.length > 0) {
            if (activeIndex >= 0) {
              if (!Array.isArray(activeRound.accountroundPerformance)) activeRound.accountroundPerformance = [];
              if (!activeRound.accountroundPerformance.find((e) => e && e.memberId === mPhone)) {
                activeRound.accountroundPerformance.push({
                  memberId: mPhone,
                  openingBalance: accPrevClosing,
                  amountIn: line.amount,
                  amountOut: 0,
                  closingBalance: accPrevClosing + line.amount,
                  transactionCode: txCode,
                  transactionDate: now,
                  roundNumber: activeRoundNumber,
                  accountId: accId,
                });
              }
            } else {
              console.warn(`[p] No active round for account ${accId} (group "${groupName}") — cycle not yet started or already exhausted.`);
            }
            acc.dateIntervalCycle = cycle;
          } else {
            console.warn(`[p] Account ${accId} (group "${groupName}") has no dateIntervalCycle/rounds — skipping round credit.`);
          }
        }

        if (!mem.transactionHistory) mem.transactionHistory = [];
        mem.transactionHistory.push({
          reference: txRef,
          transactionCode: txRef,
          amount: total,
          amountIn: total,
          amountOut: 0,
          openingBalance: prevClosing,
          closingBalance: prevClosing + total,
          type: "contribution",
          date: now,
          status: "completed",
        });

        const membersCol = mongoose.connection.db.collection("groups-members");
        const writeResult = await membersCol.updateOne(
          { _id: loc.doc._id },
          { $set: { [loc.memberPath]: mem } }
        );
        if (writeResult.matchedCount > 0) {
          updatedMember = mem;
          ledgerUpdated = true;
        } else {
          ledgerError = "Group document no longer matched at write time.";
        }
      } else {
        ledgerError = `Could not re-locate member "${phone}" in group "${groupName}" for the ledger write.`;
      }
    } catch (memberErr) {
      console.error("[p] member financials update error:", memberErr.message);
      ledgerError = memberErr.message || "Ledger write failed.";
    }

    if (!ledgerUpdated) {
      // Money already left the personal wallet — log loudly server-side so
      // this can be reconciled/replayed, since we won't silently pretend it
      // succeeded to the client.
      console.error(
        `[p] LEDGER MISMATCH: wallet debited (ref ${txRef}, amount ${total}) but group "${groupName}" ` +
        `member "${mPhone}" was NOT credited. Reason: ${ledgerError}`
      );
    }

    if (req.session) {
      req.session.walletBalance = finalBalance;
      if (req.session.user) {
        req.session.user.walletBalance = finalBalance;
      }
      try { req.session.save(); } catch (se) {}
    }

    res.json({
      success: true,
      message: ledgerUpdated
        ? "Group payment received & ledger updated."
        : "Payment was deducted from your wallet, but we couldn't confirm it reached the group account. Support has been notified — please save your reference.",
      reference: txRef,
      newBalance: finalBalance,
      groupName,
      memberPhone: mPhone,
      member: updatedMember,
      ledgerUpdated,
      ledgerError: ledgerUpdated ? undefined : ledgerError,
    });
  } catch (e) {
    console.error("[p] payment error:", e.message);
    res.json({ success: false, stage: "error", message: e.message || "Payment failed." });
  }
});

router.get("/member-record", async (req, res) => {
  const { groupName, phone } = req.query || {};
  if (!groupName || !phone) {
    return res.json({ success: false, message: "groupName and phone are required." });
  }
  try {
    await ensureMongoReady();
    const mPhone = normalizePhone(phone);
    const loc = await locateGroupMemberDoc(groupName, mPhone, null);
    if (!loc) {
      return res.json({ success: false, message: "Member not found in group." });
    }
    const mem = loc.memberRecord || {};
    let walletBalance = 0;
    try {
      await mutatePersonalLeaves(
        (r) => normalizePhone(r.phone) === mPhone,
        (rec) => {
          walletBalance = Number(rec?.account?.personal?.openBalance || 0);
          return rec;
        }
      );
    } catch (e) {}
    res.json({
      success: true,
      member: mem,
      walletBalance,
      groupName,
      memberPhone: mPhone,
    });
  } catch (e) {
    console.error("[p/member-record] error:", e.message);
    res.json({ success: false, message: e.message || "Failed to fetch member record." });
  }
});

module.exports = router;