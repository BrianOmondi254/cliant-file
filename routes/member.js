const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  saveMemberGroupToMongo,
  addMemberToMemberGroup,
  updateMemberAccountInMongo,
  getMemberGroupFromMongo,
  saveMemberDataToMongo,
  saveGeneralGroupToMongo,
  findOrCreateMemberGroup,
  findGroupNameInMongoGroupsCollection,
  findGroupNameInGroupsMembersCollection,
  MemberGroup,
  ensureMongoReady,
  deletePendingOfficerMessage,
  Agent,
  Dealer,
  normalizePhone,
  findPersonalAccountByPhone
} = require('../mongoose');

const router = express.Router();
const memberFile = path.join(__dirname, "../tran_account/member.json");
const memberRegionsFile = path.join(__dirname, "../member.json");
const generalFile = path.join(__dirname, "../general.json");
const dataFile = path.join(__dirname, "../data.json");

const readJSON = (file, fallback = null) => {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : fallback;
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
    return fallback;
  }
};

const getRegionTransaction = async () => {
  const defaultDoc = { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0, transactions: [] };
  try {
    const ready = await ensureMongoReady();
    if (ready) {
      const mongoose = require('mongoose');
      const col = mongoose.connection.db.collection('groups-members');
      let doc = await col.findOne({ _id: 'regionTransaction' });
      if (!doc) {
        // Document was deleted — recreate it with zero balances
        await col.updateOne(
          { _id: 'regionTransaction' },
          {
            $setOnInsert: {
              _id: 'regionTransaction',
              county: 'Region',
              countyId: 'region',
              regionTransaction: defaultDoc,
              syncedAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
        doc = await col.findOne({ _id: 'regionTransaction' });
      }
      if (doc && doc.regionTransaction) {
        return doc.regionTransaction;
      }
    }
  } catch (e) {
    console.error('[regionTransaction] MongoDB read error:', e.message);
  }
  return defaultDoc;
};

// Normalize a MongoDB group doc into the member.json shape the views expect.
// Handles both the regional groups-members format (already has a `members` map
// keyed by phone) and the flattened `groups` collection format (trustee_/official_/member_ keys).
const normalizeMongoGroupForMember = (mongoGroup) => {
  const group = { ...mongoGroup };
  const hasMembersMap = group.members && typeof group.members === 'object' && !Array.isArray(group.members);
  if (!hasMembersMap) {
    const members = {};
    for (const key of Object.keys(group)) {
      if (/^(trustee_|official_|member_)/.test(key)) {
        const item = group[key];
        if (item && (item.phone || item.memberId)) {
          const phone = String(item.phone || item.memberId);
          members[phone] = item;
        }
      }
    }
    group.members = members;
  }
  return group;
};

// Resolve a group for the contribution/loan/membership routes from MongoDB only.
// (Legacy member.json fallback removed for security — those groups are deleted.)
const findGroupForMemberRoutes = async (groupName) => {
  try {
    const hit =
      (await findGroupNameInGroupsMembersCollection(groupName)) ||
      (await findGroupNameInMongoGroupsCollection(groupName));
    if (hit && hit.group) {
      const g = normalizeMongoGroupForMember(hit.group);
      return {
        foundGroup: g,
        foundKey: g.accountNumber || g.groupId || g.groupName || ''
      };
    }
  } catch (e) {
    console.error('[member] MongoDB group lookup error:', e.message);
  }
  return { foundGroup: null, foundKey: null };
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const restructureData = (data) => {
  const counties = Object.keys(data);
  const result = {};
  
  for (const county of counties) {
    const constis = data[county];
    for (const consti in constis) {
      const wards = constis[consti];
      for (const ward in wards) {
        const groups = wards[ward];
        if (Array.isArray(groups)) {
          for (const g of groups) {
            if (g.groupName) {
              if (!result[county]) result[county] = {};
              if (!result[county][consti]) result[county][consti] = {};
              if (!result[county][consti][ward]) result[county][consti][ward] = [];
              result[county][consti][ward].push(g);
            }
          }
        }
      }
    }
  }
  
  return result;
};

 const defaultMemberStructure = () => ({
   groups: {}
 });

const submitMemberDataToMongo = async (memberData, source) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      console.warn('[Mongo] Skipping submit for MongoDB not ready:', source);
      return null;
    }

    const groupsMap = memberData.group || memberData.groups;
    if (!groupsMap || typeof groupsMap !== 'object') {
      console.warn('[Mongo] Skipping submit for no groups found:', source);
      return null;
    }

    const results = [];
    for (const key of Object.keys(groupsMap)) {
      const group = groupsMap[key];
      const payload = {};
      Object.assign(payload, group);
      // Guard: Ensure groupName is set, use key as fallback but generate a unique key if both are empty
      const effectiveGroupName = (group.groupName && String(group.groupName).trim()) ? String(group.groupName).trim() : key;
      if (!effectiveGroupName) {
        console.warn('[Mongo] Skipping group with empty groupName and key, source:', source, 'key:', key);
        continue;
      }
      payload.groupName = effectiveGroupName;
      try {
        const result = await saveMemberGroupToMongo(payload);
        results.push(result);
      } catch (err) {
        console.error('[Mongo] Failed to save group:', err.message, 'groupName:', effectiveGroupName);
        // Continue with other groups instead of failing completely
      }
    }
    return results;
  } catch (err) {
    console.error('[Mongo] submit member failed (' + source + '):', err.message);
    return null;
  }
};

const normalizeKenyanPhone = (p = "") => {
  let digits = String(p).replace(/\D/g, "");

  // Handle +254..., 254..., and incorrect 2540... variants.
  if (digits.startsWith("254")) {
    digits = digits.substring(3);
  }
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
  }

  // Keep canonical local number as 9 digits (7XXXXXXXX).
  if (digits.length > 9) {
    digits = digits.slice(-9);
  }
  return digits;
};

const phoneVariants = (p = "") => {
  const canonical = normalizeKenyanPhone(p);
  const set = new Set();
  if (canonical) {
    set.add(canonical);
    set.add("0" + canonical);
    set.add("254" + canonical);
    set.add("+254" + canonical);
  }
  return set;
};

const findGroupInGeneral = (generalData, groupName) => {
  if (!generalData || !groupName) return null;
  const wanted = String(groupName || "").trim().toLowerCase();
  for (const county in generalData) {
    const constituencies = generalData[county] || {};
    for (const constituency in constituencies) {
      const wardArray = constituencies[constituency];
      if (!Array.isArray(wardArray)) continue;
      for (let idx = 0; idx < wardArray.length; idx++) {
        const item = wardArray[idx];
        const itemName = String(item && item.groupName ? item.groupName : "").trim().toLowerCase();
        if (item && typeof item === "object" && itemName === wanted) {
          return { county, constituency, wardArray, index: idx, group: item };
        }
      }
    }
  }
  return null;
};

const findGroupByMemberPhoneInGeneral = (generalData, memberPhone) => {
  const targetNorm = normalizeKenyanPhone(memberPhone || "");
  if (!generalData || !targetNorm) return null;

  for (const county in generalData) {
    const constituencies = generalData[county] || {};
    for (const constituency in constituencies) {
      const wardArray = constituencies[constituency];
      if (!Array.isArray(wardArray)) continue;
      for (let idx = 0; idx < wardArray.length; idx++) {
        const item = wardArray[idx];
        if (!item || typeof item !== "object" || !item.groupName) continue;

        const memberKeys = Object.keys(item).filter(k =>
          k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
        );
        for (const key of memberKeys) {
          const person = item[key];
          if (person && person.phone && normalizeKenyanPhone(person.phone) === targetNorm) {
            return { county, constituency, wardArray, index: idx, group: item };
          }
        }
      }
    }
  }
  return null;
};

