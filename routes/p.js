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
  saveMessageToMongo,
} = require("../mongoose");

// Locate the group member document in `groups-members` so we can write the
// updated financials back. Returns the doc _id, the dotted member path, the
// member key and the live member record.
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
            groupData: g,
            memberKey: key,
            memberPath: `${hint.groupPath}.members.${key}`,
            groupPath: hint.groupPath,
            memberRecord: mem,
          };
        }
      }
    }
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
                  groupData: g,
                  memberKey: key,
                  memberPath: `constituencies.${i}.wards.${j}.data.${k}.members.${key}`,
                  groupPath: `constituencies.${i}.wards.${j}.data.${k}`,
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
          return {
            doc,
            groupData: doc,
            memberKey: key,
            memberPath: `members.${key}`,
            groupPath: "",
            memberRecord: mem
          };
        }
      }
    }
  }
  return null;
};

// Helper: verify a single member & account list against verified group docs
const verifySingleMemberTbank = ({ inGroups, inMembers, groupName, phone, accounts }) => {
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
    return { ok: false, stage: "member", message: `Member with phone ${phone || "(none)"} was not found within ${groupName}.` };
  }

  const lines = (accounts || [])
    .map((a) => ({
      accountId: String(a.accountNumber || a.accountId || "001"),
      accountName: a.accountName || "",
      amount: Number(a.amount != null ? a.amount : a.inputAmount) || 0,
    }))
    .filter((l) => l.amount > 0);

  if (!lines.length) {
    return { ok: false, stage: "accounts", message: "No valid accounts to process for member." };
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

  if (failedAccounts.length) {
    return {
      ok: false,
      stage: "account",
      message: `Some accounts could not be verified for member ${phone}.`,
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
    locationHint: { docId: inMembers.docId, groupPath: inMembers.groupPath },
  };
};

// Verify group (both collections) + member + every account, in order,
// BEFORE any money moves. Returns a structured result (no writes).
const verifyTbank = async ({ groupName, phone, accounts, members }) => {
  // 1. group name in `groups` collection first
  const inGroups = await findGroupNameInMongoGroupsCollection(groupName);
  if (!inGroups) {
    return { ok: false, stage: "groups", message: `Group "${groupName}" was not found in the groups collection.` };
  }

  // 2. group name in `groups-members` collection
  const inMembers = await findGroupNameInGroupsMembersCollection(groupName);
  if (!inMembers) {
    return { ok: false, stage: "groups-members", message: `Group "${groupName}" was not found in the groups-members collection.` };
  }

  // Support batch / queue of members (Multi-member flow)
  if (Array.isArray(members) && members.length > 0) {
    const verifiedMembers = [];
    const unverifiedMembers = [];

    for (const m of members) {
      const mPhone = m.phone || m.memberPhone || m.phoneNumber || "";
      const mAccounts = m.accounts || [];
      const mRes = verifySingleMemberTbank({ inGroups, inMembers, groupName, phone: mPhone, accounts: mAccounts });
      if (mRes.ok) {
        verifiedMembers.push({
          ...mRes,
          name: m.name || mRes.memberRecord?.name || `Member ${mRes.memberKey}`,
          memberNumber: m.memberNumber || m.index || mRes.memberKey,
        });
      } else {
        unverifiedMembers.push({
          phone: mPhone,
          name: m.name || "",
          memberNumber: m.memberNumber || m.index || "",
          reason: mRes.message || "Verification failed",
          failedAccounts: mRes.failedAccounts || [],
        });
      }
    }

    return {
      ok: verifiedMembers.length > 0,
      isBatch: true,
      groupName,
      verifiedMembers,
      unverifiedMembers,
      locationHint: { docId: inMembers.docId, groupPath: inMembers.groupPath },
    };
  }

  // Single member verification
  return verifySingleMemberTbank({ inGroups, inMembers, groupName, phone, accounts });
};

router.get("/", (req, res) => {
  res.json({ message: "ok" });
});

// Verification step only (no deduction). Used to gate the "Proceed" button.
router.post("/verify", async (req, res) => {
  const { groupName, phone, memberPhone, accounts, members } = req.body || {};
  if (!groupName) {
    return res.json({ success: false, stage: "group", message: "Group name is required." });
  }
  try {
    await ensureMongoReady();
    const effectivePhone = memberPhone || phone;
    const result = await verifyTbank({ groupName, phone: effectivePhone, accounts, members });
    if (!result.ok) {
      return res.json({
        success: false,
        stage: result.stage || "verification",
        message: result.message || "Verification failed.",
        failedAccounts: result.failedAccounts,
        unverifiedMembers: result.unverifiedMembers,
      });
    }

    if (result.isBatch) {
      return res.json({
        success: true,
        stage: "verified",
        groupName,
        isBatch: true,
        verifiedMembers: result.verifiedMembers,
        unverifiedMembers: result.unverifiedMembers,
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
  const { groupName, phone, payerPhone, memberPhone, accounts, members } = req.body || {};
  if (!groupName) {
    return res.json({ success: false, message: "Group name is required." });
  }

  const sessionPhone = req.session?.user?.phoneNumber || "";
  const effectivePayerPhone = normalizePhone(sessionPhone || payerPhone || phone);
  const effectiveMemberPhone = normalizePhone(memberPhone || phone);

  if (!effectivePayerPhone) {
    return res.json({ success: false, message: "Payer phone is required." });
  }

  try {
    await ensureMongoReady();

    // Re-verify (group, member(s), ALL accounts) BEFORE any deduction.
    const result = await verifyTbank({
      groupName,
      phone: effectiveMemberPhone,
      accounts,
      members,
    });

    if (!result.ok) {
      return res.json({
        success: false,
        stage: result.stage,
        message: result.message,
        failedAccounts: result.failedAccounts,
        unverifiedMembers: result.unverifiedMembers,
      });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const txRef = "TBANK-" + Date.now().toString(36).toUpperCase();

    // Build the list of verified targets to process:
    // If batch: ONLY process verified members. Unverified members are EXCLUDED from deduction.
    const verifiedTargets = result.isBatch
      ? result.verifiedMembers
      : [
          {
            mPhone: result.mPhone,
            memberKey: result.memberKey,
            memberRecord: result.memberRecord,
            lines: result.lines,
            locationHint: result.locationHint,
            name: req.body.recipientName || "Member",
            memberNumber: req.body.recipientMemberNumber || result.memberKey,
          },
        ];

    // Compute grand total for all verified members & accounts
    let grandTotal = 0;
    const allDebits = [];
    for (const target of verifiedTargets) {
      for (const line of target.lines) {
        grandTotal += line.amount;
        allDebits.push({
          targetPhone: target.mPhone,
          targetName: target.name,
          accountId: line.accountId,
          accountName: line.resolvedAccountName,
          amount: line.amount,
        });
      }
    }

    if (grandTotal <= 0) {
      return res.json({ success: false, message: "Total payment amount must be greater than zero." });
    }

    let savedDoc = null;
    let finalBalance = 0;

    // --- 1. Deduct total from the Payer's Personal wallet ---
    await mutatePersonalLeaves(
      (r) => normalizePhone(r.phone) === effectivePayerPhone,
      (rec) => {
        const prevOpenBalance = Number(rec.account?.personal?.openBalance || 0);
        if (prevOpenBalance < grandTotal) {
          throw new Error(`Insufficient wallet balance. Available: KSh ${prevOpenBalance}, Required: KSh ${grandTotal}`);
        }
        if (!rec.account) rec.account = {};
        if (!rec.account.personal) rec.account.personal = {};
        if (!rec.transactions) rec.transactions = [];

        let running = prevOpenBalance;
        for (const debit of allDebits) {
          const opening = running;
          const closing = opening - debit.amount;
          running = closing;
          rec.transactions.push({
            reference: allDebits.length > 1 ? `${txRef}_${debit.accountId}` : txRef,
            time: now,
            openingBalance: opening,
            amount: debit.amount,
            type: "sent",
            from: { name: "Personal Account", number: effectivePayerPhone },
            to: { name: `${groupName} (${debit.targetName || debit.targetPhone})`, number: debit.accountId },
            closingBalance: closing,
            environment: "tbank",
            notes: `tBank payment to ${groupName} (${debit.accountName}) for ${debit.targetName || debit.targetPhone}`,
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
        message: `Personal account for phone ${effectivePayerPhone} was not found.`,
      });
    }

    // --- 2. Credit each verified group member's financials (mirroring My Account update) ---
    let ledgerUpdated = false;
    let ledgerError = null;
    let lastUpdatedMember = null;
    const db = mongoose.connection.db;
    const membersCol = db.collection("groups-members");
    const groupsCol = db.collection("groups");

    try {
      for (const target of verifiedTargets) {
        const loc = await locateGroupMemberDoc(groupName, target.mPhone, target.locationHint || result.locationHint);
        if (!loc) {
          console.warn(`[p] Could not locate member "${target.mPhone}" in "${groupName}".`);
          continue;
        }

        const mem = loc.memberRecord || {};
        const targetTotal = target.lines.reduce((s, l) => s + l.amount, 0);

        // Member financials update
        const fin = mem.memberFinancials || { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 };
        const prevClosing = Number(fin.closingBalance || fin.openingBalance || 0);
        mem.memberFinancials = {
          openingBalance: prevClosing,
          amountIn: (Number(fin.amountIn) || 0) + targetTotal,
          amountOut: Number(fin.amountOut) || 0,
          closingBalance: prevClosing + targetTotal,
        };

        if (!mem.accounts) mem.accounts = {};
        for (const line of target.lines) {
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
          acc.accountVerified = line.resolvedAccountName;
          acc.accountName = line.resolvedAccountName;

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
          const txCode = target.lines.length > 1 ? `${txRef}_${accId}` : txRef;
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
            payerPhone: effectivePayerPhone,
            memberPhone: target.mPhone,
          });

          if (cycle && Array.isArray(cycle.rounds) && cycle.rounds.length > 0 && activeIndex >= 0) {
            if (!Array.isArray(activeRound.accountroundPerformance)) activeRound.accountroundPerformance = [];
            if (!activeRound.accountroundPerformance.find((e) => e && e.memberId === target.mPhone)) {
              activeRound.accountroundPerformance.push({
                memberId: target.mPhone,
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
            acc.dateIntervalCycle = cycle;
          }
          mem.accounts[accId] = acc;
        }

        if (!mem.transactionHistory) mem.transactionHistory = [];
        mem.transactionHistory.push({
          reference: txRef,
          transactionCode: txRef,
          amount: targetTotal,
          amountIn: targetTotal,
          amountOut: 0,
          openingBalance: prevClosing,
          closingBalance: prevClosing + targetTotal,
          type: "contribution",
          date: now,
          status: "completed",
          payerPhone: effectivePayerPhone,
          memberPhone: target.mPhone,
        });

        const writeResult = await membersCol.updateOne(
          { _id: loc.doc._id },
          { $set: { [loc.memberPath]: mem } }
        );
        if (writeResult.matchedCount > 0) {
          lastUpdatedMember = mem;
          ledgerUpdated = true;

          // Sync total groupFinancials in groups-members & groups collections
          try {
            const gPath = loc.groupPath;
            if (gPath) {
              const gfPrefix = `${gPath}.groupFinancials`;
              await membersCol.updateOne(
                { _id: loc.doc._id },
                {
                  $inc: {
                    [`${gfPrefix}.totalAmountIn`]: targetTotal,
                    [`${gfPrefix}.totalClosingBalance`]: targetTotal,
                  },
                }
              );
            }
            await groupsCol.updateMany(
              {
                $or: [
                  { groupName: groupName },
                  { groupId: groupName },
                  { accountNumber: groupName },
                ],
              },
              {
                $inc: {
                  "groupFinancials.totalAmountIn": targetTotal,
                  "groupFinancials.totalClosingBalance": targetTotal,
                },
                $set: { updatedAt: nowIso },
              }
            );
          } catch (syncErr) {
            console.warn("[p] groupFinancials sync notice:", syncErr.message);
          }

          // Send confirmation notification to recipient member
          try {
            await saveMessageToMongo({
              to: target.mPhone,
              groupName,
              type: "group_contribution_success",
              title: "Contribution Received via tBank",
              content: `Received KSh ${targetTotal.toLocaleString()} for ${groupName} (${target.lines.map((l) => l.resolvedAccountName).join(", ")}). Ref: ${txRef}.`,
              createdAt: nowIso,
              isNew: true,
              meta: {
                reference: txRef,
                amount: targetTotal,
                groupName,
                payerPhone: effectivePayerPhone,
                accounts: target.lines,
              },
            });
          } catch (msgErr) {
            console.warn("[p] Notification save notice:", msgErr.message);
          }
        }
      }
    } catch (memberErr) {
      console.error("[p] member financials update error:", memberErr.message);
      ledgerError = memberErr.message || "Ledger write failed.";
    }

    if (req.session) {
      req.session.walletBalance = finalBalance;
      if (req.session.user) {
        req.session.user.walletBalance = finalBalance;
      }
      try {
        req.session.save();
      } catch (se) {}
    }

    res.json({
      success: true,
      message: ledgerUpdated
        ? "Group payment received & ledger updated."
        : "Payment was deducted from your wallet, but we couldn't confirm it reached the group account. Support has been notified — please save your reference.",
      reference: txRef,
      newBalance: finalBalance,
      walletBalance: finalBalance,
      groupName,
      payerPhone: effectivePayerPhone,
      member: lastUpdatedMember,
      ledgerUpdated,
      ledgerError: ledgerUpdated ? undefined : ledgerError,
      unverifiedMembers: result.unverifiedMembers || [],
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