const getMemberMetaFromGeneralGroup = (group, memberPhone) => {
  const targetNorm = normalizeKenyanPhone(memberPhone || "");
  if (!group || !targetNorm) return { index: "", memberNumber: "", phone: "" };

  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
  );

  for (const key of memberKeys) {
    const person = group[key];
    if (person && person.phone && normalizeKenyanPhone(person.phone) === targetNorm) {
      return {
        index: person.index || "",
        memberNumber: person.memberNumber || "",
        phone: person.phone || ""
      };
    }
  }

   return { index: "", memberNumber: "", phone: "" };
 };

  const flattenData = (data) => {
    const groups = [];
    for (const county in data) {
      const constis = data[county];
      for (const consti in constis) {
        const wardArray = constis[consti];
        if (Array.isArray(wardArray)) {
          for (const item of wardArray) {
            if (item && typeof item === 'object' && item.groupName) {
              // Also attach location info from the keys
              item._county = county;
              item._constituency = consti;
              groups.push(item);
            }
          }
        }
      }
    }
    return groups;
  };

  // ── Server-side in-memory group cache (TTL: 5 minutes) ────────────────────
  // Keyed by lower-cased groupName. Stores { verified, cachedAt, dataVersion }
  // so repeated button clicks skip the DB round-trip entirely.
  if (!global._groupVerifiedCache) global._groupVerifiedCache = {};
  const GROUP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (invalidated explicitly on writes)

  const _getCachedGroup = (cacheKey) => {
    const entry = global._groupVerifiedCache[cacheKey];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > GROUP_CACHE_TTL_MS) {
      delete global._groupVerifiedCache[cacheKey];
      return null;
    }
    return entry;
  };

  const _setCachedGroup = (cacheKey, verified, dataVersion) => {
    global._groupVerifiedCache[cacheKey] = {
      verified,
      cachedAt: Date.now(),
      dataVersion: dataVersion || 0
    };
  };

  const findVerifiedGroupInGroupsMembers = async (groupName, phone) => {
    const targetPhone = normalizeKenyanPhone(phone);
    const targetGroup = String(groupName || '').trim().toLowerCase();
    if (!targetPhone || !targetGroup) return null;

    // ── 1. TARGETED MongoDB query (replaces slow find({}) full scan) ──────────
    try {
      const ready = await ensureMongoReady();
      if (ready) {
        const mongoose = require('mongoose');
        const db = mongoose.connection.db;
        if (db) {
          const membersCol = db.collection('groups-members');
          const ciCollation = { locale: "en", strength: 2 };
          let doc = null;
          let hitIndex = -1; // 0=groupName, 1=groupId, 2=accountNumber, 3=regex
          const searchFields = [
            { path: 'constituencies.wards.data.groupName',        value: targetGroup },
            { path: 'constituencies.wards.data.groupId',          value: targetGroup },
            { path: 'constituencies.wards.data.accountNumber',    value: targetGroup }
          ];
          // 1) Exact-match queries with collation FIRST (index-enabled, no regex)
          for (let i = 0; i < searchFields.length && !doc; i++) {
            const sf = searchFields[i];
            try {
              doc = await membersCol.findOne(
                { [sf.path]: targetGroup },
                { projection: { county: 1, constituencies: 1, dataVersion: 1, _id: 0 }, collation: ciCollation, maxTimeMS: 2000 }
              );
              if (doc) hitIndex = i;
            } catch (_e) { /* fall through */ }
          }
          // 2) Fallback: combined regex query (used only if exact matches missed — rare)
          if (!doc) {
            const escaped = targetGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const targetRegex = new RegExp(`^${escaped}$`, 'i');
            doc = await membersCol.findOne(
              {
                'constituencies.wards.data': {
                  $elemMatch: {
                    $or: [
                      { groupName: targetRegex },
                      { groupId: targetRegex },
                      { accountNumber: targetRegex }
                    ]
                  }
                }
              },
              { projection: { county: 1, constituencies: 1, dataVersion: 1, _id: 0 }, maxTimeMS: 3000 }
            );
            if (doc) hitIndex = 3;
          }

          if (doc && Array.isArray(doc.constituencies)) {
            const constituencies = doc.constituencies;
            for (let ci = 0; ci < constituencies.length; ci++) {
              const constituency = constituencies[ci];
              if (!constituency || !Array.isArray(constituency.wards)) continue;
              const wards = constituency.wards;
              for (let wi = 0; wi < wards.length; wi++) {
                const ward = wards[wi];
                if (!ward || !Array.isArray(ward.data)) continue;
                const wardGroups = ward.data;
                for (let gi = 0; gi < wardGroups.length; gi++) {
                  const group = wardGroups[gi];
                  if (!group) continue;
                  const gName = String(group.groupName || '').trim().toLowerCase();
                  const gId   = String(group.groupId || '').trim().toLowerCase();
                  const gAcc  = String(group.accountNumber || '').trim().toLowerCase();
                  if (gName !== targetGroup && gId !== targetGroup && gAcc !== targetGroup) continue;

                  const members = group.members || {};
                  let matchedMemberKey = null;
                  let matchedMember = null;
                  const memberKeys = Object.keys(members);
                  for (let mi = 0; mi < memberKeys.length; mi++) {
                    const memberKey = memberKeys[mi];
                    const member = members[memberKey];
                    const rawPhone = member && (member.memberId || member.phone || member.phoneNumber)
                      ? (member.memberId || member.phone || member.phoneNumber)
                      : memberKey;
                    if (normalizeKenyanPhone(rawPhone) === targetPhone) {
                      matchedMemberKey = memberKey;
                      matchedMember = member;
                      break;
                    }
                  }

                  if (matchedMemberKey) {
                    const result = {
                      group,
                      county: group.county || doc.county,
                      constituency: group.constituency || constituency.name,
                      ward: group.ward || ward.name,
                      memberKey: matchedMemberKey,
                      member: matchedMember,
                      dataVersion: doc.dataVersion || 0
                    };
                    return result;
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[findVerifiedGroupInGroupsMembers] Mongo lookup error:', e.message);
    }

    return null;
  };

  const buildAccountSchemaFromGroup = (group) => {
    if (group.accountSchema && typeof group.accountSchema === 'object' && Object.keys(group.accountSchema).length > 0) {
      return { ...group.accountSchema };
    }

    const members = group.members || {};
    const firstMember = members[Object.keys(members)[0]];
    const accounts = firstMember && firstMember.accounts ? firstMember.accounts : {};
    const schema = {};

    for (const accId of Object.keys(accounts)) {
      const acc = accounts[accId];
      schema[accId] = {
        accountId: acc.accountId || accId,
        accountName: acc.accountName || accId,
        expectedAmount: acc.expectedAmount || '0'
      };
    }

    return schema;
  };

  const buildGroupAccountsPayloadFromGroupsMembers = (verified) => {
    const group = verified.group;
    const members = group.members || {};
    const accountSchema = buildAccountSchemaFromGroup(group);
    const accountDetails = {};

    for (const accId of Object.keys(accountSchema)) {
      const schema = accountSchema[accId];
      const memberList = [];
      const expectedAmt = Number(schema.expectedAmount || 0);
      let tOpen = 0, tIn = 0, tOut = 0, tClose = 0;
      let paidCount = 0;

      for (const memberKey of Object.keys(members)) {
        const member = members[memberKey];
        const account = member.accounts && member.accounts[accId];
        const financials = (account && account.financials) || {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0
        };
        const oB = Number(financials.openingBalance || 0);
        const aI = Number(financials.amountIn || 0);
        const aO = Number(financials.amountOut || 0);
        const cB = Number(financials.closingBalance || 0);
        tOpen += oB; tIn += aI; tOut += aO; tClose += cB;
        if (expectedAmt > 0 && aI >= expectedAmt) paidCount++;

        memberList.push({
          memberId: member.memberId || memberKey,
          name: member.name || memberKey,
          openingBalance: oB,
          amountIn: aI,
          amountOut: aO,
          closingBalance: cB
        });
      }

      accountDetails[accId] = {
        accountId: schema.accountId,
        accountName: schema.accountName,
        expectedAmount: expectedAmt,
        members: memberList,
        totalOpening: tOpen,
        totalIn: tIn,
        totalOut: tOut,
        totalBalance: tClose,
        paidCount
      };
    }

    // Format current verified member data object
    const verifiedMember = verified.member || {};
    const verifiedMemberKey = verified.memberKey || '';
    const verifiedMemberId = verifiedMember.memberId || verifiedMember.phone || verifiedMemberKey;
    const verifiedMemberName = verifiedMember.name || verifiedMemberKey;
    const targetPhone = normalizeKenyanPhone(verifiedMemberId);
    const nameLower = String(verifiedMemberName).toLowerCase();

    let memberRole = String(verifiedMember.role || verifiedMember.type || '').toLowerCase();

    // Single linear pass: chairperson → trustees/officials arrays → trustee_/official_ keys → dealer/agent name heuristics
    if (!memberRole) {
      const chairPhone = normalizeKenyanPhone(group.phone || group.chairpersonPhone || group.chairpersonalphonenumber);
      if (chairPhone && chairPhone === targetPhone) memberRole = 'trustee';
    }
    if (!memberRole) {
      const trusteesArr = Array.isArray(group.trustees) ? group.trustees : [];
      const officialsArr = Array.isArray(group.officials) ? group.officials : [];
      const combinedLen = Math.max(trusteesArr.length, officialsArr.length);
      for (let i = 0; i < combinedLen && !memberRole; i++) {
        if (i < trusteesArr.length) {
          const t = trusteesArr[i];
          if (t && normalizeKenyanPhone(t.phone || t.memberId || t.phoneNumber) === targetPhone) memberRole = 'trustee';
        }
        if (!memberRole && i < officialsArr.length) {
          const o = officialsArr[i];
          if (o && normalizeKenyanPhone(o.phone || o.memberId || o.phoneNumber) === targetPhone) memberRole = 'official';
        }
      }
    }
    if (!memberRole) {
      for (const key of Object.keys(group)) {
        if (key.startsWith('trustee_') || key.startsWith('official_')) {
          const info = group[key];
          if (info && normalizeKenyanPhone(info.phone || info.memberId || info.phoneNumber) === targetPhone) {
            memberRole = key.startsWith('trustee_') ? 'trustee' : 'official';
            break;
          }
        }
      }
    }
    if (!memberRole) {
      if (verifiedMember.dealer || verifiedMember.isDealer) {
        memberRole = 'dealer';
      } else if (verifiedMember.agent || verifiedMember.isAgent) {
        memberRole = 'official';
      }
    }
    if (!memberRole) memberRole = 'member';

    const isOfficialOrTrusty = memberRole === 'trustee' || memberRole === 'official' || memberRole === 'trusty' || memberRole === 'dealer' || memberRole === 'agent' || memberRole === 'chairperson' || memberRole === 'treasurer' || memberRole === 'secretary';
    const isMemberOnly = !isOfficialOrTrusty;

    // Ensure member's accounts are populated with schema accounts
    const memberAccounts = { ...(verifiedMember.accounts || {}) };
    let sumOpenBal = 0;
    let sumAmtIn = 0;
    let sumAmtOut = 0;
    let sumClosingBal = 0;

    for (const accId of Object.keys(accountSchema)) {
      const schema = accountSchema[accId];
      const acc = memberAccounts[accId] || {};
      const fins = acc.financials || {
        openingBalance: 0,
        amountIn: 0,
        amountOut: 0,
        closingBalance: 0
      };
      const openBal = Number(fins.openingBalance || 0);
      const amtIn = Number(fins.amountIn || 0);
      const amtOut = Number(fins.amountOut || 0);
      const closingBal = Number(fins.closingBalance || 0);

      sumOpenBal += openBal;
      sumAmtIn += amtIn;
      sumAmtOut += amtOut;
      sumClosingBal += closingBal;

      memberAccounts[accId] = {
        accountId: schema.accountId || accId,
        accountName: acc.accountName || schema.accountName || accId,
        expectedAmount: Number(acc.expectedAmount || schema.expectedAmount || 0),
        financials: {
          openingBalance: openBal,
          amountIn: amtIn,
          amountOut: amtOut,
          closingBalance: closingBal,
          transactionHistory: fins.transactionHistory || []
        }
      };
    }

    const memberFinancials = verifiedMember.memberFinancials || {
      openingBalance: sumOpenBal,
      amountIn: sumAmtIn,
      amountOut: sumAmtOut,
      closingBalance: sumClosingBal
    };

    const memberTitle = verifiedMember.title || verifiedMember.roleTitle || verifiedMember.type || '';

    // Ensure FirstName / MiddleName / SecondName / LastName are populated (fallback via display-name split)
    const _rawFirst = verifiedMember.FirstName || verifiedMember.firstName || verifiedMember.first_name || '';
    const _rawMiddle = verifiedMember.MiddleName || verifiedMember.middleName || verifiedMember.SecondName || verifiedMember.secondName || '';
    const _rawLast = verifiedMember.LastName || verifiedMember.lastName || verifiedMember.last_name || '';
    const _hasSplit = !!( _rawFirst || _rawMiddle || _rawLast);
    const _split = _hasSplit ? null : splitDisplayName(verifiedMemberName);
    const _FirstName = _rawFirst || (_split ? _split.FirstName : '');
    const _MiddleName = _rawMiddle || (_split ? _split.MiddleName : '');
    const _LastName = _rawLast || (_split ? _split.LastName : '');

    const currentUser = {
      ...verifiedMember,
      memberId: verifiedMemberId,
      name: verifiedMemberName,
      FirstName: _FirstName,
      MiddleName: _MiddleName,
      SecondName: _MiddleName,
      LastName: _LastName,
      role: memberRole,
      title: memberTitle,
      roleTitle: memberTitle,
      memberFinancials,
      accounts: memberAccounts
    };

    const constitutionCreated = group.constitutionKeyGeneratedAt || group.constitutionKeySetByAgentAt || group.createdAt || group.principlesSetAt || new Date().toISOString();
    const now = new Date();
    const created = new Date(constitutionCreated);
    const diffTime = Math.abs(now.getTime() - created.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const intervals = (group.principles && group.principles.intervals) ? group.principles.intervals : {};
    const endSavingPeriod = intervals.endSavingPeriod || '1-year';
    let totalRounds = 52;
    if (endSavingPeriod === '6-months') totalRounds = 26;
    else if (endSavingPeriod === '2-years') totalRounds = 104;
    else if (endSavingPeriod === '3-years') totalRounds = 156;
    else if (endSavingPeriod === '4-years') totalRounds = 208;
    else if (endSavingPeriod === '5-years') totalRounds = 260;
    const activeRound = Math.min(totalRounds, Math.ceil(diffDays / 7) || 1);
    const daysUntilMeeting = 7 - (diffDays % 7);
    const remainRounds = Math.max(0, totalRounds - activeRound);
    const summaryStats = {
      activeRound,
      daysUntilMeeting,
      totalMembers: Object.keys(members).length,
      remainRounds,
      totalRounds
    };

    return {
      success: true,
      verified: true,
      source: 'groups-members',
      groupName: group.groupName,
      groupNumber: group.groupNumber || '',
      groupId: group.groupId || '',
      accountNumber: group.accountNumber || group.groupId || '',
      phase: group.phase || 3,
      county: verified.county || group.county || '',
      constituency: verified.constituency || group.constituency || '',
      ward: verified.ward || group.ward || '',
      accountSchema,
      accountDetails,
      totalMembers: Object.keys(members).length,
      currentUser,
      verifiedMember: currentUser,
      verifiedMemberId,
      verifiedMemberName,
      loggedInMemberName: verifiedMemberName,
      loggedInMemberId: verifiedMemberId,
      loggedInMemberRole: memberRole,
      loggedInMemberTitle: memberTitle,
      isMemberOnly,
      summaryStats,
      groupTransaction: group.groupTransaction || {},
      countyTransaction: group.countyTransaction || {}
    };
  };

  // Generate account templates with dateIntervalCycle for a group
  const generateAccountTemplates = (group) => {
    const intervals = group.principles?.intervals || {};
    const frequency = intervals.frequency || '';
    const endSavingPeriod = intervals.endSavingPeriod || '1-year';
    const startRaw = group.principlesSetAt || group.createdAt || new Date().toISOString();
    const startDate = new Date(startRaw);
    const endDate = new Date(startDate);

    // Adjust end date based on duration
    if (endSavingPeriod === '6-months') endDate.setMonth(endDate.getMonth() + 6);
    else if (endSavingPeriod === '1-year') endDate.setFullYear(endDate.getFullYear() + 1);
    else if (endSavingPeriod === '2-years') endDate.setFullYear(endDate.getFullYear() + 2);
    else if (endSavingPeriod === '3-years') endDate.setFullYear(endDate.getFullYear() + 3);
    else if (endSavingPeriod === '4-years') endDate.setFullYear(endDate.getFullYear() + 4);
    else if (endSavingPeriod === '5-years') endDate.setFullYear(endDate.getFullYear() + 5);

    const formatDate = (d) => d.toISOString().split('T')[0];

    // Build a map of expectedAmount from otherContributions
    const contribMap = {};
    if (group.principles?.otherContributions && Array.isArray(group.principles.otherContributions)) {
      group.principles.otherContributions.forEach(c => {
        contribMap[c.accountNumber] = c.expectedAmount;
      });
    }

    // Calculate total rounds based on frequency
    const msPerDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((endDate - startDate) / msPerDay);
    let totalRounds = 0;
    if (frequency === 'daily') totalRounds = Math.floor(diffDays) + 1;
    else if (frequency === 'weekly') totalRounds = Math.floor(diffDays / 7) + 1;
    else if (frequency === 'monthly') {
      const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth()) + 1;
      totalRounds = months;
    } else if (frequency === 'yearly') totalRounds = (endDate.getFullYear() - startDate.getFullYear()) + 1;

    // Default account definitions
    const defaultAccts = {
      "001": { accountId: "001", accountName: "Saving" },
      "002": { accountId: "002", accountName: "Registration" },
      "003": { accountId: "003", accountName: "latenes" },
      "004": { accountId: "004", accountName: "welfare" }
    };

    const templates = {};
    Object.keys(defaultAccts).forEach(id => {
      const acc = defaultAccts[id];
      const expectedAmount = contribMap[id] || "100";

      // Build rounds array
      const rounds = [];
      let current = new Date(startDate);
      for (let i = 1; i <= totalRounds; i++) {
        const roundDate = formatDate(current);
        rounds.push({
          roundNumber: i,
          scheduledDate: roundDate,
          status: 'pending',
          amount: parseFloat(expectedAmount),
          accountroundPerformance: []
        });

        // Advance to next cycle date
        if (frequency === 'daily') current.setDate(current.getDate() + 1);
        else if (frequency === 'weekly') current.setDate(current.getDate() + 7);
        else if (frequency === 'monthly') current.setMonth(current.getMonth() + 1);
        else if (frequency === 'yearly') current.setFullYear(current.getFullYear() + 1);
      }

      templates[id] = {
        accountId: acc.accountId,
        accountName: acc.accountName,
        expectedAmount: expectedAmount,
        financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 },
        transactionHistory: [],
        dateIntervalCycle: {
          frequency,
          period: frequency === 'weekly' ? (intervals.period || '') : frequency === 'monthly' ? (intervals.dayOfWeek || intervals.period || '') : frequency === 'yearly' ? (intervals.month || '') : '',
          weekOfMonth: intervals.weekOfMonth || '',
          month: intervals.month || '',
          startDate: formatDate(startDate),
          endDate: formatDate(endDate),
          totalRounds: totalRounds,
          expectedAmountPerRound: expectedAmount,
          totalExpectedAmount: (parseFloat(expectedAmount) * totalRounds).toString(),
          rounds: rounds
        }
      };
    });

    return templates;
  };

  // Compute per-round contribution breakdown for an account from transaction history
  const computeRoundContributions = (account) => {
    const cycle = account.dateIntervalCycle;
    if (!cycle || !cycle.rounds || !Array.isArray(cycle.rounds)) return [];
    const contributions = {};
    cycle.rounds.forEach(r => { contributions[r.roundNumber] = 0; });

    if (account.transactionHistory && Array.isArray(account.transactionHistory)) {
      account.transactionHistory.forEach(tx => {
        const txDate = new Date(tx.date);
        let targetRound = null;
        // Find the most recent round whose scheduledDate <= txDate
        for (let i = cycle.rounds.length - 1; i >= 0; i--) {
          const r = cycle.rounds[i];
          const sched = new Date(r.scheduledDate);
          if (txDate >= sched) { targetRound = r; break; }
        }
        if (targetRound) contributions[targetRound.roundNumber] += parseFloat(tx.amount) || 0;
      });
    }

    return Object.keys(contributions)
      .map(num => {
        const roundNum = parseInt(num, 10);
        const contributed = contributions[num];
        const expected = parseFloat(cycle.expectedAmountPerRound) || 0;
        const status = expected > 0 && contributed >= expected ? 'completed' : 'pending';
        return { roundNumber: roundNum, contributedAmount: contributed, status: status };
      })
      .sort((a, b) => a.roundNumber - b.roundNumber);
  };

  const syncFromGeneral = () => {
   const generalData = readJSON(generalFile, {});
   if (!generalData || Object.keys(generalData).length === 0) {
     return;
   }

   const dataFile = path.join(__dirname, "../data.json");
   const usersData = readJSON(dataFile, []);
   const getUserName = (phone) => {
     const u = usersData.find(user => user.phoneNumber === phone || user.phoneNumber === '0' + phone || user.phoneNumber === '+254' + phone.substring(1));
     return u ? `${u.FirstName} ${u.LastName}`.trim() : null;
   };

   const allGroups = flattenData(generalData);
   const memberData = readJSON(memberFile, defaultMemberStructure());

   if (!memberData.groups) memberData.groups = {};

   allGroups.forEach(group => {
     const groupName = group.groupName;
     if (!groupName) return;

     // Find or create group entry
     let groupAccountNum = Object.keys(memberData.groups).find(key => memberData.groups[key].groupName === groupName);
     if (!groupAccountNum) {
       const groupNum = Object.keys(memberData.groups).length + 1;
       groupAccountNum = group.accountNumber || "ACC" + groupNum;
        memberData.groups[groupAccountNum] = {
          groupNumber: groupNum,
          groupName: groupName,
          members: {}
       };
     }

      const currentGroup = memberData.groups[groupAccountNum];

      // Generate account templates with dateIntervalCycle for this group
      const accountTemplates = generateAccountTemplates(group);

      // Extract members from general group structure (trustee_, official_, member_)
      const memberKeys = Object.keys(group).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );

      memberKeys.forEach(key => {
        const item = group[key];
        if (item && item.phone) {
          const memberId = item.phone;
          const normalizedId = memberId.toString().trim();
          const memberName = getUserName(normalizedId) || item.title || key.replace(/_/g, ' ').replace(/(\d+)/, '#$1');

          if (!currentGroup.members[normalizedId]) {
            // New member: assign fresh templates with cycles
            currentGroup.members[normalizedId] = {
              memberId: normalizedId,
              name: memberName,
              memberFinancials: {
                openingBalance: 0,
                amountIn: 0,
                amountOut: 0,
                closingBalance: 0
              },
              accounts: JSON.parse(JSON.stringify(accountTemplates)), // deep clone templates
              processedDeductions: []
            };
          } else {
            // Existing member: ensure accounts have dateIntervalCycle (merge if missing)
            const existing = currentGroup.members[normalizedId];
            existing.name = memberName;
            if (existing.accounts) {
              Object.keys(accountTemplates).forEach(accId => {
                if (existing.accounts[accId] && !existing.accounts[accId].dateIntervalCycle) {
                  existing.accounts[accId].dateIntervalCycle = accountTemplates[accId].dateIntervalCycle;
                }
                // If account doesn't exist at all, add it with cycle
                if (!existing.accounts[accId]) {
                  existing.accounts[accId] = accountTemplates[accId];
                }
              });
            }
          }
        }
      });
   });

    writeJSON(memberFile, memberData);
    submitMemberDataToMongo(memberData, 'sync').catch(err => console.error('[Mongo] submit member failed:', err.message));
  };

  // Sync regional member.json (regions structure) to MongoDB groups-members collection
  const syncRegionsToMongo = async () => {
    try {
      const ready = await ensureMongoReady();
      if (!ready) {
        console.warn('[regions-sync] MongoDB not ready, skipping');
        return;
      }
      
      const mongoose = require('mongoose');
      const col = mongoose.connection.db.collection('groups-members');
      
      const memberData = readJSON(memberRegionsFile, { regions: {} });
      const regions = memberData.regions || {};
      
      // Sync regionTransaction
      if (regions.regionTransaction) {
        await col.updateOne(
          { _id: 'regionTransaction' },
          { $set: { regionTransaction: regions.regionTransaction, syncedAt: new Date().toISOString() } },
          { upsert: true }
        );
      }
      
      // Sync each county - preserve FULL structure including constituencies and wards
      for (const countyKey in regions) {
        if (countyKey === 'regionTransaction') continue;
        
        const countyDoc = regions[countyKey];
        if (!countyDoc || !countyDoc.county) continue;
        
        // Preserve full nested structure
        const payload = {
          county: countyDoc.county,
          countyId: countyDoc.countyId || countyKey,
          countryTransaction: countyDoc.countryTransaction || {},
          constituencies: countyDoc.constituencies || [],
          syncedAt: new Date().toISOString()
        };
        
        await col.updateOne(
          { county: countyDoc.county },
          { $set: payload },
          { upsert: true }
        );
      }
      
      console.log('[regions-sync] Synced to MongoDB successfully');
    } catch (e) {
      console.error('[regions-sync] Error:', e.message);
    }
  };

router.post("/sync", async (req, res) => {
  try {
    syncFromGeneral();
    await syncRegionsToMongo();
    res.json({ success: true, message: "Synced from general.json and regions to MongoDB" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", (req, res) => {
  const data = readJSON(memberFile, defaultMemberStructure());
  res.json(data);
});

router.get("/group/:groupNumber", (req, res) => {
  const { groupNumber } = req.params;
  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.groups).find(k => data.groups[k].groupNumber == groupNumber);
  const group = groupKey ? data.groups[groupKey] : null;
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  res.json(group);
});

router.get("/group/:groupNumber/member/:memberId", (req, res) => {
  const { groupNumber, memberId } = req.params;
  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.groups).find(k => data.groups[k].groupNumber == groupNumber);
  const group = groupKey ? data.groups[groupKey] : null;
  if (!group || !group.members || !group.members[memberId]) {
    return res.status(404).json({ error: "Member not found" });
  }
  res.json(group.members[memberId]);
});

router.post("/init", (req, res) => {
  const data = defaultMemberStructure();
  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'init').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, message: "member.json initialized", data });
});

router.post("/group", (req, res) => {
  const { groupNumber, accountNumber, groupName } = req.body;
  
  // Guard: groupName is required
  if (!groupName || !String(groupName).trim()) {
    return res.status(400).json({ success: false, error: "groupName is required" });
  }
  
  const data = readJSON(memberFile, defaultMemberStructure());
  const cleanGroupName = String(groupName).trim();

  const accountNum = accountNumber || "ACC" + (Object.keys(data.groups).length + 1);

  const newGroup = {
    groupNumber: groupNumber || Object.keys(data.groups).length + 1,
    groupName: cleanGroupName,
    members: {}
  };

  data.groups[accountNum] = newGroup;
  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'add-group').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, group: newGroup });
});

router.post("/group/:groupNumber/member", (req, res) => {
  const { groupNumber } = req.params;
  const { memberId, accounts } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: "memberId is required" });
  }

  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.groups).find(k => data.groups[k].groupNumber == groupNumber);
  const group = groupKey ? data.groups[groupKey] : null;

  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }

  // Determine accounts to assign
  let accountsToUse = accounts;
  if (!accountsToUse) {
    // Attempt to generate templates from general.json using group's principles
    try {
      const generalData = readJSON(generalFile, {});
      const flatGroups = flattenData(generalData);
      const genGroup = flatGroups.find(g => g.groupName === group.groupName);
      if (genGroup) {
        accountsToUse = generateAccountTemplates(genGroup);
      } else {
        // Fallback: basic default with minimal cycle info
        const today = new Date();
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const fmt = d => d.toISOString().split('T')[0];
        const baseCycle = {
          frequency: 'monthly',
          startDate: fmt(today),
          endDate: fmt(nextMonth),
          totalRounds: 1,
          expectedAmountPerRound: "100",
          totalExpectedAmount: "100",
          rounds: [{ roundNumber: 1, scheduledDate: fmt(today), status: 'pending', amount: 100, accountroundPerformance: [] }]
        };
        accountsToUse = {
          "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
          "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
          "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
          "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle }
        };
      }
    } catch (e) {
      // Fallback if error reading general.json
      const today = new Date();
      const nextMonth = new Date(today);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const fmt = d => d.toISOString().split('T')[0];
      const baseCycle = {
        frequency: 'monthly',
        startDate: fmt(today),
        endDate: fmt(nextMonth),
        totalRounds: 1,
        expectedAmountPerRound: "100",
        totalExpectedAmount: "100",
        rounds: [{ roundNumber: 1, scheduledDate: fmt(today), status: 'pending', amount: 100, accountroundPerformance: [] }]
      };
      accountsToUse = {
        "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
        "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
        "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle },
        "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [], dateIntervalCycle: baseCycle }
      };
    }
  }

  if (!group.members) group.members = {};
  group.members[memberId] = {
    memberId: memberId,
    name: "", // will be set later via name sync
    memberFinancials: {
      openingBalance: 0,
      amountIn: 0,
      amountOut: 0,
      closingBalance: 0
    },
    accounts: accountsToUse,
    processedDeductions: []
  };

  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'add-member').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, member: group.members[memberId] });
});

router.put("/group/:groupNumber/member/:memberId/account/:accountNumber/transaction", (req, res) => {
  const { groupNumber, memberId, accountNumber } = req.params;
  const transactionData = req.body;

  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.groups).find(k => data.groups[k].groupNumber == groupNumber);
  const group = groupKey ? data.groups[groupKey] : null;

  if (!group || !group.members || !group.members[memberId] || !group.members[memberId].accounts || !group.members[memberId].accounts[accountNumber]) {
    return res.status(404).json({ error: "Account not found" });
  }

  const account = group.members[memberId].accounts[accountNumber];
  account.transactionHistory = transactionData.transactions || transactionData || [];

  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'update-transaction').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, account });
});

router.put("/group/:groupNumber/contribution/:accountNumber/transaction", (req, res) => {
  const { groupNumber, accountNumber } = req.params;
  const transactionData = req.body;

  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.groups).find(k => data.groups[k].groupNumber == groupNumber);
  const group = groupKey ? data.groups[groupKey] : null;

  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }

  // Initialize otherContributions if not exists
  if (!group.otherContributions) {
    group.otherContributions = {};
  }
  if (!group.otherContributions[accountNumber]) {
    group.otherContributions[accountNumber] = { accountNumber: accountNumber, transactions: [] };
  }

  group.otherContributions[accountNumber].transactions = transactionData;

  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'update-contribution').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, contribution: group.otherContributions[accountNumber] });
});

 router.get("/structure", (req, res) => {
   res.json(defaultMemberStructure());
 });

// ── Helper: Find group in groups-members regional structure (MongoDB) ──
// Supports lookup by groupName or groupId
const findGroupInGroupsMembersCollection = async (groupName) => {
  const ready = await ensureMongoReady();
  if (!ready) return null;

  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  if (!db) return null;

  const targetName = String(groupName || '').trim().toLowerCase();

  const cursor = db.collection('groups-members').find({}, { projection: { county: 1, constituencies: 1, _id: 0 } });

  for await (const doc of cursor) {
    if (!doc || !doc.constituencies || !Array.isArray(doc.constituencies)) continue;

    for (const constituency of doc.constituencies) {
      if (!constituency || !Array.isArray(constituency.wards)) continue;

      for (const ward of constituency.wards) {
        if (!ward || !Array.isArray(ward.data)) continue;

        for (const group of ward.data) {
          if (!group) continue;
          // Check by groupName or groupId
          const groupNameMatch = group.groupName && String(group.groupName).trim().toLowerCase() === targetName;
          const groupIdMatch = group.groupId && String(group.groupId).trim().toLowerCase() === targetName;
          if (groupNameMatch || groupIdMatch) {
            return {
              group,
              county: group.county || doc.county,
              constituency: group.constituency || constituency.name,
              ward: group.ward || ward.name
            };
          }
        }
      }
    }
  }

  return null;
};

// ── Helper: Find group in member.json (flat structure) ──
// Supports lookup by groupName or groupId
const findGroupInMemberJson = (groupName) => {
  const memberData = readJSON(memberFile, { groups: {} });
  if (!memberData.groups || Object.keys(memberData.groups).length === 0) return null;

  const target = String(groupName || '').trim().toLowerCase();
  
  // First try: lookup by key (accountNumber/groupId)
  if (memberData.groups[target] || memberData.groups[groupName]) {
    const group = memberData.groups[target] || memberData.groups[groupName];
    return {
      group,
      county: group.county || '',
      constituency: group.constituency || '',
      ward: group.ward || ''
    };
  }
  
  // Second try: lookup by groupName field
  for (const key in memberData.groups) {
    const group = memberData.groups[key];
    if (group && group.groupName && String(group.groupName).trim().toLowerCase() === target) {
      return {
        group,
        county: group.county || '',
        constituency: group.constituency || '',
        ward: group.ward || ''
      };
    }
    // Also check groupId field
    if (group && group.groupId && String(group.groupId).trim().toLowerCase() === target) {
      return {
        group,
        county: group.county || '',
        constituency: group.constituency || '',
        ward: group.ward || ''
      };
    }
  }
  return null;
};

// ── Helper: split a display name into FirstName / MiddleName / LastName ──
const splitDisplayName = (rawName) => {
  const s = String(rawName || '').replace(/\s+/g, ' ').trim();
  const out = { FirstName: '', MiddleName: '', LastName: '' };
  if (!s) return out;
  const parts = s.split(' ');
  if (parts.length === 1) {
    out.FirstName = parts[0];
  } else if (parts.length === 2) {
    out.FirstName = parts[0];
    out.LastName = parts[1];
  } else {
    out.FirstName = parts[0];
    out.MiddleName = parts.slice(1, -1).join(' ');
    out.LastName = parts[parts.length - 1];
  }
  return out;
};

// ── Helper: Normalize member accounts from member.json structure ──
const normalizeMembersFromMemberJson = (group) => {
  const members = group.members || {};
  const normalized = {};

  for (const phone in members) {
    const m = members[phone];
    const rawFirst = m.FirstName || m.firstName || m.first_name || '';
    const rawMiddle = m.MiddleName || m.middleName || m.SecondName || m.secondName || '';
    const rawLast = m.LastName || m.lastName || m.last_name || '';
    const hasSplit = !!(rawFirst || rawMiddle || rawLast);
    const split = hasSplit ? null : splitDisplayName(m.name || phone);
    const FirstName = rawFirst || (split ? split.FirstName : '');
    const MiddleName = rawMiddle || (split ? split.MiddleName : '');
    const LastName = rawLast || (split ? split.LastName : '');

    normalized[phone] = {
      memberId: m.memberId || phone,
      name: m.name || phone,
      FirstName,
      MiddleName,
      SecondName: MiddleName,
      LastName,
      role: m.role || 'member',
      title: m.title || m.roleTitle || m.type || '',
      roleTitle: m.roleTitle || m.title || m.type || '',
      type: m.type || m.role || 'member',
      accounts: (m.accounts && typeof m.accounts === 'object' && !Array.isArray(m.accounts))
        ? { ...m.accounts }
        : (m.accounts || {})
    };
  }

  return normalized;
};

// ── Helper: Normalize member accounts from regional groups-members structure ──
const normalizeMembersFromGroupsMembers = (group) => {
  const members = group.members || {};
  const normalized = {};

  for (const phone in members) {
    const m = members[phone];
    const rawFirst = m.FirstName || m.firstName || m.first_name || '';
    const rawMiddle = m.MiddleName || m.middleName || m.SecondName || m.secondName || '';
    const rawLast = m.LastName || m.lastName || m.last_name || '';
    const hasSplit = !!(rawFirst || rawMiddle || rawLast);
    const split = hasSplit ? null : splitDisplayName(m.name || phone);
    const FirstName = rawFirst || (split ? split.FirstName : '');
    const MiddleName = rawMiddle || (split ? split.MiddleName : '');
    const LastName = rawLast || (split ? split.LastName : '');

    normalized[phone] = {
      memberId: m.memberId || m.phone || phone,
      name: m.name || phone,
      FirstName,
      MiddleName,
      SecondName: MiddleName,
      LastName,
      role: m.role || m.type || 'member',
      title: m.title || m.roleTitle || m.type || '',
      roleTitle: m.roleTitle || m.title || m.type || '',
      type: m.type || m.role || 'member',
      accounts: (m.accounts && typeof m.accounts === 'object' && !Array.isArray(m.accounts))
        ? { ...m.accounts }
        : (m.accounts || {})
    };
  }

  return normalized;
};

// POST /member/group-accounts-schema
// Returns the accountSchema (account types) for a group and, for each account type,
// lists all members with their individual financials for that account.
// Trustees and Officials see all members. Members see only their own data.
// Data sources: member.json (local) → groups-members MongoDB → MemberGroup MongoDB
router.post("/group-accounts-schema", async (req, res) => {
  const { groupName, accountNumber, phone } = req.body;
  if (!groupName && !accountNumber) {
    return res.status(400).json({ error: "groupName or accountNumber is required" });
  }

  let foundGroup = null;
  let foundInSource = null;

  // Strategy 1: Lookup in member.json (flat structure) - reliable local fallback
  if (groupName) {
    const jsonFound = findGroupInMemberJson(groupName);
    if (jsonFound) {
      foundGroup = jsonFound.group;
      foundInSource = 'member.json';
      console.log('[group-accounts-schema] Found in member.json by groupName:', groupName);
    }
  }

  // Strategy 2: Try accountNumber as groupKey in member.json (phone-based keys)
  if (!foundGroup && accountNumber) {
    const memberData = readJSON(memberFile, { groups: {} });
    if (memberData.groups && memberData.groups[accountNumber]) {
      foundGroup = memberData.groups[accountNumber];
      foundInSource = 'member.json';
      console.log('[group-accounts-schema] Found in member.json by accountNumber key:', accountNumber);
    }
  }

  // Strategy 3: Lookup by groupName in MemberGroup collection (MongoDB)
  if (!foundGroup && groupName) {
    try {
      foundGroup = await getMemberGroupFromMongo(groupName);
      if (foundGroup) {
        foundInSource = 'MemberGroup';
        console.log('[group-accounts-schema] Found in MemberGroup MongoDB by groupName:', groupName);
      }
    } catch (e) {
      console.warn('[group-accounts-schema] MemberGroup MongoDB lookup failed:', e.message);
    }
  }

  // Strategy 4: Try accountNumber as groupKey in MemberGroup (MongoDB)
  if (!foundGroup && accountNumber) {
    try {
      const trimmedAccNum = String(accountNumber).trim();
      foundGroup = await MemberGroup.findOne({ groupKey: trimmedAccNum }).lean();
      if (foundGroup) {
        foundInSource = 'MemberGroup';
        console.log('[group-accounts-schema] Found in MemberGroup MongoDB by accountNumber groupKey:', trimmedAccNum);
      }
    } catch (e) {
      console.warn('[group-accounts-schema] MemberGroup lookup by accountNumber failed:', e.message);
    }
  }

  // Strategy 5: Lookup in groups-members regional collection (MongoDB)
  if (!foundGroup && groupName) {
    try {
      const regionalFound = await findGroupInGroupsMembersCollection(groupName);
      if (regionalFound) {
        foundGroup = regionalFound.group;
        foundInSource = 'groups-members';
        console.log('[group-accounts-schema] Found in groups-members MongoDB by groupName:', groupName);
      }
    } catch (e) {
      console.warn('[group-accounts-schema] groups-members MongoDB lookup failed:', e.message);
    }
  }

  // Strategy 5b: Also try accountNumber as groupId in groups-members
  if (!foundGroup && accountNumber) {
    try {
      const regionalFound = await findGroupInGroupsMembersCollection(accountNumber);
      if (regionalFound) {
        foundGroup = regionalFound.group;
        foundInSource = 'groups-members';
        console.log('[group-accounts-schema] Found in groups-members MongoDB by groupId:', accountNumber);
      }
    } catch (e) {
      console.warn('[group-accounts-schema] groups-members MongoDB lookup by groupId failed:', e.message);
    }
  }

  if (!foundGroup) {
    const sourcesTried = [
      groupName ? `member.json(groupName="${groupName}")` : '',
      accountNumber ? `member.json(accountNumber="${accountNumber}")` : '',
      groupName ? `MemberGroup(groupName="${groupName}")` : '',
      accountNumber ? `MemberGroup(accountNumber="${accountNumber}")` : '',
      groupName ? `groups-members(groupName="${groupName}")` : '',
      accountNumber ? `groups-members(groupId="${accountNumber}")` : ''
    ].filter(Boolean).join(', ');
    const errPayload = {
      error: `Group not found. Tried: ${sourcesTried}.`,
      debug: {
        groupName,
        accountNumber,
        phone,
        loginPhone: phone ? normalizeKenyanPhone(phone) : null
      }
    };
    console.error('[group-accounts-schema] 404:', errPayload);
    return res.status(404).json(errPayload);
  }

  // Normalize members based on source
  let normalizedMembers = {};
  try {
    if (foundInSource === 'groups-members') {
      normalizedMembers = normalizeMembersFromGroupsMembers(foundGroup);
    } else {
      normalizedMembers = normalizeMembersFromMemberJson(foundGroup);
    }
  } catch (e) {
    console.error('[group-accounts-schema] Member normalization failed:', e.message, 'source=', foundInSource, 'groupName=', groupName);
    return res.status(500).json({ error: "Failed to process member data: " + e.message });
  }

  // Determine user's role and whether to restrict data
  const loginPhone = phone ? normalizeKenyanPhone(phone) : null;
  let isMemberOnly = false;
  let loggedInMemberKey = null;
  let loggedInMemberRole = null;
  let loggedInMemberName = null;
  let loggedInMemberTitle = null;

  if (loginPhone) {
    // Find the logged-in member in the normalized members
    for (const memberKey in normalizedMembers) {
      const m = normalizedMembers[memberKey];
      // Match against all possible phone fields (same logic as normalizeMembersFromGroupsMembers)
      const memberPhone = normalizeKenyanPhone(m.memberId || m.phone || m.phoneNumber || memberKey);
      if (memberPhone === loginPhone) {
        loggedInMemberKey = memberKey;
        loggedInMemberRole = (m.role || m.type || 'member').toLowerCase();
        loggedInMemberName = m.name || loginPhone;
        loggedInMemberTitle = m.title || m.roleTitle || m.type || '';
        break;
      }
    }

    // Validate: if we couldn't find the user in this group, log it clearly
    if (!loggedInMemberKey) {
      console.warn(`[group-accounts-schema] Phone ${loginPhone} not found in group members. Treating as non-member (full access).`);
    }

    // If role is 'member' (not trustee or official), restrict view
    if (loggedInMemberKey && loggedInMemberRole && loggedInMemberRole !== 'trustee' && loggedInMemberRole !== 'official') {
      isMemberOnly = true;
    }
  }

  // ── DEBUG: Log what we found ──────────────────────────────────────
  console.log(`[group-accounts-schema] source=${foundInSource} phoneSent="${phone}" loginPhone="${loginPhone}" isMemberOnly=${isMemberOnly}`);
  console.log(`[group-accounts-schema] memberKeys: [${Object.keys(normalizedMembers).join(', ')}]`);
  for (const k in normalizedMembers) {
    const m = normalizedMembers[k];
    const mPhone = normalizeKenyanPhone(m.memberId || m.phone || m.phoneNumber || k);
    console.log(`  key=${k} memberId=${m.memberId} mPhone=${mPhone} role=${m.role||m.type||'member'} match=${mPhone === loginPhone}`);
  }
  if (isMemberOnly) {
    console.log(`[group-accounts-schema] Member-only response: memberKey=${loggedInMemberKey}`);
  }

  // Build accountSchema from actual member account data (first member has accounts)
  // Fall back to default schema if no members
  const defaultSchema = {
    "001": { accountId: "001", accountName: "Saving",       expectedAmount: "100" },
    "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
    "003": { accountId: "003", accountName: "latenes",      expectedAmount: "100" },
    "004": { accountId: "004", accountName: "welfare",      expectedAmount: "100" }
  };

  let accountSchema = defaultSchema;
  const memberKeys = Object.keys(normalizedMembers);
  if (memberKeys.length > 0) {
    // If member-only, use their own accounts to build schema; otherwise use first member
    const schemaSource = isMemberOnly && loggedInMemberKey ? normalizedMembers[loggedInMemberKey] : normalizedMembers[memberKeys[0]];
    const firstAccounts = schemaSource.accounts || {};
    const accIds = Object.keys(firstAccounts);
    if (accIds.length > 0) {
      accountSchema = {};
      for (const accId of accIds) {
        const acc = firstAccounts[accId];
        accountSchema[accId] = {
          accountId:      acc.accountId      || accId,
          accountName:    acc.accountName || accId,
          expectedAmount: acc.expectedAmount || "100"
        };
      }
    }
  }

  // Build per-account member list
  const accountDetails = {};
  for (const accId in accountSchema) {
    const schema = accountSchema[accId];
    let memberList = [];

    if (isMemberOnly && loggedInMemberKey) {
      // Member view: only show their own data
      const member = normalizedMembers[loggedInMemberKey];
      const acc = member.accounts && member.accounts[accId];
      const fins = (acc && acc.financials) || {
        openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0
      };
      memberList.push({
        memberId:       member.memberId || loggedInMemberKey,
        name:           member.name     || loggedInMemberKey,
        openingBalance: fins.openingBalance || 0,
        amountIn:       fins.amountIn       || 0,
        amountOut:      fins.amountOut      || 0,
        closingBalance: fins.closingBalance  || 0
      });
    } else {
      // Trustee/Official view: show all members
      for (const phoneKey in normalizedMembers) {
        const member = normalizedMembers[phoneKey];
        const acc = member.accounts && member.accounts[accId];
        const fins = (acc && acc.financials) || {
          openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0
        };
        memberList.push({
          memberId:       member.memberId || phoneKey,
          name:           member.name     || phoneKey,
          openingBalance: fins.openingBalance || 0,
          amountIn:       fins.amountIn       || 0,
          amountOut:      fins.amountOut      || 0,
          closingBalance: fins.closingBalance  || 0
        });
      }
    }

      accountDetails[accId] = {
      accountId:      schema.accountId,
      accountName:    schema.accountName,
      expectedAmount: schema.expectedAmount,
      members:        memberList,
      // Group-level totals (filtered if member-only)
      totalOpening: memberList.reduce((s, m) => s + Number(m.openingBalance || 0), 0),
      totalIn:  memberList.reduce((s, m) => s + Number(m.amountIn),       0),
      totalOut: memberList.reduce((s, m) => s + Number(m.amountOut),      0),
      totalBalance: memberList.reduce((s, m) => s + Number(m.closingBalance), 0)
    };
  }

  // ── Summary Stats (active round info) ──
  const constitutionCreated = foundGroup.constitutionKeyGeneratedAt || foundGroup.constitutionKeySetByAgentAt || foundGroup.createdAt || foundGroup.principlesSetAt || new Date().toISOString();
  const now = new Date();
  const created = new Date(constitutionCreated);
  const diffTime = Math.abs(now.getTime() - created.getTime());
  const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  const intervals = (foundGroup.principles && foundGroup.principles.intervals) ? foundGroup.principles.intervals : {};
  const endSavingPeriod = intervals.endSavingPeriod || '1-year';
  let totalRounds = 52;
  if (endSavingPeriod === '6-months') totalRounds = 26;
  else if (endSavingPeriod === '2-years') totalRounds = 104;
  else if (endSavingPeriod === '3-years') totalRounds = 156;
  else if (endSavingPeriod === '4-years') totalRounds = 208;
  else if (endSavingPeriod === '5-years') totalRounds = 260;
  const activeRound = Math.min(totalRounds, Math.ceil(diffDays / 7) || 1);
  const daysUntilMeeting = 7 - (diffDays % 7);
  const remainRounds = Math.max(0, totalRounds - activeRound);
  const summaryStats = {
    activeRound,
    daysUntilMeeting,
    totalMembers: isMemberOnly ? 1 : memberKeys.length,
    remainRounds,
    totalRounds
  };

  res.json({
    groupName:      foundGroup.groupName,
    groupNumber:    foundGroup.groupNumber,
    accountSchema,
    accountDetails,
    totalMembers:   isMemberOnly ? 1 : memberKeys.length,
    isMemberOnly,
    currentUser:    loggedInMemberKey ? normalizedMembers[loggedInMemberKey] : null,
    verifiedMember: loggedInMemberKey ? normalizedMembers[loggedInMemberKey] : null,
    loggedInMemberName,
    loggedInMemberRole: loggedInMemberRole || (isMemberOnly ? 'member' : 'official'),
    loggedInMemberTitle: loggedInMemberTitle || '',
    roleTitle: loggedInMemberTitle || '',
    loggedInMemberId: loggedInMemberKey ? (normalizedMembers[loggedInMemberKey].memberId || loggedInMemberKey) : null,
    summaryStats,
    source: foundInSource
  });
});

router.post("/verified-groups-members", async (req, res) => {
  try {
    const { groupName, accountNumber } = req.body;
    const phone = req.body.phone || req.session?.user?.phoneNumber;
    const clientVersion = Number(req.body.clientVersion) || 0;

    if (!groupName) {
      return res.status(400).json({ success: false, error: "groupName is required" });
    }
    if (!phone) {
      return res.status(401).json({ success: false, error: "Logged-in phone number is required" });
    }

    const cacheKey = `${String(groupName).trim().toLowerCase()}::${normalizeKenyanPhone(phone)}`;

    // ── Serve from server-side cache if valid & client version matches ─────────
    const cached = _getCachedGroup(cacheKey);
    if (cached && cached.dataVersion > 0 && cached.dataVersion === clientVersion) {
      console.log(`[verified-groups-members] Served from cache: ${cacheKey} v${cached.dataVersion}`);
      const cachedPayload = buildGroupAccountsPayloadFromGroupsMembers(cached.verified);
      cachedPayload.dataVersion = cached.dataVersion;
      cachedPayload.fromCache = true;
      return res.json(cachedPayload);
    }

    const verified = await findVerifiedGroupInGroupsMembers(groupName, phone);
    if (!verified) {
      return res.status(404).json({
        success: false,
        verified: false,
        error: "Group not found or logged-in phone is not a verified member in groups-members collection."
      });
    }

    // Store in server cache for 5 minutes
    _setCachedGroup(cacheKey, verified, verified.dataVersion || Date.now());

    const payload = buildGroupAccountsPayloadFromGroupsMembers(verified);
    payload.dataVersion = verified.dataVersion || global._groupVerifiedCache[cacheKey]?.dataVersion || 0;
    payload.fromCache = false;

    console.log(`[verified-groups-members] Verified ${phone} in ${payload.groupName} v${payload.dataVersion}`);
    res.json(payload);
  } catch (err) {
    console.error('[verified-groups-members] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Cache Invalidation Endpoint ────────────────────────────────────────────
// Called by the frontend after any successful transaction (M-Pesa, contribution,
// manual entry) to force the next load to fetch fresh data from MongoDB.
router.post("/invalidate-group-cache", (req, res) => {
  try {
    const { groupName } = req.body;
    const phone = req.body.phone || req.session?.user?.phoneNumber;
    if (!groupName) return res.json({ success: false, error: 'groupName required' });

    if (global._groupVerifiedCache) {
      if (phone) {
        // Invalidate for this specific user+group pair
        const cacheKey = `${String(groupName).trim().toLowerCase()}::${normalizeKenyanPhone(phone)}`;
        delete global._groupVerifiedCache[cacheKey];
        console.log(`[cache] Invalidated: ${cacheKey}`);
      } else {
        // Invalidate all entries for this group (any user)
        const groupKey = String(groupName).trim().toLowerCase();
        for (const key of Object.keys(global._groupVerifiedCache)) {
          if (key.startsWith(groupKey + '::')) {
            delete global._groupVerifiedCache[key];
          }
        }
        console.log(`[cache] Invalidated all entries for group: ${groupKey}`);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[invalidate-group-cache] Error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

router.post("/verify-group", (req, res) => {
  const { groupName } = req.body;

  let data = readJSON(memberFile, defaultMemberStructure());

  if (!data.groups || Object.keys(data.groups).length === 0) {
    return res.status(404).json({ error: "No groups in member.json" });
  }

  // Find group by groupName
  let foundKey = null;
  for (const key in data.groups) {
    if (data.groups[key].groupName && data.groups[key].groupName.trim() === groupName.trim()) {
      foundKey = key;
      break;
    }
  }

  const group = foundKey ? data.groups[foundKey] : null;

  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }

  res.json({
    groupNumber: group.groupNumber,
    groupName: group.groupName,
    members: group.members || {}
  });
});

router.post("/group-by-name", (req, res) => {
  const { groupName } = req.body;

  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || Object.keys(data.groups).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }

  // Find group by groupName
  let foundKey = null;
  let foundGroup = null;
  for (const key in data.groups) {
    if (data.groups[key].groupName && data.groups[key].groupName.trim() === groupName.trim()) {
      foundKey = key;
      foundGroup = data.groups[key];
      break;
    }
  }

  if (!foundGroup) {
    return res.status(404).json({ error: "Group not found" });
  }

  // Also fetch metadata from general.json
  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }
  const flattenData = (data) => {
    const result = {};
    for (const county in data) {
      const constis = data[county];
      for (const consti in constis) {
        const wards = constis[consti];
        for (const ward in wards) {
          const groups = wards[ward];
          for (const idx in groups) {
            const g = groups[idx];
            if (g.groupName) {
              result[g.groupName] = { ...g, _key: idx };
            }
          }
        }
      }
    }
    return result;
  };
  const allGroups = flattenData(accounts);
  const generalGroup = allGroups[groupName];

  // Merge metadata from general.json if available
  if (generalGroup) {
    if (generalGroup.principles) foundGroup.principles = generalGroup.principles;
    if (generalGroup.requests) foundGroup.requests = generalGroup.requests;
    if (generalGroup.accountNumber) foundGroup.accountNumber = generalGroup.accountNumber;
    if (generalGroup.phase) foundGroup.phase = generalGroup.phase;
    if (generalGroup.totalProposedMembers) foundGroup.totalProposedMembers = generalGroup.totalProposedMembers;
    if (generalGroup.createdAt) foundGroup.createdAt = generalGroup.createdAt;
    if (generalGroup.county) foundGroup.county = generalGroup.county;
    if (generalGroup.constituency) foundGroup.constituency = generalGroup.constituency;
    if (generalGroup.ward) foundGroup.ward = generalGroup.ward;
  }

  // Return group with merged data
  res.json(foundGroup);
});

// POST /verify-user - Verify user exists in data.json by phone and check group membership (from general.json)
router.post("/verify-user", (req, res) => {
  const { phone, groupName, requesterPhone } = req.body;
  
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }
  
  const usersData = readJSON(dataFile, []);
  const generalData = readJSON(generalFile, {});
  
  const sessionProcessorPhone = req.session?.user?.phoneNumber || "";
  const processorPhone = requesterPhone || sessionProcessorPhone;
  const targetNorm = normalizeKenyanPhone(phone);
  const targetVariants = phoneVariants(phone);
  const requesterNorm = normalizeKenyanPhone(processorPhone || "");

  if (requesterNorm && targetNorm && requesterNorm === targetNorm) {
    return res.json({
      success: false,
      verified: false,
      ownNumber: true,
      message: "You cannot request to add your own number."
    });
  }
  
  // Check if already in group via general.json (source of truth for group composition)
  let isGroupMember = false;
  let existingRole = null;
  let existingMemberIndex = null;
  
  if (generalData && Object.keys(generalData).length > 0) {
    // First preference: use processor/requester group to locate members content.
    const processorGroupRef = findGroupByMemberPhoneInGeneral(generalData, processorPhone || "");

    // Fallback: locate by provided groupName.
    let targetGroup = null;
    if (processorGroupRef && processorGroupRef.group) {
      if (groupName) {
        const normalizedRequestedGroup = String(groupName).trim().toLowerCase();
        const normalizedProcessorGroup = String(processorGroupRef.group.groupName || "").trim().toLowerCase();
        targetGroup = normalizedRequestedGroup === normalizedProcessorGroup ? processorGroupRef.group : null;
      } else {
        targetGroup = processorGroupRef.group;
      }
    } else if (groupName) {
      const byNameRef = findGroupInGeneral(generalData, String(groupName).trim());
      targetGroup = byNameRef ? byNameRef.group : null;
    }

    if (targetGroup) {
      const memberKeys = Object.keys(targetGroup).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );
      for (const key of memberKeys) {
        const item = targetGroup[key];
        if (item && item.phone && targetVariants.has(normalizeKenyanPhone(item.phone))) {
          isGroupMember = true;
          existingRole = item.role || item.type || key.replace(/_/g, ' ').replace(/\d+/, '').trim() || 'member';
          existingMemberIndex = memberKeys.indexOf(key) + 1;
          break;
        }
      }
    }
  }
  
  if (isGroupMember) {
    return res.json({
      success: false,
      verified: false,
      isGroupMember: true,
      role: existingRole,
      memberIndex: existingMemberIndex,
      message: `This phone number is already a ${existingRole} in this group (Index: ${existingMemberIndex}).`
    });
  }
  
  // Look up in data.json
  const user = usersData.find(u => {
    // data.json primary key is "phoneNumber"
    const uPhone = normalizeKenyanPhone(u.phoneNumber || u.phone || "");
    return targetVariants.has(uPhone);
  });
  
  if (!user) {
    // Fallback: lookup by "phone" entry in general.json
    if (generalData && Object.keys(generalData).length > 0) {
      for (const county in generalData) {
        const constis = generalData[county] || {};
        for (const consti in constis) {
          const wardArray = constis[consti];
          if (!Array.isArray(wardArray)) continue;
          for (const item of wardArray) {
            if (!item || typeof item !== "object" || !item.groupName) continue;
            const memberKeys = Object.keys(item).filter(k =>
              k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
            );
            for (const key of memberKeys) {
              const person = item[key];
              if (person && person.phone && targetVariants.has(normalizeKenyanPhone(person.phone))) {
                return res.json({
                  success: true,
                  verified: true,
                  isGroupMember: false,
                  phone: person.phone,
                  name: person.name || person.title || person.phone,
                  firstName: "",
                  lastName: "",
                  county: county || "",
                  constituency: consti || "",
                  ward: "",
                  source: "general.json"
                });
              }
            }
          }
        }
      }
    }

    return res.json({
      success: false, 
      verified: false, 
      isGroupMember: false,
      message: "Phone number not found in system."
    });
  }
  
  const fullName = `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.trim();
  
  res.json({
    success: true,
    verified: true,
    isGroupMember: false,
    phone: user.phoneNumber || user.phone || phone,
    name: fullName,
    firstName: user.FirstName,
    lastName: user.LastName,
    county: user.county,
    constituency: user.constituency,
    ward: user.ward
  });
});

 const accountTypeMap = {
  "savings": "001",
  "shares": "002",
  "loan": "003",
  "fines": "004",
  "Saving": "001",
  "Registration": "002",
  "latenes": "003",
  "welfare": "004"
};

router.post("/process-deduction", (req, res) => {
  const { groupName, deductions } = req.body;
  
  if (!deductions || !Array.isArray(deductions)) {
    return res.status(400).json({ error: "deductions array is required" });
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || Object.keys(data.groups).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  // Find group by groupName
  let foundKey = null;
  let foundGroup = null;
  for (const key in data.groups) {
    if (data.groups[key].groupName && data.groups[key].groupName.trim() === groupName.trim()) {
      foundKey = key;
      foundGroup = data.groups[key];
      break;
    }
  }
  
  const group = foundGroup;
  
  if (!group) {
    return res.status(404).json({ error: "Group not found: " + groupName });
  }
  
  // Calculate round based on constitution creation date
  const constitutionCreated = group.constitutionKeyGeneratedAt || group.constitutionKeySetByAgentAt || group.createdAt || new Date().toISOString();
  const now = new Date();
  const created = new Date(constitutionCreated);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // Store reference for updates
  const groupRef = data.groups[foundKey];
  
  let transactionCount = 0;
  
  deductions.forEach((ded, idx) => {
    const memberPhone = ded.memberPhone;
    const fromAccountNum = accountTypeMap[ded.memberAccount] || ded.memberAccount;
    const toAccountNum = accountTypeMap[ded.accountType] || ded.accountType;
    const amount = parseFloat(ded.amount);
    const processTime = ded.processTime || "now";
    
    let scheduledTime;
    let transactionState = "completed";
    
    if (processTime === "nextday") {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      scheduledTime = tomorrow.toISOString();
      transactionState = "scheduled";
    } else if (processTime === "nextround") {
      scheduledTime = "next_round";
      transactionState = "scheduled";
    } else {
      scheduledTime = new Date().toISOString();
    }
    
    // Create member if not exists
    if (!group.members[memberPhone]) {
      group.members[memberPhone] = {
        memberId: memberPhone,
        memberFinancials: {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0
        },
        accounts: {
          "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
        },
        processedDeductions: []
      };
    }
    
    const member = group.members[memberPhone];
    
    // Get existing totals
    const processedArr = member.processedDeductions || [];
    const existingTotal = processedArr.length > 0 ? (processedArr[processedArr.length - 1].totalDeductions || 0) : 0;
    const existingPending = processedArr.length > 0 ? (processedArr[processedArr.length - 1].totalPendingDeductions || 0) : 0;
    const newTotal = existingTotal + amount;
    const newPending = existingPending + amount;
    
    // Ensure source account exists
    if (!member.accounts[fromAccountNum]) {
      member.accounts[fromAccountNum] = {
        accountId: fromAccountNum,
        accountName: ded.memberAccount,
        expectedAmount: "100",
        financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 },
        transactionHistory: []
      };
    }
    
    // Add to transaction history
    const txnRecord = {
      time: scheduledTime,
      transactionId: "TXN" + Date.now() + idx,
      transactionNumber: idx + 1,
      type: "credit",
      targetAccount: toAccountNum,
      amount: amount,
      state: transactionState,
      description: "Deduction sent to " + ded.accountType
    };
    member.accounts[fromAccountNum].transactionHistory.push(txnRecord);
    
    // Update account financials
    member.accounts[fromAccountNum].financials.amountOut = (member.accounts[fromAccountNum].financials.amountOut || 0) + amount;
    member.accounts[fromAccountNum].financials.closingBalance = (member.accounts[fromAccountNum].financials.openingBalance || 0) + (member.accounts[fromAccountNum].financials.amountIn || 0) - (member.accounts[fromAccountNum].financials.amountOut || 0);
    
    // Add to processed deductions array
    if (!member.processedDeductions) {
      member.processedDeductions = [];
    }
    
    // Get round info
    const currentRound = Math.ceil(diffDays / 7) || 1;
    
    member.processedDeductions.push({
      time: scheduledTime,
      transactionId: "TXN" + Date.now() + idx,
      transactionNumber: idx + 1,
      type: "credit",
      targetAccount: toAccountNum,
      amount: amount,
      state: transactionState,
      description: "Deduction sent to " + ded.accountType,
      totalDeductions: newTotal,
      totalPendingDeductions: newPending,
      round: currentRound,
      createdAt: constitutionCreated
    });
    
    // Update member financials
    member.memberFinancials.amountOut = (member.memberFinancials.amountOut || 0) + amount;
    member.memberFinancials.closingBalance = (member.memberFinancials.openingBalance || 0) + (member.memberFinancials.amountIn || 0) - (member.memberFinancials.amountOut || 0);
    
    transactionCount++;
  });
  
  writeJSON(memberFile, data);
  submitMemberDataToMongo(data, 'deductions').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, message: `Processed ${transactionCount} deductions`, processed: transactionCount });
});

router.get("/contribution", async (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let foundGroup = null;
  let foundKey = null;
  const mongoResult = await findGroupForMemberRoutes(groupName);
  foundGroup = mongoResult.foundGroup;
  foundKey = mongoResult.foundKey;

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }

  // Get constitution creation date for round calculation
  const constitutionCreated = foundGroup.constitutionKeyGeneratedAt || foundGroup.constitutionKeySetByAgentAt || foundGroup.createdAt || new Date().toISOString();
  const now = new Date();
  const created = new Date(constitutionCreated);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // Get end saving period from principles
  const principles = foundGroup.principles || {};
  const intervals = principles.intervals || {};
  const endSavingPeriod = intervals.endSavingPeriod || '1-year';
  
  // Calculate total rounds based on period
  let totalRounds = 52;
  if (endSavingPeriod === '6-months') totalRounds = 26;
  else if (endSavingPeriod === '2-years') totalRounds = 104;
  else if (endSavingPeriod === '3-years') totalRounds = 156;
  else if (endSavingPeriod === '4-years') totalRounds = 208;
  else if (endSavingPeriod === '5-years') totalRounds = 260;
  
  const activeRound = Math.ceil(diffDays / 7) || 1;
  const daysUntilMeeting = 7 - (diffDays % 7);
  const remainRounds = Math.max(0, totalRounds - activeRound);
  
  const summaryStats = {
    activeRound: activeRound,
    daysUntilMeeting: daysUntilMeeting,
    totalMembers: foundGroup.members ? Object.keys(foundGroup.members).length : 0,
    remainRounds: remainRounds
  };
  
  // Determine member phone and index
  const sessionPhone = req.session.user?.phoneNumber;
  const targetPhone = queryPhone || sessionPhone;
  
  // Format phone number for display
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index - find the position in sorted member list
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members).sort();
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  // Get group number (from groupNumber field)
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  // Get member data directly from group
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/mcont", {
    group: foundGroup,
    user: req.session.user,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber,
    summaryStats: summaryStats,
    memberData: memberData
  });
});

router.get(["/loan", "/mloan"], async (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let foundGroup = null;
  let foundKey = null;
  const mongoResult = await findGroupForMemberRoutes(groupName);
  foundGroup = mongoResult.foundGroup;
  foundKey = mongoResult.foundKey;

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  const targetPhone = queryPhone || req.session?.user?.phoneNumber;
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index from member keys
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members);
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/mloan", {
    group: foundGroup,
    user: req.session.user,
    member: memberData,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber
  });
});

router.get("/membership", async (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let foundGroup = null;
  let foundKey = null;
  const mongoResult = await findGroupForMemberRoutes(groupName);
  foundGroup = mongoResult.foundGroup;
  foundKey = mongoResult.foundKey;

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }

  // Merge metadata from general.json if available
  let generalData = readJSON(generalFile, {});
  const flattenData = (data) => {
    const result = {};
    for (const county in data) {
      const constis = data[county];
      for (const consti in constis) {
        const wards = constis[consti];
        if (Array.isArray(wards)) {
          for (const item of wards) {
            if (item && item.groupName) {
              result[item.groupName] = item;
            }
          }
        } else {
          for (const ward in wards) {
            const groups = wards[ward];
            if (Array.isArray(groups)) {
              for (const item of groups) {
                if (item && item.groupName) {
                  result[item.groupName] = item;
                }
              }
            }
          }
        }
      }
    }
    return result;
  };
  const allGroups = flattenData(generalData);
  const generalGroup = allGroups[groupName];
  if (generalGroup) {
    if (generalGroup.totalProposedMembers !== undefined) foundGroup.totalProposedMembers = generalGroup.totalProposedMembers;
    if (generalGroup.principles) foundGroup.principles = generalGroup.principles;
    if (generalGroup.requests) foundGroup.requests = generalGroup.requests;
    if (generalGroup.accountNumber) foundGroup.accountNumber = generalGroup.accountNumber;
    if (generalGroup.phase) foundGroup.phase = generalGroup.phase;
    if (generalGroup.createdAt) foundGroup.createdAt = generalGroup.createdAt;
    if (generalGroup.county) foundGroup.county = generalGroup.county;
    if (generalGroup.constituency) foundGroup.constituency = generalGroup.constituency;
    if (generalGroup.ward) foundGroup.ward = generalGroup.ward;
  }
  
  const targetPhone = queryPhone || req.session?.user?.phoneNumber;
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index from member keys
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members);
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/membership", {
    group: foundGroup,
    user: req.session.user,
    member: memberData,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber
  });
});

// GET /gmember - Group membership management (for agents/officials)
router.get("/gmember", (req, res) => {
  const { groupName } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || Object.keys(data.groups).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }

  let foundGroup = null;
  for (const key in data.groups) {
    if (data.groups[key].groupName && data.groups[key].groupName.trim() === groupName.trim()) {
      foundGroup = data.groups[key];
      break;
    }
  }

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }

  // Fetch group and members from general.json (source of truth)
  let generalData = readJSON(generalFile, {});
  let totalProposedMembers = 0;
  let groupMembers = [];
  
  if (generalData && Object.keys(generalData).length > 0) {
    const groupRef = findGroupInGeneral(generalData, groupName);
    if (groupRef && groupRef.group) {
      // Use group from general.json as source of truth
      foundGroup = groupRef.group;
      
      // Get totalProposedMembers
      totalProposedMembers = foundGroup.totalProposedMembers || 0;
      
      // Build members list from general.json group members (trustee_*, official_*, member_*)
      const memberKeys = Object.keys(foundGroup).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );
      
      groupMembers = memberKeys.map(key => {
        const m = foundGroup[key];
        return {
          phone: m.phone || '',
          name: m.name || m.title || key,
          memberId: m.memberId || m.phone || key,
          role: m.role || m.type || key.split('_')[0],
          memberNumber: m.memberNumber || '',
          index: m.index || '',
          accounts: m.accounts || {},
          memberFinancials: m.memberFinancials || {}
        };
      });
      
      // Merge requests if exists
      if (!foundGroup.requests) {
        foundGroup.requests = {};
      }
    } else {
      if (!foundGroup) foundGroup = {};
      foundGroup.requests = {};
    }
  } else {
    if (!foundGroup) foundGroup = {};
    foundGroup.requests = {};
  }

  res.render("gaccount/gmember", {
    group: foundGroup,
    members: groupMembers,
    totalProposedMembers: totalProposedMembers,
    user: req.session.user
  });
});

router.get("/gloan", async (req, res) => {
  const { groupName } = req.query;
  
  if (!groupName) {
    return res.redirect("/");
  }

  const decodedGroupName = decodeURIComponent(String(groupName)).trim();
  const mockUser = req.session.user || { 
    name: "Mock User",
    memberName: "Mock User",
    phoneNumber: "254700000000"
  };

  let foundGroup = null;
  let generalGroup = null;

  // Prefer general Mongo groups (holds pendingApprovals)
  try {
    const mongoHit = await findGroupNameInMongoGroupsCollection(decodedGroupName);
    if (mongoHit && mongoHit.group) foundGroup = mongoHit.group;
  } catch (_) { /* ignore */ }

  try {
    const generalData = readJSON(generalFile, {});
    const groupRef = findGroupInGeneral(generalData, decodedGroupName);
    if (groupRef && groupRef.group) generalGroup = groupRef.group;
  } catch (_) { /* ignore */ }

  if (!foundGroup && generalGroup) foundGroup = generalGroup;

  if (!foundGroup) {
    try {
      const { foundGroup: memberGroup } = await findGroupForMemberRoutes(decodedGroupName);
      if (memberGroup) foundGroup = memberGroup;
    } catch (_) { /* ignore */ }
  }

  const pickLoanRequests = (group) =>
    (group &&
      group.pendingApprovals &&
      group.pendingApprovals.loan &&
      Array.isArray(group.pendingApprovals.loan.requestLoan) &&
      group.pendingApprovals.loan.requestLoan) ||
    [];

  // Prefer the source with more loan requests so UI stays in sync
  const mongoReqs = pickLoanRequests(foundGroup);
  const generalReqs = pickLoanRequests(generalGroup);
  const rawRequests =
    generalReqs.length > mongoReqs.length ? generalReqs : mongoReqs;
  if (generalReqs.length > mongoReqs.length && generalGroup) {
    foundGroup = generalGroup;
  }

  const fmtWhen = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (_) {
      return "—";
    }
  };

  const findPersonName = (group, phone) => {
    if (!group || !phone) return "";
    const target = normalizeKenyanPhone(phone);
    for (const key of Object.keys(group)) {
      if (!/^(trustee_|official_|member_)/.test(key)) continue;
      const person = group[key];
      if (!person || typeof person !== "object") continue;
      if (normalizeKenyanPhone(person.phone || person.phoneNumber || "") === target) {
        return person.name || person.memberId || phone;
      }
    }
    const members = group.members || {};
    for (const key of Object.keys(members)) {
      const m = members[key];
      if (!m || typeof m !== "object") continue;
      const candidates = [key, m.memberId, m.phone, m.phoneNumber];
      if (candidates.some((c) => c && normalizeKenyanPhone(c) === target)) {
        return m.name || m.memberId || key;
      }
    }
    return phone;
  };

  const pendingRequests = rawRequests.map((r) => {
    const amount = Number(r.amount || 0);
    const statusObj = r.status || {};
    const tc = statusObj.timeCompliance || {};
    const amountToBePaid = Number(
      tc.amountRequestedToBePaid != null ? tc.amountRequestedToBePaid : amount
    );
    const durationDays = Number(tc.durationDays || 0) || 0;
    const condition = statusObj.condition || "pending";
    const processorPhone = (r.processor && r.processor.phone) || "";
    const memberPhone = r.memberPhone || "";
    const memberName = findPersonName(foundGroup, memberPhone) || memberPhone || "Member";
    return {
      id: r.requestId || "",
      requestId: r.requestId || "",
      memberPhone,
      memberName,
      amount,
      status: condition,
      amountToBePaid,
      rolledBalance: Number(tc.rolledBalance || 0) || 0,
      durationDays,
      dueAt: tc.dueAt || "",
      dueAtLabel: fmtWhen(tc.dueAt),
      requestTime: r.requestTime || "",
      requestDate: fmtWhen(r.requestTime),
      processorPhone,
      processorName: findPersonName(foundGroup, processorPhone) || processorPhone || "—",
      approvalTime: (r.processor && r.processor.approvalTime) || "",
      totalInterest: Math.max(0, Math.round((amountToBePaid - amount) * 100) / 100),
      termMonths: durationDays > 0 ? Math.max(1, Math.round(durationDays / 30)) : 0,
      purpose: "Give Loan"
    };
  });

  // Newest first
  pendingRequests.sort((a, b) => {
    const ta = new Date(a.requestTime || 0).getTime();
    const tb = new Date(b.requestTime || 0).getTime();
    return tb - ta;
  });

  const pendingOnly = pendingRequests.filter(
    (r) => String(r.status || "pending").toLowerCase() === "pending"
  );
  const totalRequestedAmount = pendingOnly.reduce(
    (sum, r) => sum + (Number(r.amount) || 0),
    0
  );
  const totalLoanRequests = pendingOnly.length;
  const interestRate =
    (foundGroup &&
      foundGroup.principles &&
      ((foundGroup.principles.interestAndLimits &&
        foundGroup.principles.interestAndLimits.interestRate) ||
        (foundGroup.principles.loans &&
          foundGroup.principles.loans.interestAndLimits &&
          foundGroup.principles.loans.interestAndLimits.interestRate))) ||
    0;

  const groupClosing =
    (foundGroup &&
      foundGroup.groupFinancials &&
      (foundGroup.groupFinancials.totalClosingBalance != null
        ? foundGroup.groupFinancials.totalClosingBalance
        : foundGroup.groupFinancials.closingBalance)) ||
    0;

  res.render("gaccount/gloan", {
    group: {
      groupName: (foundGroup && foundGroup.groupName) || decodedGroupName,
      interestRate: Number(interestRate) || 0,
      maxLoanTerm: 12,
      penaltyRate: 2,
      groupFinancials: (foundGroup && foundGroup.groupFinancials) || {}
    },
    user: mockUser,
    loans: [],
    activeLoans: [],
    repaidLoans: [],
    totalLoans: totalLoanRequests,
    totalRequestedAmount,
    loanFund: Number(groupClosing) || 0,
    totalDisbursed: 0,
    totalRepaid: 0,
    availableBalance: Number(groupClosing) || 0,
    overdueLoans: [],
    rolledLoans: [],
    expiredLoans: [],
    pendingRequests,
    memberMaxLoan: 10000,
    memberSavings: 5000,
    memberOutstanding: 0,
    loanScore: "Excellent",
    initials: "MU",
    dueLoans: [],
    paidOnTimeCt: 0,
    activeCt: 0,
    paidLateCt: 0,
    rolledCt: 0,
    overdueCt: 0,
    expiredCt: 0,
    transactions: []
  });
});

router.get("/gcon", async (req, res) => {
  const { groupName } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let foundGroup = null;
  const mongoResult = await findGroupForMemberRoutes(groupName);
  foundGroup = mongoResult.foundGroup;

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  const membersCount = foundGroup.members ? Object.keys(foundGroup.members).length : 0;
  const activeRound = foundGroup.currentRound || 1;
  const meetingsHeld = foundGroup.meetings ? foundGroup.meetings.length : 0;
  const groupAccountNumber = foundGroup.accountNumber || 'Pending';
  const hasConstitution = foundGroup.pinIsSet || false;
  
  let totalSavings = 0;
  let totalShares = 0;
  let totalLoans = 0;
  let totalFines = 0;
  
  if (foundGroup.members) {
    for (const phone in foundGroup.members) {
      const member = foundGroup.members[phone];
      if (member.accounts) {
        for (const accId in member.accounts) {
          const acc = member.accounts[accId];
          const fin = acc.financials || {};
          if (accId.toLowerCase().includes('saving')) {
            totalSavings += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('share')) {
            totalShares += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('loan')) {
            totalLoans += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('fine')) {
            totalFines += fin.closingBalance || 0;
          }
        }
      }
    }
  }
  
  res.render("gaccount/gcon", {
    group: foundGroup,
    user: req.session.user,
    membersCount: membersCount,
    activeRound: activeRound,
    meetingsHeld: meetingsHeld,
    groupAccountNumber: groupAccountNumber,
    hasConstitution: hasConstitution,
    totalSavings: totalSavings,
    totalShares: totalShares,
    totalLoans: totalLoans,
    totalFines: totalFines
  });
});

// POST /add-member - Add a new member to a group
router.post("/add-member", (req, res) => {
  const { groupName, name, phone, role, initialSavings } = req.body;
  
  if (!groupName || !name || !phone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || Object.keys(data.groups).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  let foundKey = null;
  for (const key in data.groups) {
    if (data.groups[key].groupName && data.groups[key].groupName.trim() === groupName.trim()) {
      foundKey = key;
      break;
    }
  }
  
  if (!foundKey) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }
  
  const group = data.groups[foundKey];
  
  // Check if member already exists
  if (group.members && group.members[phone]) {
    return res.status(400).json({ success: false, error: "Member already exists" });
  }
  
  // Create new member structure
  const memberId = phone;
  const defaultAccounts = {
    "001": { 
      accountId: "001", 
      accountName: "Saving", 
      expectedAmount: "100", 
      financials: { openingBalance: initialSavings || 0, amountIn: initialSavings || 0, amountOut: 0, closingBalance: initialSavings || 0 }, 
      transactionHistory: initialSavings > 0 ? [{
        date: new Date().toISOString(),
        type: "deposit",
        amount: initialSavings,
        balance: initialSavings,
        note: "Initial savings"
      }] : []
    },
    "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "003": { accountId: "003", accountName: "Shares", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "004": { accountId: "004", accountName: "Welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
  };
  
  if (!group.members) group.members = {};
  
  group.members[phone] = {
    memberId: memberId,
    name: name,
    role: role || 'member',
    memberFinancials: {
      openingBalance: initialSavings || 0,
      amountIn: initialSavings || 0,
      amountOut: 0,
      closingBalance: initialSavings || 0
    },
    accounts: defaultAccounts,
    processedDeductions: [],
    createdAt: new Date().toISOString()
  };
  
  writeJSON(memberFile, data);

  submitMemberDataToMongo(data, 'add-member').catch(err => console.error('[Mongo] submit member failed:', err.message));
  res.json({ success: true, member: group.members[phone] });
});



// Helper to locate a group inside MongoDB 'groups' county documents & constituency arrays
const locateMongoGroup = async (groupName) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) return null;
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return null;
    const db = mongoose.connection.db;
    if (!db) return null;

    const col = db.collection("groups");
    const targetNorm = String(groupName || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (!targetNorm) return null;

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
            const gName = String(item.groupName || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            const gId = String(item.groupId || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            const gAcc = String(item.accountNumber || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            if (
              gName === targetNorm ||
              gId === targetNorm ||
              gAcc === targetNorm ||
              String(item.groupName || '').trim().toLowerCase() === String(groupName || '').trim().toLowerCase()
            ) {
              return {
                doc,
                constituencyKey: key,
                itemIndex: idx,
                group: item,
                col
              };
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[locateMongoGroup] Error:", err.message);
  }
  return null;
};

// POST /request-add-member - Submit a request to add a new member (updates MongoDB groups collection)
router.post("/request-add-member", async (req, res) => {
  const { groupName, requesterPhone, requesterName: reqName, requesterTitle: reqTitle, newMemberName, newMemberPhone, reason, idNumber, conformed } = req.body;

  if (!groupName || !newMemberPhone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  // 1. Verify candidate's phone against Personal Account collection
  let personalAcc = null;
  try {
    personalAcc = await findPersonalAccountByPhone(newMemberPhone);
  } catch (e) {
    console.error("[request-add-member] Personal account lookup error:", e.message);
  }

  // Local fallback if Mongo record syncing
  if (!personalAcc) {
    try {
      const pFile = path.join(__dirname, "../p_account/personal.json");
      if (fs.existsSync(pFile)) {
        const pData = JSON.parse(fs.readFileSync(pFile, 'utf8'));
        const pAccounts = pData.personalAccounts || {};
        const targetNorm = normalizeKenyanPhone(newMemberPhone);
        for (const k of Object.keys(pAccounts)) {
          if (normalizeKenyanPhone(k) === targetNorm || normalizeKenyanPhone(pAccounts[k].phone) === targetNorm) {
            personalAcc = pAccounts[k];
            break;
          }
        }
      }
    } catch (_) {}
  }

  const cleanGroupName = decodeURIComponent(groupName || '').replace(/%20/g, ' ').trim();

  if (!personalAcc) {
    return res.status(400).json({
      success: false,
      error: `The phone number entered is not registered with T-Bank Investment. Member should register a personal account to qualify to be added to group ${cleanGroupName}.`
    });
  }

  // 2. Locate target group in MongoDB groups collection
  const located = await locateMongoGroup(groupName);
  if (!located) {
    return res.status(404).json({ success: false, error: "Group not found in MongoDB groups collection" });
  }

  const { doc, constituencyKey, itemIndex, group, col } = located;

  // Check if member already exists in the group
  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  );
  let existingMember = memberKeys.find(key => {
    const person = group[key];
    return person && person.phone && normalizeKenyanPhone(person.phone) === normalizeKenyanPhone(newMemberPhone);
  });

  if (!existingMember && Array.isArray(group.members)) {
    existingMember = group.members.find(m => m && m.phone && normalizeKenyanPhone(m.phone) === normalizeKenyanPhone(newMemberPhone));
  } else if (!existingMember && group.members && typeof group.members === 'object') {
    existingMember = Object.values(group.members).find(m => m && (m.phone || m.memberId) && normalizeKenyanPhone(m.phone || m.memberId) === normalizeKenyanPhone(newMemberPhone));
  }

  if (existingMember) {
    return res.status(400).json({
      success: false,
      error: `Cannot process: the phone number ${newMemberPhone} is already a member within group ${cleanGroupName}.`
    });
  }

  const existingRequests = (group.requests && group.requests.addMember) || [];
  const existingRequest = existingRequests.find(r =>
    normalizeKenyanPhone(r.newMemberPhone) === normalizeKenyanPhone(newMemberPhone) && r.status === 'pending'
  );
  if (existingRequest) {
    return res.status(400).json({ success: false, error: "A pending request already exists for this phone number" });
  }

  // 3. Resolve processor (requester) details (name and title) from group
  let processorName = reqName || '';
  let processorTitle = reqTitle || '';
  for (const k of memberKeys) {
    const m = group[k];
    if (m && m.phone && normalizeKenyanPhone(m.phone) === normalizeKenyanPhone(requesterPhone)) {
      if (!processorName) processorName = m.name || '';
      if (!processorTitle) {
        processorTitle = m.title || (k.startsWith('trustee_') ? 'Chairperson' : (k.startsWith('official_') ? 'Official' : 'Member'));
      }
      break;
    }
  }

  if (!processorName && req.session?.user) {
    processorName = `${req.session.user.FirstName || ''} ${req.session.user.LastName || ''}`.trim();
  }
  if (!processorName) processorName = 'Processor';
  if (!processorTitle) processorTitle = 'Official';

  // 3. Extract verified member name from personal account ONLY (ignore client-provided names to prevent spoofing)
  const buildVerifiedName = (acc) => {
    if (!acc) return '';
    const n1 = acc.name || acc.fullName || '';
    if (n1) return n1;
    const fn = acc.FirstName || acc.firstName || acc.first_name || '';
    const mn = acc.MiddleName || acc.middleName || acc.SecondName || acc.secondName || '';
    const ln = acc.LastName || acc.lastName || acc.last_name || '';
    const combo = [fn, mn, ln].filter(Boolean).join(' ').trim();
    return combo;
  };
  const verifiedMemberName = buildVerifiedName(personalAcc);
  if (!verifiedMemberName) {
    return res.status(400).json({
      success: false,
      error: `No verified personal account name could be resolved for phone ${newMemberPhone}. Please ensure the member's Personal Account profile is complete.`
    });
  }
  const resolvedMemberName = verifiedMemberName;

  const newRequest = {
    id: Date.now().toString(),
    type: 'addMember',
    requesterPhone: requesterPhone || '',
    requesterName: processorName,
    requesterTitle: processorTitle,
    newMemberName: resolvedMemberName,
    newMemberPhone: newMemberPhone || '',
    idNumber: idNumber || personalAcc.idNumber || null,
    reason: reason || '',
    conformed: conformed === true || conformed === 'true',
    status: 'pending',
    createdAt: new Date().toISOString(),
    approverPhone: '',
    approverName: '',
    approvedAt: null
  };

  const fieldPrefix = `${constituencyKey}.${itemIndex}`;
  const now = new Date().toISOString();

  try {
    if (!group.requests || !Array.isArray(group.requests.addMember)) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            [`${fieldPrefix}.requests.addMember`]: [newRequest],
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    } else {
      await col.updateOne(
        { _id: doc._id },
        {
          $push: {
            [`${fieldPrefix}.requests.addMember`]: newRequest
          },
          $set: {
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    }
    const messageContent = `${processorName} (${requesterPhone}, ${processorTitle}) has processed a request to add member ${resolvedMemberName} (${newMemberPhone}).`;
    console.log(`[request-add-member] ${messageContent}`);
    return res.json({ success: true, request: newRequest, message: messageContent });
  } catch (err) {
    console.error("[request-add-member] MongoDB update error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to save request to database" });
  }
});

// POST /replace-official - Submit a request to replace an official (updates MongoDB groups collection)
router.post("/replace-official", async (req, res) => {
  const { groupName, requesterPhone, officialRole, currentOfficialName, currentOfficialPhone, newOfficialName, newOfficialPhone, newOfficialMemberNo, conformed } = req.body;

  if (!groupName || !officialRole || !newOfficialPhone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const located = await locateMongoGroup(groupName);
  if (!located) {
    return res.status(404).json({ success: false, error: "Group not found in MongoDB groups collection" });
  }

  const { doc, constituencyKey, itemIndex, group, col } = located;
  ensurePendingApprovals(group);

  const newRequest = {
    id: Date.now().toString(),
    type: 'replaceOfficial',
    requesterPhone: requesterPhone || '',
    officialRole: officialRole || '',
    currentOfficialName: currentOfficialName || '',
    currentOfficialPhone: currentOfficialPhone || '',
    newOfficialName: newOfficialName || '',
    newOfficialPhone: newOfficialPhone || '',
    newOfficialMemberNo: newOfficialMemberNo || '',
    conformed: conformed === true || conformed === 'true',
    status: 'pending',
    createdAt: new Date().toISOString(),
    approverPhone: '',
    approverName: '',
    approvedAt: null
  };

  const fieldPrefix = `${constituencyKey}.${itemIndex}`;
  const now = new Date().toISOString();

  try {
    const existingList = (group.pendingApprovals && group.pendingApprovals.member && group.pendingApprovals.member.replaceOfficial) || [];
    if (!Array.isArray(existingList)) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            [`${fieldPrefix}.pendingApprovals.member.replaceOfficial`]: [newRequest],
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    } else {
      await col.updateOne(
        { _id: doc._id },
        {
          $push: {
            [`${fieldPrefix}.pendingApprovals.member.replaceOfficial`]: newRequest
          },
          $set: {
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    }
    console.log(`[replace-official] Submitted replacement for '${officialRole}' in group '${groupName}' (Mongo groups)`);
    return res.json({ success: true, request: newRequest });
  } catch (err) {
    console.error("[replace-official] MongoDB update error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to save replacement request to database" });
  }
});

// POST /request-termination - Submit a request to terminate membership (updates MongoDB groups collection)
router.post("/request-termination", async (req, res) => {
  const { groupName, requesterPhone, conformed } = req.body;

  if (!groupName || !requesterPhone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const located = await locateMongoGroup(groupName);
  if (!located) {
    return res.status(404).json({ success: false, error: "Group not found in MongoDB groups collection" });
  }

  const { doc, constituencyKey, itemIndex, group, col } = located;
  ensurePendingApprovals(group);

  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  );
  let requesterName = '';
  for (const k of memberKeys) {
    if (group[k] && group[k].phone && normalizeKenyanPhone(group[k].phone) === normalizeKenyanPhone(requesterPhone)) {
      requesterName = group[k].name || '';
      break;
    }
  }

  const newRequest = {
    id: Date.now().toString(),
    type: 'requestTermination',
    requesterPhone: requesterPhone || '',
    requesterName: requesterName || '',
    conformed: conformed === true || conformed === 'true',
    status: 'pending',
    createdAt: new Date().toISOString(),
    approverPhone: '',
    approverName: '',
    approvedAt: null
  };

  const fieldPrefix = `${constituencyKey}.${itemIndex}`;
  const now = new Date().toISOString();

  try {
    const existingList = (group.pendingApprovals && group.pendingApprovals.member && group.pendingApprovals.member.requestTermination) || [];
    if (!Array.isArray(existingList)) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            [`${fieldPrefix}.pendingApprovals.member.requestTermination`]: [newRequest],
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    } else {
      await col.updateOne(
        { _id: doc._id },
        {
          $push: {
            [`${fieldPrefix}.pendingApprovals.member.requestTermination`]: newRequest
          },
          $set: {
            [`${fieldPrefix}.updatedAt`]: now
          }
        }
      );
    }
    console.log(`[request-termination] Submitted resignation for '${requesterPhone}' in group '${groupName}' (Mongo groups)`);
    return res.json({ success: true, request: newRequest });
  } catch (err) {
    console.error("[request-termination] MongoDB update error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to save termination request to database" });
  }
});

// GET /member-requests - Get pending requests for a group (reads from MongoDB groups collection)
router.get("/member-requests", async (req, res) => {
  const { groupName } = req.query;

  if (!groupName) {
    return res.status(400).json({ success: false, error: "groupName is required" });
  }

  const located = await locateMongoGroup(groupName);
  if (!located) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }

  const targetGroup = located.group;
  const requests = targetGroup.requests || {};
  const pendingApprovals = targetGroup.pendingApprovals || {};
  const memberPending = pendingApprovals.member || {};

  // Enrich addMember requests with requester's details from group membership
  const enrichedAddMemberRequests = (requests.addMember || [])
    .filter(r => r.status === 'pending')
    .map((request) => {
      const requesterPhone = request.requesterPhone;
      const memberKeys = Object.keys(targetGroup).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );
      
      let requesterName = request.requesterName || '';
      let requesterMemberIndex = '';
      let requesterMemberNumber = '';
      
      if (requesterPhone) {
        for (const key of memberKeys) {
          const member = targetGroup[key];
          if (member && member.phone && normalizeKenyanPhone(member.phone) === normalizeKenyanPhone(requesterPhone)) {
            requesterName = member.name || requesterName;
            requesterMemberIndex = member.index || '';
            requesterMemberNumber = member.memberNumber || '';
            break;
          }
        }
      }
      
      return {
        ...request,
        requesterName,
        requesterMemberIndex,
        requesterMemberNumber
      };
    });

  res.json({
    success: true,
    requests: {
      addMember: enrichedAddMemberRequests,
      replaceOfficial: (memberPending.replaceOfficial || []).filter(r => r.status === 'pending'),
      termination: (memberPending.requestTermination || requests.termination || []).filter(r => r.status === 'pending')
    }
  });
});

// POST /approve-member-request - Approve or reject member request (updates MongoDB groups collection)
router.post("/approve-member-request", async (req, res) => {
  const { groupName, requestId, action } = req.body;

  if (!groupName || !requestId) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const located = await locateMongoGroup(groupName);
  if (!located) {
    return res.status(404).json({ success: false, error: "Group not found in MongoDB groups collection" });
  }

  const { doc, constituencyKey, itemIndex, group: targetGroup, col } = located;

  if (!targetGroup.requests || !targetGroup.requests.addMember) {
    return res.status(404).json({ success: false, error: "No requests found" });
  }

  const requestIndex = targetGroup.requests.addMember.findIndex(r => r.id === requestId);
  if (requestIndex === -1) {
    return res.status(404).json({ success: false, error: "Request not found" });
  }

  const request = targetGroup.requests.addMember[requestIndex];

  // Authorization: Check if logged-in user is a trustee or official of this group
  const userPhone = req.session?.user?.phoneNumber;
  if (!userPhone) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }

  const isAuthorized = Object.keys(targetGroup).some(key => {
    if (key.startsWith('trustee_') || key.startsWith('official_')) {
      const member = targetGroup[key];
      return member && member.phone && normalizeKenyanPhone(member.phone) === normalizeKenyanPhone(userPhone);
    }
    return false;
  });

  if (!isAuthorized) {
    return res.status(403).json({ success: false, error: "Only trustees or officials can approve/reject member requests" });
  }

  const approverPhone = userPhone;
  let approverName = req.session?.user?.FirstName ? `${req.session.user.FirstName} ${req.session.user.LastName || ''}`.trim() : 'System User';

  const fieldPrefix = `${constituencyKey}.${itemIndex}`;
  const now = new Date().toISOString();
  const mongoSetFields = {};

  if (action === 'approve') {
    // Check if this member already exists in the group
    const allMemberKeys = Object.keys(targetGroup).filter(k =>
      k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
    );
    const existingMemberInGroup = allMemberKeys.find(key => {
      const person = targetGroup[key];
      return person && person.phone && normalizeKenyanPhone(person.phone) === normalizeKenyanPhone(request.newMemberPhone);
    });
    if (existingMemberInGroup) {
      return res.status(400).json({ success: false, error: "Member already exists in this group" });
    }

    const nextIndex = allMemberKeys.length + 1;
    const newMemberKey = `member_${nextIndex}`;

    const newMemberData = {
      phone: request.newMemberPhone,
      name: request.newMemberName,
      id: request.id || null,
      type: 'member',
      index: String(nextIndex),
      memberNumber: String(nextIndex).padStart(3, '0'),
      idNumber: request.idNumber || null
    };

    if (request.county) newMemberData.county = request.county;
    if (request.constituency) newMemberData.constituency = request.constituency;
    if (request.ward) newMemberData.ward = request.ward;

    request.status = 'approved';
    request.approvedAt = now;
    request.approverPhone = approverPhone;
    request.approverName = approverName;

    mongoSetFields[`${fieldPrefix}.${newMemberKey}`] = newMemberData;
    mongoSetFields[`${fieldPrefix}.requests.addMember.${requestIndex}`] = request;
    mongoSetFields[`${fieldPrefix}.updatedAt`] = now;

    // Financial tracking in member.json
    try {
      const memberFile = path.join(__dirname, "../tran_account/member.json");
      let memberData = readJSON(memberFile, { groups: {} });
      if (!memberData.groups) memberData.groups = {};

      let memberGroupKey = Object.keys(memberData.groups).find(k => memberData.groups[k].groupName && memberData.groups[k].groupName.trim() === groupName.trim());
      if (!memberGroupKey) {
        const groupNum = Object.keys(memberData.groups).length + 1;
        memberGroupKey = "ACC" + groupNum;
        memberData.groups[memberGroupKey] = {
          groupName: groupName,
          accountNumber: targetGroup.accountNumber || "254" + Date.now(),
          members: {}
        };
      }

      if (!memberData.groups[memberGroupKey].members) {
        memberData.groups[memberGroupKey].members = {};
      }

      memberData.groups[memberGroupKey].members[request.newMemberPhone] = {
        memberId: request.newMemberPhone,
        accountNumber: memberData.groups[memberGroupKey].accountNumber,
        memberFinancials: {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0
        },
        accounts: {},
        processedDeductions: [],
        createdAt: now
      };

      writeJSON(memberFile, memberData);
    } catch (finErr) {
      console.error("[approve-member-request] member.json update notice:", finErr.message);
    }
  } else {
    // Reject
    request.status = 'rejected';
    request.rejectedAt = now;
    request.approverPhone = approverPhone;
    request.approverName = approverName;

    mongoSetFields[`${fieldPrefix}.requests.addMember.${requestIndex}`] = request;
    mongoSetFields[`${fieldPrefix}.updatedAt`] = now;
  }

  try {
    await col.updateOne({ _id: doc._id }, { $set: mongoSetFields });
    console.log(`[approve-member-request] Successfully updated group '${groupName}' in Mongo groups (${action})`);
    
    // Return updated requests
    const updatedAddMember = (targetGroup.requests.addMember || []).filter(r => r.status === 'pending');
    res.json({
      success: true,
      request,
      requests: {
        addMember: updatedAddMember
      }
    });
  } catch (dbErr) {
    console.error("[approve-member-request] Mongo update error:", dbErr.message);
    res.status(500).json({ success: false, error: "Database update failed" });
  }
});

// GET /member/get-by-phone - Get member details by phone number from data.json
router.get("/get-by-phone", (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }

  const dataFile = path.join(__dirname, "../data.json");
  const users = readJSON(dataFile, []);

  // Normalize the phone number for comparison
  const normalizeKenyanPhone = (p = "") => {
    let digits = String(p).replace(/\D/g, "");
    if (digits.startsWith("254")) digits = digits.substring(3);
    if (digits.startsWith("0")) digits = digits.substring(1);
    if (digits.length > 9) digits = digits.slice(-9);
    return digits;
  };

  const normalizedPhone = normalizeKenyanPhone(phone);
  const user = users.find(u => normalizeKenyanPhone(u.phoneNumber) === normalizedPhone);

  if (!user) {
    return res.json({ success: false, member: null });
  }

  const memberName = `${user.FirstName} ${user.MiddleName || ''} ${user.LastName}`.replace(/\s+/g, ' ').trim();
  return res.json({ 
    success: true, 
    member: { 
      name: memberName,
      idNumber: user.idNumber || ""
    } 
  });
});

// GET /member/region-transaction - Get region-level transaction data
router.get("/region-transaction", async (req, res) => {
  try {
    const regionTxn = await getRegionTransaction();
    res.json({ success: true, regionTransaction: regionTxn });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /member/region-transaction - Update region-level transaction data
router.post("/region-transaction", async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  
  const { openingBalance, amountIn, amountOut, closingBalance } = req.body;
  
  const regionTxn = {
    openingBalance: Number(openingBalance) || 0,
    amountIn: Number(amountIn) || 0,
    amountOut: Number(amountOut) || 0,
    closingBalance: Number(closingBalance) || 0
  };
  
  try {
    const ready = await ensureMongoReady();
    if (ready) {
      const mongoose = require('mongoose');
      const col = mongoose.connection.db.collection('groups-members');
      await col.updateOne(
        { _id: 'regionTransaction' },
        { 
          $set: { 
            county: 'Region',
            countyId: 'region',
            regionTransaction: regionTxn, 
            syncedAt: new Date().toISOString() 
          } 
        },
        { upsert: true }
      );
    }
    
    res.json({ success: true, regionTransaction: regionTxn });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /member/regions - Get all regions data (for admin/dashboard) - preserves full nested structure
router.get("/regions", async (req, res) => {
  try {
    const ready = await ensureMongoReady();
    if (ready) {
      const mongoose = require('mongoose');
      const col = mongoose.connection.db.collection('groups-members');
      const docs = await col.find({ countyId: { $ne: 'region' }, _id: { $ne: 'regionTransaction' } }).toArray();
      const regions = {};
      for (const doc of docs) {
        if (!doc.county) continue;
        regions[doc.county] = {
          county: doc.county,
          countyId: doc.countyId || doc.county,
          countryTransaction: doc.countryTransaction || { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0, transactions: [] },
          constituencies: doc.constituencies || [],
          syncedAt: doc.syncedAt
        };
      }
      const regDoc = await col.findOne({ _id: 'regionTransaction' });
      if (regDoc && regDoc.regionTransaction) {
        regions.regionTransaction = regDoc.regionTransaction;
      }
      return res.json({ success: true, regions });
    }
  } catch (e) {
    console.error('[regions] MongoDB read error:', e.message);
  }
  
  res.json({ success: true, regions: {} });
});

// GET /member/group-by-location - Get group by county/constituency/ward - uses nested constituencies/wards structure
router.get("/group-by-location", async (req, res) => {
  const { county, constituency, ward } = req.query;
  
  // Try MongoDB first
  try {
    const ready = await ensureMongoReady();
    if (ready) {
      const mongoose = require('mongoose');
      const col = mongoose.connection.db.collection('groups-members');
      const query = {};
      if (county) query.county = county;
      const doc = await col.findOne(query);
      
      if (doc && doc.constituencies) {
        let constituencies = doc.constituencies;
        let groups = [];
        
        // Navigate nested structure
        constituencies.forEach(cons => {
          if (constituency && cons.name !== constituency) return;
          
          (cons.wards || []).forEach(w => {
            if (ward && w.name !== ward) return;
            (w.data || []).forEach(g => {
              groups.push(g);
            });
          });
        });
        
        return res.json({ success: true, county: doc.county, constituency, ward, groups });
      }
    }
  } catch (e) {
    console.error('[group-by-location] MongoDB read error:', e.message);
  }
  
  // Fallback to JSON
  const memberData = readJSON(memberRegionsFile, { regions: {} });
  const regions = memberData.regions || {};
  
  const countyDoc = Object.values(regions).find(r => r.county === county);
  if (!countyDoc) {
    return res.json({ success: true, county, groups: [] });
  }
  
  // Navigate the nested structure from JSON
  let groups = [];
  if (constituency && countyDoc.constituencies) {
    const cons = countyDoc.constituencies.find(c => c.name === constituency);
    if (cons && ward && cons.wards) {
      const wardDoc = cons.wards.find(w => w.name === ward);
      if (wardDoc) groups = wardDoc.data || [];
    } else if (cons) {
      cons.wards?.forEach(w => { groups.push(...(w.data || [])); });
    }
  } else {
    // Get all groups from county
    countyDoc.constituencies?.forEach(cons => {
      cons.wards?.forEach(w => {
        groups.push(...(w.data || []));
      });
    });
  }
  
  res.json({ success: true, county, constituency, ward, groups });
});

// GET /member/region-summary - Get region-level transaction summary
router.get("/region-summary", async (req, res) => {
  const regionTxn = await getRegionTransaction();
  res.json({ success: true, regionTransaction: regionTxn });
});

// POST /member/verify-give-loan
// Verify phone is a group member, waiting period passed, savings target met, amount within limit.
router.post("/verify-give-loan", async (req, res) => {
  try {
    const groupName = String(req.body.groupName || "").trim();
    const phoneRaw = String(req.body.phone || "").trim();
    const amount = Number(req.body.amount);

    if (!groupName) {
      return res.json({ success: false, message: "Group name is required." });
    }
    if (!phoneRaw) {
      return res.json({ success: false, message: "Member phone number is required." });
    }
    if (!amount || amount <= 0) {
      return res.json({ success: false, message: "Enter a valid loan amount." });
    }

    const targetPhone = normalizeKenyanPhone(phoneRaw);
    if (!targetPhone || targetPhone.length < 9) {
      return res.json({ success: false, message: "Enter a valid member phone number." });
    }

    // Resolve group (same sources as group-accounts-schema)
    let foundGroup = null;
    let foundInSource = null;

    const jsonFound = findGroupInMemberJson(groupName);
    if (jsonFound) {
      foundGroup = jsonFound.group;
      foundInSource = "member.json";
    }

    if (!foundGroup) {
      try {
        foundGroup = await getMemberGroupFromMongo(groupName);
        if (foundGroup) foundInSource = "MemberGroup";
      } catch (_) { /* ignore */ }
    }

    if (!foundGroup) {
      try {
        const regionalFound = await findGroupInGroupsMembersCollection(groupName);
        if (regionalFound) {
          foundGroup = regionalFound.group;
          foundInSource = "groups-members";
        }
      } catch (_) { /* ignore */ }
    }

    if (!foundGroup) {
      try {
        const mongoHit = await findGroupNameInGroupsMembersCollection(groupName);
        if (mongoHit && mongoHit.group) {
          foundGroup = mongoHit.group;
          foundInSource = "groups-members";
        }
      } catch (_) { /* ignore */ }
    }

    if (!foundGroup) {
      return res.json({ success: false, message: `Group "${groupName}" was not found.` });
    }

    const members = foundGroup.members || {};
    let memberKey = null;
    let member = null;

    for (const key of Object.keys(members)) {
      const m = members[key];
      if (!m || typeof m !== "object") continue;
      const candidates = [
        key,
        m.memberId,
        m.phone,
        m.phoneNumber
      ];
      for (const c of candidates) {
        if (c && normalizeKenyanPhone(c) === targetPhone) {
          memberKey = key;
          member = m;
          break;
        }
      }
      if (member) break;
    }

    // Also support legacy trustee_/official_/member_ keys
    if (!member) {
      for (const key of Object.keys(foundGroup)) {
        if (!/^(trustee_|official_|member_)/.test(key)) continue;
        const m = foundGroup[key];
        if (!m || typeof m !== "object") continue;
        const p = normalizeKenyanPhone(m.phone || m.memberId || m.phoneNumber || "");
        if (p === targetPhone) {
          memberKey = key;
          member = m;
          break;
        }
      }
    }

    if (!member) {
      return res.json({
        success: false,
        verified: false,
        message: "Phone number is not a registered member of this group."
      });
    }

    const loans = (foundGroup.principles && foundGroup.principles.loans) ? foundGroup.principles.loans : {};
    const limits = loans.interestAndLimits || {};
    const waitingMonths = Number(loans.waitingDays || 0);
    const savingTarget = Number(loans.savingTarget || 0);
    const limitMultiplier = Number(limits.limitMultiplier || 1) || 1;

    // Waiting period: waitingDays treated as months from principles/constitution start
    const startRaw = foundGroup.principlesSetAt || foundGroup.createdAt || foundGroup.constitutionKeyGeneratedAt || null;
    if (waitingMonths > 0 && startRaw) {
      const start = new Date(startRaw);
      if (!Number.isNaN(start.getTime())) {
        const now = new Date();
        const monthsElapsed =
          (now.getFullYear() - start.getFullYear()) * 12 +
          (now.getMonth() - start.getMonth()) -
          (now.getDate() < start.getDate() ? 1 : 0);
        if (monthsElapsed < waitingMonths) {
          return res.json({
            success: false,
            verified: true,
            waitingPeriodMet: false,
            message: `Waiting period not met. Member must wait ${waitingMonths} month(s) from group start (${monthsElapsed < 0 ? 0 : monthsElapsed} elapsed).`
          });
        }
      }
    }

    // Member savings (prefer Saving account 001, then memberFinancials)
    const savingsAcc =
      (member.accounts && (member.accounts["001"] || member.accounts["1"])) || null;
    const savingsFins = (savingsAcc && savingsAcc.financials) || {};
    const memberFins = member.memberFinancials || {};
    const closingBal = Number(
      savingsFins.closingBalance != null ? savingsFins.closingBalance :
      memberFins.closingBalance != null ? memberFins.closingBalance : 0
    );
    const openingBal = Number(
      savingsFins.openingBalance != null ? savingsFins.openingBalance :
      memberFins.openingBalance != null ? memberFins.openingBalance : 0
    );
    const memberSavings = Math.max(closingBal, openingBal, 0);

    // Saving target: empty/0 = compliant; else balance must be >= target
    if (savingTarget > 0 && memberSavings < savingTarget) {
      return res.json({
        success: false,
        verified: true,
        waitingPeriodMet: true,
        savingTargetMet: false,
        memberSavings,
        savingTarget,
        message: `Savings target not met. Required KES ${savingTarget.toLocaleString()}, member has KES ${memberSavings.toLocaleString()}.`
      });
    }

    // Group closing balance — amount × limitMultiplier must be less than this
    const gf = foundGroup.groupFinancials || {};
    const groupClosingBalance = Number(
      gf.totalClosingBalance != null ? gf.totalClosingBalance :
      gf.closingBalance != null ? gf.closingBalance :
      gf.availableWithdrawalBalance != null ? gf.availableWithdrawalBalance : 0
    );
    const amountCover = amount * limitMultiplier;
    const maxLoan = limitMultiplier > 0
      ? Math.max(0, Math.floor((groupClosingBalance - 1) / limitMultiplier))
      : 0;

    if (!(groupClosingBalance > 0) || !(amountCover < groupClosingBalance)) {
      return res.json({
        success: false,
        verified: true,
        waitingPeriodMet: true,
        savingTargetMet: true,
        memberSavings,
        limitMultiplier,
        groupClosingBalance,
        amountCover,
        maxLoan,
        message: `Loan cover (amount × ${limitMultiplier} = KES ${amountCover.toLocaleString()}) must be less than group closing balance (KES ${groupClosingBalance.toLocaleString()}). Max amount: KES ${maxLoan.toLocaleString()}.`
      });
    }

    const interestAndLimits =
      (foundGroup.principles && foundGroup.principles.interestAndLimits) ||
      limits ||
      {};

    const repaymentFromLoans = loans.repayment && loans.repayment.durationDays;
    const repaymentFromTop =
      foundGroup.principles &&
      foundGroup.principles.repayment &&
      foundGroup.principles.repayment.durationDays;
    const repaymentDays = Number(
      repaymentFromLoans != null && repaymentFromLoans !== ""
        ? repaymentFromLoans
        : repaymentFromTop != null && repaymentFromTop !== ""
          ? repaymentFromTop
          : 0
    ) || 0;

    const interestRate = Number(
      interestAndLimits.interestRate != null
        ? interestAndLimits.interestRate
        : limits.interestRate || 0
    ) || 0;
    const interestAmount = Math.round(amount * (interestRate / 100) * 100) / 100;
    const amountRequestedToBePaid = Math.round(amount * (1 + interestRate / 100) * 100) / 100;

    return res.json({
      success: true,
      verified: true,
      waitingPeriodMet: true,
      savingTargetMet: true,
      amountWithinLimit: true,
      groupName: foundGroup.groupName || groupName,
      member: {
        memberId: member.memberId || memberKey,
        name: member.name || member.memberId || memberKey,
        phone: member.memberId || memberKey,
        savings: memberSavings,
        openingBalance: openingBal,
        closingBalance: closingBal
      },
      loanPolicy: {
        waitingMonths,
        savingTarget,
        limitMultiplier,
        interestRate,
        interestAmount,
        amountRequestedToBePaid,
        repaymentDays,
        maxActiveLoans: Number(
          interestAndLimits.maxActiveLoans != null
            ? interestAndLimits.maxActiveLoans
            : limits.maxActiveLoans || 1
        ),
        groupClosingBalance,
        amountCover,
        maxLoan,
        amount
      },
      source: foundInSource
    });
  } catch (err) {
    console.error("[verify-give-loan]", err);
    return res.status(500).json({ success: false, message: "Could not verify loan eligibility. Try again." });
  }
});

function ensurePendingApprovals(group) {
  if (!group.pendingApprovals || typeof group.pendingApprovals !== "object") {
    group.pendingApprovals = {};
  }
  if (!group.pendingApprovals.member || typeof group.pendingApprovals.member !== "object") {
    group.pendingApprovals.member = {};
  }
  if (!Array.isArray(group.pendingApprovals.member.requestTermination)) {
    group.pendingApprovals.member.requestTermination = [];
  }
  if (!Array.isArray(group.pendingApprovals.member.replaceOfficial)) {
    group.pendingApprovals.member.replaceOfficial = [];
  }
  if (!group.pendingApprovals.loan || typeof group.pendingApprovals.loan !== "object") {
    group.pendingApprovals.loan = {};
  }
  if (!Array.isArray(group.pendingApprovals.loan.requestLoan)) {
    group.pendingApprovals.loan.requestLoan = [];
  }
  return group;
}

function getGroupInterestRate(group) {
  const p = group && group.principles ? group.principles : {};
  const fromTop = p.interestAndLimits && p.interestAndLimits.interestRate;
  const fromLoans =
    p.loans && p.loans.interestAndLimits && p.loans.interestAndLimits.interestRate;
  const rate = Number(fromTop != null ? fromTop : fromLoans != null ? fromLoans : 0);
  return Number.isFinite(rate) ? rate : 0;
}

function getGroupRepaymentDurationDays(group) {
  const p = group && group.principles ? group.principles : {};
  const fromLoans = p.loans && p.loans.repayment && p.loans.repayment.durationDays;
  const fromTop = p.repayment && p.repayment.durationDays;
  const days = Number(fromLoans != null && fromLoans !== "" ? fromLoans : fromTop != null ? fromTop : 0);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function calculateLoanDueAt(requestTimeIso, durationDays) {
  const base = new Date(requestTimeIso || Date.now());
  if (Number.isNaN(base.getTime())) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + (Number(durationDays) || 0));
    return fallback.toISOString();
  }
  const due = new Date(base.getTime());
  due.setDate(due.getDate() + (Number(durationDays) || 0));
  return due.toISOString();
}

function buildLoanRequestId(existingRequests) {
  const next = (Array.isArray(existingRequests) ? existingRequests.length : 0) + 1;
  return "req_loan_" + String(next).padStart(3, "0");
}

function appendGiveLoanRequestToGroup(group, { memberPhone, amount, processorPhone, requestTime }) {
  ensurePendingApprovals(group);
  const list = group.pendingApprovals.loan.requestLoan;
  const interestRate = getGroupInterestRate(group);
  const durationDays = getGroupRepaymentDurationDays(group);
  const principal = Number(amount);
  const amountRequestedToBePaid = Math.round(principal * (1 + interestRate / 100) * 100) / 100;
  const stampedRequestTime = requestTime || new Date().toISOString();
  const dueAt = calculateLoanDueAt(stampedRequestTime, durationDays);

  const loanRequest = {
    requestId: buildLoanRequestId(list),
    memberPhone,
    amount: principal,
    requestTime: stampedRequestTime,
    status: {
      condition: "pending",
      amount: principal,
      timeCompliance: {
        amountRequestedToBePaid,
        rolledBalance: 0,
        durationDays,
        dueAt
      }
    },
    processor: {
      phone: processorPhone || "",
      approvalTime: ""
    }
  };

  list.push(loanRequest);
  group.updatedAt = new Date().toISOString();
  return loanRequest;
}

// POST /member/request-give-loan
// After verify: append pendingApprovals.loan.requestLoan without wiping other group data.
router.post("/request-give-loan", async (req, res) => {
  try {
    const groupName = String(req.body.groupName || "").trim();
    const memberPhoneRaw = String(req.body.memberPhone || req.body.phone || "").trim();
    const processorPhoneRaw = String(req.body.processorPhone || req.body.loggerPhone || "").trim();
    const amount = Number(req.body.amount);

    if (!groupName) {
      return res.json({ success: false, message: "Group name is required." });
    }
    if (!memberPhoneRaw) {
      return res.json({ success: false, message: "Member phone number is required." });
    }
    if (!amount || amount <= 0) {
      return res.json({ success: false, message: "Enter a valid loan amount." });
    }

    const memberPhone = normalizeKenyanPhone(memberPhoneRaw);
    const processorPhone = normalizeKenyanPhone(processorPhoneRaw);
    if (!memberPhone || memberPhone.length < 9) {
      return res.json({ success: false, message: "Enter a valid member phone number." });
    }
    if (processorPhone && normalizeKenyanPhone(memberPhone) === processorPhone) {
      return res.json({ success: false, message: "You cannot disburse a loan to yourself." });
    }

    const requestTime = new Date().toISOString();
    let loanRequest = null;
    let savedTo = [];

    // 1) Path-scoped update on general.json (additive only)
    try {
      const generalData = readJSON(generalFile, {});
      const groupRef = findGroupInGeneral(generalData, groupName);
      if (groupRef && groupRef.group) {
        loanRequest = appendGiveLoanRequestToGroup(groupRef.group, {
          memberPhone,
          amount,
          processorPhone,
          requestTime
        });
        writeJSON(generalFile, generalData);
        savedTo.push("general.json");
      }
    } catch (e) {
      console.error("[request-give-loan] general.json update failed:", e.message);
    }

    // 2) Path-scoped update on Mongo groups collection
    try {
      const mongoHit = await findGroupNameInMongoGroupsCollection(groupName);
      if (mongoHit && mongoHit.group) {
        const group = { ...mongoHit.group };
        // Preserve any pendingApprovals already on Mongo if general.json was missing
        if (!loanRequest) {
          loanRequest = appendGiveLoanRequestToGroup(group, {
            memberPhone,
            amount,
            processorPhone,
            requestTime
          });
        } else {
          // Mirror the same request object into Mongo without rebuilding id
          ensurePendingApprovals(group);
          const already = group.pendingApprovals.loan.requestLoan.find(
            (r) => r && r.requestId === loanRequest.requestId
          );
          if (!already) {
            group.pendingApprovals.loan.requestLoan.push({ ...loanRequest });
            group.updatedAt = requestTime;
          }
        }

        await saveGeneralGroupToMongo({
          ...group,
          county: mongoHit.county || group.county,
          constituency: mongoHit.constituency || group.constituency,
          ward: mongoHit.ward || group.ward
        });
        savedTo.push("mongo.groups");
      }
    } catch (e) {
      console.error("[request-give-loan] mongo update failed:", e.message);
    }

    if (!loanRequest) {
      return res.status(404).json({
        success: false,
        message: `Group "${groupName}" was not found.`
      });
    }

    return res.json({
      success: true,
      message: "Loan request submitted and pending approval.",
      request: loanRequest,
      savedTo
    });
  } catch (err) {
    console.error("[request-give-loan]", err);
    return res.status(500).json({
      success: false,
      message: "Could not submit loan request. Try again."
    });
  }
});

// GET /member/my-loan-requests — loan requests for a member in a group
router.get("/my-loan-requests", async (req, res) => {
  try {
    const groupName = decodeURIComponent(String(req.query.groupName || "").trim());
    const phoneRaw = String(req.query.phone || req.query.memberPhone || "").trim();
    if (!groupName) {
      return res.json({ success: false, message: "groupName is required.", requests: [] });
    }

    const targetPhone = phoneRaw ? normalizeKenyanPhone(phoneRaw) : "";
    let foundGroup = null;
    let generalGroup = null;

    try {
      const mongoHit = await findGroupNameInMongoGroupsCollection(groupName);
      if (mongoHit && mongoHit.group) foundGroup = mongoHit.group;
    } catch (_) { /* ignore */ }

    try {
      const generalData = readJSON(generalFile, {});
      const groupRef = findGroupInGeneral(generalData, groupName);
      if (groupRef && groupRef.group) generalGroup = groupRef.group;
    } catch (_) { /* ignore */ }

    if (!foundGroup && generalGroup) foundGroup = generalGroup;

    const pick = (g) =>
      (g &&
        g.pendingApprovals &&
        g.pendingApprovals.loan &&
        Array.isArray(g.pendingApprovals.loan.requestLoan) &&
        g.pendingApprovals.loan.requestLoan) ||
      [];

    const mongoReqs = pick(foundGroup);
    const generalReqs = pick(generalGroup);
    const raw =
      generalReqs.length > mongoReqs.length ? generalReqs : mongoReqs;
    if (generalReqs.length > mongoReqs.length && generalGroup) foundGroup = generalGroup;

    const now = Date.now();
    const fmtWhen = (iso) => {
      if (!iso) return "—";
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "—";
        return d.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
      } catch (_) {
        return "—";
      }
    };

    const requests = raw
      .filter((r) => {
        if (!targetPhone) return true;
        return normalizeKenyanPhone(r.memberPhone || "") === targetPhone;
      })
      .map((r) => {
        const statusObj = r.status || {};
        const tc = statusObj.timeCompliance || {};
        let condition = String(statusObj.condition || "pending").toLowerCase();
        if (condition === "approved") condition = "active";
        const dueMs = tc.dueAt ? new Date(tc.dueAt).getTime() : NaN;
        if (
          !Number.isNaN(dueMs) &&
          dueMs < now &&
          (condition === "pending" || condition === "active")
        ) {
          condition = "expired";
        }
        const amount = Number(r.amount || 0);
        const amountToBePaid = Number(
          tc.amountRequestedToBePaid != null ? tc.amountRequestedToBePaid : amount
        );
        return {
          requestId: r.requestId || "",
          memberPhone: r.memberPhone || "",
          amount,
          amountToBePaid,
          status: condition,
          requestTime: r.requestTime || "",
          requestTimeLabel: fmtWhen(r.requestTime),
          dueAt: tc.dueAt || "",
          dueAtLabel: fmtWhen(tc.dueAt),
          durationDays: Number(tc.durationDays || 0) || 0,
          rolledBalance: Number(tc.rolledBalance || 0) || 0,
          processorPhone: (r.processor && r.processor.phone) || "",
          approvalTime: (r.processor && r.processor.approvalTime) || "",
          approvalTimeLabel: fmtWhen(r.processor && r.processor.approvalTime)
        };
      })
      .sort((a, b) => new Date(b.requestTime || 0) - new Date(a.requestTime || 0));

    const counts = { pending: 0, active: 0, expired: 0, rejected: 0 };
    requests.forEach((r) => {
      if (counts[r.status] != null) counts[r.status] += 1;
    });

    return res.json({
      success: true,
      groupName: (foundGroup && foundGroup.groupName) || groupName,
      counts,
      requests
    });
  } catch (err) {
    console.error("[my-loan-requests]", err);
    return res.status(500).json({ success: false, message: "Could not load loan requests.", requests: [] });
  }
});

// POST /member/cancel-loan-request — delete a pending loan request by requestId
router.post("/cancel-loan-request", async (req, res) => {
  try {
    const groupName = String(req.body.groupName || "").trim();
    const requestId = String(req.body.requestId || "").trim();
    const phoneRaw = String(req.body.phone || req.body.memberPhone || "").trim();

    if (!groupName || !requestId) {
      return res.json({ success: false, message: "groupName and requestId are required." });
    }

    const memberPhone = phoneRaw ? normalizeKenyanPhone(phoneRaw) : "";
    let removed = null;
    let savedTo = [];

    const removeFromList = (list) => {
      if (!Array.isArray(list)) return { list: list || [], removed: null };
      const idx = list.findIndex((r) => r && String(r.requestId) === requestId);
      if (idx === -1) return { list, removed: null };
      const item = list[idx];
      const condition = String(
        (item.status && item.status.condition) || item.status || "pending"
      ).toLowerCase();
      if (condition !== "pending") {
        return { list, removed: null, blocked: true, reason: "Only pending loan requests can be cancelled." };
      }
      if (
        memberPhone &&
        normalizeKenyanPhone(item.memberPhone || "") &&
        normalizeKenyanPhone(item.memberPhone || "") !== memberPhone
      ) {
        return { list, removed: null, blocked: true, reason: "You can only cancel your own loan request." };
      }
      const next = list.slice();
      const [del] = next.splice(idx, 1);
      return { list: next, removed: del };
    };

    // 1) general.json
    try {
      const generalData = readJSON(generalFile, {});
      const groupRef = findGroupInGeneral(generalData, groupName);
      if (groupRef && groupRef.group) {
        ensurePendingApprovals(groupRef.group);
        const result = removeFromList(groupRef.group.pendingApprovals.loan.requestLoan);
        if (result.blocked) {
          return res.json({ success: false, message: result.reason });
        }
        if (result.removed) {
          groupRef.group.pendingApprovals.loan.requestLoan = result.list;
          groupRef.group.updatedAt = new Date().toISOString();
          removed = result.removed;
          writeJSON(generalFile, generalData);
          savedTo.push("general.json");
        }
      }
    } catch (e) {
      console.error("[cancel-loan-request] general.json failed:", e.message);
    }

    // 2) Mongo groups
    try {
      const mongoHit = await findGroupNameInMongoGroupsCollection(groupName);
      if (mongoHit && mongoHit.group) {
        const group = { ...mongoHit.group };
        ensurePendingApprovals(group);
        const result = removeFromList(group.pendingApprovals.loan.requestLoan);
        if (result.blocked && !removed) {
          return res.json({ success: false, message: result.reason });
        }
        if (result.removed) {
          group.pendingApprovals.loan.requestLoan = result.list;
          group.updatedAt = new Date().toISOString();
          if (!removed) removed = result.removed;
          await saveGeneralGroupToMongo({
            ...group,
            county: mongoHit.county || group.county,
            constituency: mongoHit.constituency || group.constituency,
            ward: mongoHit.ward || group.ward
          });
          savedTo.push("mongo.groups");
        }
      }
    } catch (e) {
      console.error("[cancel-loan-request] mongo failed:", e.message);
    }

    if (!removed) {
      return res.status(404).json({
        success: false,
        message: `Pending loan request "${requestId}" was not found.`
      });
    }

    return res.json({
      success: true,
      message: "Pending loan request cancelled.",
      removed,
      savedTo
    });
  } catch (err) {
    console.error("[cancel-loan-request]", err);
    return res.status(500).json({
      success: false,
      message: "Could not cancel loan request. Try again."
    });
  }
});

module.exports = router;
