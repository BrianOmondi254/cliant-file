const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { findUserByPhone, getAllUsersFlattened, updateUserPassword, getUserNameByPhone, County, ensureMongoReady,   getMessagesForUser, getPendingOfficerMessageByPhone,   getTbankSettings,
  Agent,
  Dealer,
  Message,
  normalizePhone,
  findAgentByPhone,
  findDealerByPhone } = require("../mongoose");

// Flatten hierarchical users for searching
const flattenUsers = (hierarchicalData) => {
  const flat = [];
  // Check if already flat (has county field on user objects)
  if (Array.isArray(hierarchicalData) && hierarchicalData.length > 0 && hierarchicalData[0].county && !hierarchicalData[0].constituencies) {
    // Already flattened format
    return hierarchicalData;
  }
  // Hierarchical format
  hierarchicalData.forEach(countyItem => {
    countyItem.constituencies.forEach(constituencyItem => {
      constituencyItem.wards.forEach(wardItem => {
        wardItem.data.forEach(user => {
          flat.push({ ...user, county: countyItem.county, constituency: constituencyItem.name, ward: wardItem.name });
        });
      });
    });
  });
  return flat;
};

// Async wrapper for getting all users from MongoDB
const getUsersFromMongo = async () => {
  try {
    return await getAllUsersFlattened();
  } catch (error) {
    console.error("Error getting users from MongoDB:", error.message);
    return [];
  }
};

// Find user in hierarchical structure
const findUserInHierarchy = (hierarchicalData, phoneNumber) => {
  for (let countyIdx = 0; countyIdx < hierarchicalData.length; countyIdx++) {
    const countyItem = hierarchicalData[countyIdx];
    for (let consIdx = 0; consIdx < countyItem.constituencies.length; consIdx++) {
      const consItem = countyItem.constituencies[consIdx];
      for (let wardIdx = 0; wardIdx < consItem.wards.length; wardIdx++) {
        const wardItem = consItem.wards[wardIdx];
        for (let dataIdx = 0; dataIdx < wardItem.data.length; dataIdx++) {
          if (norm(wardItem.data[dataIdx].phoneNumber) === norm(phoneNumber)) {
            return { countyIdx, consIdx, wardIdx, dataIdx };
          }
        }
      }
    }
  }
  return null;
};

const router = express.Router();
const groupsFile = path.join(__dirname, "../general.json");

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

const flattenData = (data) => {
    if (Array.isArray(data)) return data;
    const flat = [];
    if (!data) return flat;
    for (const county in data) {
        if (county === 'performance' || typeof data[county] !== 'object') continue;
        const countyData = data[county];
        // New nested format: county -> constituencies[] -> wards[] -> data[]
        if (countyData.constituencies && Array.isArray(countyData.constituencies)) {
            for (const cons of countyData.constituencies) {
                const consName = cons.name || '';
                if (!cons.wards || !Array.isArray(cons.wards)) continue;
                for (const ward of cons.wards) {
                    const wardName = (typeof ward === 'string') ? ward : (ward.name || 'Unknown Ward');
                    const groupArray = (typeof ward === 'object' && ward.data && Array.isArray(ward.data))
                        ? ward.data
                        : [];
                    groupArray.forEach(item => {
                        if (typeof item === 'string') return;
                        if (item && typeof item === 'object' && !item.isPerformance) {
                            flat.push({
                                ...item,
                                county: item.county || county,
                                constituency: item.constituency || consName,
                                ward: item.ward || wardName,
                            });
                        }
                    });
                }
            }
            continue;
        }
        // Old / hybrid format: county -> constituency -> items[]
        for (const constituency in countyData) {
            if (constituency === 'performance') continue;
            const items = countyData[constituency];
            if (Array.isArray(items)) {
                let currentWard = "Unknown Ward";
                items.forEach(item => {
                    if (typeof item === 'string') {
                        currentWard = item;
                    } else if (typeof item === 'object' && item !== null && !item.isPerformance) {
                        flat.push({
                            ...item,
                            county: item.county || county,
                            constituency: item.constituency || constituency,
                            ward: item.ward || currentWard,
                        });
                    }
                });
            }
        }
    }
    return flat;
};

const normalizeMembersMap = (members) => {
    const normalized = {};
    if (!members || typeof members !== 'object') return normalized;

    if (typeof members.forEach === 'function') {
        members.forEach((value, key) => {
            normalized[String(key)] = value && typeof value.toObject === 'function' ? value.toObject() : value;
        });
        return normalized;
    }

    for (const key of Object.keys(members)) {
        const value = members[key];
        normalized[String(key)] = value && typeof value.toObject === 'function' ? value.toObject() : value;
    }
    return normalized;
};

const memberMatchesPhone = (memberId, member, targetPhone) => {
    const phoneFromKey = norm(memberId || '');
    const phoneFromMember = norm((member && (member.memberId || member.phone || member.phoneNumber)) || '');
    return phoneFromKey === targetPhone || phoneFromMember === targetPhone;
};

const inferMemberRole = (memberId, member) => {
    if (member && member.role) return member.role;
    if (member && member.type) return member.type;
    if (/^trustee_/.test(memberId || '')) return 'trustee';
    if (/^official_/.test(memberId || '')) return 'official';
    if (/^member_/.test(memberId || '')) return 'member';
    return 'member';
};

const groupContainsPhone = (group, targetPhone) => {
    if (group && typeof group === 'object') {
        if (norm(group.phone) === targetPhone) return true;
        if (norm(group.chairpersonalphonenumber) === targetPhone) return true;
    }

    return Object.keys(group || {}).some(key => {
        const item = group[key];
        return item && typeof item === 'object' && item.phone && norm(item.phone) === targetPhone;
    });
};

const getGroupsForMemberFromGroupsCollection = async (phone) => {
    const targetPhone = norm(phone);
    if (!targetPhone) return [];

    const ready = await ensureMongoReady();
    if (!ready) return [];

    const db = require('mongoose').connection.db;
    if (!db) return [];

    const docs = await db.collection('groups').find({}).toArray();
    const groups = [];

    for (const doc of docs) {
        if (!doc) continue;

        // MemberGroup-style document: { groupName, members: Map/object }
        if (doc.members && typeof doc.members === 'object' && !Array.isArray(doc.members)) {
            const members = normalizeMembersMap(doc.members);
            const match = Object.entries(members).find(([memberId, member]) =>
                memberMatchesPhone(memberId, member, targetPhone)
            );

            if (!match) continue;

            const [memberId, member] = match;
            const role = inferMemberRole(memberId, member);

            groups.push({
                groupName: doc.groupName || doc.groupKey || 'Unnamed Group',
                groupNumber: doc.groupNumber || '',
                accountNumber: doc.accountNumber || doc.groupKey || '',
                phase: doc.phase || '',
                role,
                roleTitle: (member && (member.title || member.roleTitle)) || role,
                memberNumber: (member && member.memberNumber) || '',
                memberId: (member && (member.memberId || member.phone || member.phoneNumber)) || memberId,
                county: doc.county || '',
                constituency: doc.constituency || '',
                ward: doc.ward || '',
                myBalance: doc.myBalance || 0,
                totalMembers: Object.keys(members).length,
                messages: Array.isArray(doc.messages) ? doc.messages : [],
                constitutionStartKey: doc.constitutionStartKey,
                source: 'groups'
            });
            continue;
        }

        // MemberGroup-style document with members stored as an array
        if (Array.isArray(doc.members)) {
            const match = doc.members.find(member =>
                member && typeof member === 'object' && (
                    norm(member.memberId || member.phone || member.phoneNumber || '') === targetPhone
                )
            );

            if (!match) continue;

            const role = inferMemberRole(match.memberId || '', match);

            groups.push({
                groupName: doc.groupName || doc.groupKey || 'Unnamed Group',
                groupNumber: doc.groupNumber || '',
                accountNumber: doc.accountNumber || doc.groupKey || '',
                phase: doc.phase || '',
                role,
                roleTitle: (match.title || match.roleTitle) || role,
                memberNumber: match.memberNumber || '',
                memberId: match.memberId || match.phone || match.phoneNumber || '',
                county: doc.county || '',
                constituency: doc.constituency || '',
                ward: doc.ward || '',
                myBalance: doc.myBalance || 0,
                totalMembers: doc.members.length,
                messages: Array.isArray(doc.messages) ? doc.messages : [],
                constitutionStartKey: doc.constitutionStartKey,
                source: 'groups'
            });
            continue;
        }

        // Flattened group document: { groupName, trustee_1, official_1, member_1, ... }
        if (doc.groupName && groupContainsPhone(doc, targetPhone)) {
            const roleInfo = Object.keys(doc).reduce((found, key) => {
                if (found) return found;
                const item = doc[key];
                if (item && typeof item === 'object' && item.phone && norm(item.phone) === targetPhone) {
                    return { key, item };
                }
                return found;
            }, null);

            const isChairperson = norm(doc.phone) === targetPhone || norm(doc.chairpersonalphonenumber) === targetPhone;

            groups.push({
                groupName: doc.groupName,
                groupNumber: doc.groupNumber || '',
                accountNumber: doc.accountNumber || '',
                phase: doc.phase || '',
                role: roleInfo && roleInfo.key.startsWith('trustee_') ? 'trustee' : (roleInfo && roleInfo.key.startsWith('official_') ? 'official' : (isChairperson ? 'trustee' : 'member')),
                roleTitle: (roleInfo && (roleInfo.item.title || roleInfo.item.type)) || (isChairperson ? 'Chairperson' : ''),
                memberNumber: (roleInfo && roleInfo.item.memberNumber) || '',
                memberId: (roleInfo && roleInfo.item.phone) || doc.phone || doc.chairpersonalphonenumber || '',
                county: doc.county || '',
                constituency: doc.constituency || '',
                ward: doc.ward || '',
                myBalance: doc.myBalance || 0,
                totalMembers: Object.keys(doc).filter(k => k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')).length,
                messages: Array.isArray(doc.messages) ? doc.messages : [],
                constitutionStartKey: doc.constitutionStartKey,
                source: 'groups'
            });
            continue;
        }

        // Legacy hierarchical county document stored in the same groups collection
        if (doc.constituencies && Array.isArray(doc.constituencies)) {
            const countyName = doc.county || '';
            for (const cons of doc.constituencies || []) {
                const consName = cons.name || '';
                if (!cons.wards || !Array.isArray(cons.wards)) continue;
                for (const ward of cons.wards) {
                    const wardName = (typeof ward === 'string') ? ward : (ward.name || 'Unknown Ward');
                    const groupArray = (typeof ward === 'object' && ward.data && Array.isArray(ward.data))
                        ? ward.data
                        : [];
                    for (const item of groupArray) {
                        if (!item || typeof item !== 'object' || item.isPerformance || !item.groupName) continue;
                        if (!groupContainsPhone(item, targetPhone)) continue;

                        const roleInfo = Object.keys(item).reduce((found, key) => {
                            if (found) return found;
                            const member = item[key];
                            if (member && typeof member === 'object' && member.phone && norm(member.phone) === targetPhone) {
                                return { key, member };
                            }
                            return found;
                        }, null);

                        const isChairperson = norm(item.phone) === targetPhone || norm(item.chairpersonalphonenumber) === targetPhone;

                        groups.push({
                            ...item,
                            county: item.county || countyName,
                            constituency: item.constituency || consName,
                            ward: item.ward || wardName,
                            role: roleInfo && roleInfo.key.startsWith('trustee_') ? 'trustee' : (roleInfo && roleInfo.key.startsWith('official_') ? 'official' : (isChairperson ? 'trustee' : 'member')),
                            roleTitle: (roleInfo && (roleInfo.member.title || roleInfo.member.type)) || (isChairperson ? 'Chairperson' : ''),
                            memberNumber: (roleInfo && roleInfo.member.memberNumber) || '',
                            memberId: (roleInfo && roleInfo.member.phone) || item.phone || item.chairpersonalphonenumber || '',
                            source: 'groups'
                        });
                    }
                }
            }
        }

        // Legacy flat constituency-as-key format: { county: "X", ConstituencyName: ["ward", ...groups] }
        if (doc.county && !doc.groupName) {
            for (const key of Object.keys(doc)) {
                if (key === '_id' || key === 'county' || key === 'performance') continue;
                const items = doc[key];
                if (!Array.isArray(items)) continue;
                
                let currentWard = "Unknown Ward";
                for (const item of items) {
                    if (typeof item === 'string') {
                        currentWard = item;
                        continue;
                    }
                    if (!item || typeof item !== 'object' || item.isPerformance) continue;
                    if (!groupContainsPhone(item, targetPhone)) continue;

                    const roleInfo = Object.keys(item).reduce((found, k) => {
                        if (found) return found;
                        const member = item[k];
                        if (member && typeof member === 'object' && member.phone && norm(member.phone) === targetPhone) {
                            return { key: k, member };
                        }
                        return found;
                    }, null);

                    const isChairperson = norm(item.phone) === targetPhone || norm(item.chairpersonalphonenumber) === targetPhone;

                    groups.push({
                        ...item,
                        county: item.county || doc.county,
                        constituency: item.constituency || key,
                        ward: item.ward || currentWard,
                        role: roleInfo && roleInfo.key.startsWith('trustee_') ? 'trustee' : (roleInfo && roleInfo.key.startsWith('official_') ? 'official' : (isChairperson ? 'trustee' : 'member')),
                        roleTitle: (roleInfo && (roleInfo.member.title || roleInfo.member.type)) || (isChairperson ? 'Chairperson' : ''),
                        memberNumber: (roleInfo && roleInfo.member.memberNumber) || '',
                        memberId: (roleInfo && roleInfo.member.phone) || item.phone || item.chairpersonalphonenumber || '',
                        source: 'groups'
                    });
                }
            }
        }
    }

    return groups;
};

const restructureData = (data) => {
  if (!Array.isArray(data)) return data; // Assume already structured
  const structured = {};
  for (const group of data) {
    const county = group.county || "Unknown County";
    const constituency = group.constituency || "Unknown Constituency";
    const ward = group.ward || "Unknown Ward";

    if (!structured[county]) structured[county] = {};
    if (!structured[county][constituency])
      structured[county][constituency] = {};
    if (!structured[county][constituency][ward])
      structured[county][constituency][ward] = [];

    structured[county][constituency][ward].push(group);
  }
  // console.log("Data restructured to hierarchy.");
  return structured;
};

/* 🔒 Auth middleware */
router.use((req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  next();
});

/* 👤 Personal dashboard */
router.get("/", async (req, res) => {
  try {
    const phone = req.session.user && req.session.user.phoneNumber;

    const checkItem = (item) => {
      if (!item) return false;
      let itemPhone = "";
      if (typeof item === 'string') itemPhone = item;
      else if (item.phoneNumber) itemPhone = item.phoneNumber;
      else if (item.phone) itemPhone = item.phone;

      return norm(itemPhone) === norm(phone);
    };

    const search = (data) => {
      if (!data) return false;
      if (checkItem(data)) return true;
      if (Array.isArray(data)) return data.some(search);
      if (typeof data === 'object') {
        const keyMatch = Object.keys(data).some(k => norm(k) === norm(phone));
        if (keyMatch) return true;
        return Object.values(data).some(val => (typeof val === 'object' && val !== null) && search(val));
      }
      return false;
    };

    // ── Fetch groups from MongoDB `groups` collection and match the logged-in phone ──
    const userGroups = [];
    try {
      const groupsFromCollection = await getGroupsForMemberFromGroupsCollection(phone);
      userGroups.push(...groupsFromCollection);
      console.log(`[personal] groups collection returned ${groupsFromCollection.length} group(s) for ${phone}: ${groupsFromCollection.map(g => g.groupName).join(', ') || '(none)'}`);
    } catch (e) {
      console.error("[personal] groups collection membership lookup error:", e.message);
    }

    // Use session flags for showDealer, showAgent, agent, and hasAgentPin
    // To be robust, re-check against MongoDB collections if flags are missing or stale
    const isDealerInFile = !!(await findDealerByPhone(phone));
    const isAgentInFile = !!(await findAgentByPhone(phone));

    const showDealer = !!(req.session.isDealer || isDealerInFile);
    const showAgent = !!(req.session.isAgent || isAgentInFile);

    const dealerIsVerified = !!req.session.dealerPhone;
    const agentIsVerified = true;

    // Identify if user is a trustee, official or member and collect keys
    let isTrustee = false;
    let isOfficial = false;
    let isMember = false;
    const constitutionKeys = [];
    const groupMessages = [];

    const userInThisGroup = (g, phone) => {
      return Object.values(g).some(v => {
        if (v && typeof v === 'object') {
          if (v.phone && norm(v.phone) === norm(phone)) return true;
          if (v.requesterPhone && norm(v.requesterPhone) === norm(phone)) return true;
          if (v.approverPhone && norm(v.approverPhone) === norm(phone)) return true;
          if (v.to && norm(v.to) === norm(phone)) return true;
          if (Array.isArray(v)) return v.some(child => child && typeof child === 'object' && search(child));
          return search(v);
        }
        return false;
      });
    };

    userGroups.forEach(group => {
      const role = String(group.role || '').toLowerCase();
      const userIsTrusteeInThisGroup = role === 'trustee';

      if (userIsTrusteeInThisGroup) isTrustee = true;
      else if (role === 'official') isOfficial = true;
      else isMember = true;

      if (group.messages && Array.isArray(group.messages)) {
        group.messages.forEach(msg => {
          if (msg.to && norm(msg.to) === norm(phone)) {
            groupMessages.push({
              groupName: group.groupName,
              title: msg.title,
              content: msg.content,
              type: msg.type,
              createdAt: msg.createdAt,
              isNew: msg.isNew !== false
            });
          }
        });
      }

      if (group.messages && Array.isArray(group.messages)) {
        group.messages.forEach(msg => {
          if (msg.to && norm(msg.to) === norm(phone)) {
            // Check if this is a constitution key notification
            if (msg.type === 'security_alert' && msg.title === 'Constitution Key') {
              constitutionKeys.push({
                groupName: msg.title || group.groupName,
                key: msg.content,
                type: 'security_alert'
              });
            } else {
              constitutionKeys.push({
                groupName: msg.title || group.groupName,
                type: msg.type,
                content: msg.content,
                isNew: true
              });
            }
          } else if (msg.broadcast && msg.roles && msg.roles.includes('trustee') && userIsTrusteeInThisGroup) {
            constitutionKeys.push({
              groupName: msg.title || group.groupName,
              type: msg.type,
              content: msg.content,
              isNew: true
            });
          }
        });
      }

if (group.constitutionStartKey && !group.constitutionStartKey.startsWith('$2') && userIsTrusteeInThisGroup) {
         constitutionKeys.push({
           groupName: group.groupName,
           key: group.constitutionStartKey,
           type: 'legacy'
         });
       }
     });

    // Fetch messages from MongoDB messages collection
    try {
      const mongoMessages = await getMessagesForUser(phone);
      mongoMessages.forEach(msg => {
        if (msg.type === 'security_alert' && msg.title === 'Constitution Key' && msg.key) {
          constitutionKeys.push({
            groupName: msg.groupName,
            key: msg.key,
            type: 'security_alert'
          });
        } else if (msg.to && norm(msg.to) === norm(phone)) {
          constitutionKeys.push({
            _id: msg._id,
            groupName: msg.title || 'Notification',
            type: msg.type,
            content: msg.content,
            meta: msg.meta,
            isNew: true
          });
        }
      });
    } catch (e) {
      console.error("Error fetching messages from MongoDB:", e.message);
    }

    const normalizedPhone = norm(phone);

    // Get all users from MongoDB for name lookups and PIN check
    let usersFlat = [];
    try {
      usersFlat = await getAllUsersFlattened();
    } catch (e) {
      console.error("Error fetching users from MongoDB:", e.message);
    }

    const getUserName = (phoneNumber) => {
      if (!phoneNumber) return null;
      try {
        return getUserNameByPhone(phoneNumber);
      } catch (e) {
        const normalized = norm(phoneNumber);
        const u = usersFlat.find(user => norm(user.phoneNumber) === normalized);
        if (!u) return null;
        return `${u.FirstName || ''} ${u.MiddleName || ''} ${u.LastName || ''}`.replace(/\s+/g, ' ').trim();
      }
    };

    // Augment userGroups with member names
    userGroups.forEach(group => {
      Object.keys(group).forEach(key => {
        if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
          const item = group[key];
          if (item && typeof item === 'object' && item.phone) {
            const u = usersFlat.find(user => norm(user.phoneNumber) === norm(item.phone));
            if (u) item.name = `${u.FirstName || ''} ${u.MiddleName || ''} ${u.LastName || ''}`.replace(/\s+/g, ' ').trim();
          }
        }
      });
    });

    const generalExists = userGroups.length > 0;

    let hasPersonalPin = false;
    try {
      const dbUser = await findUserByPhone(phone);
      if (dbUser && dbUser.personalPin) {
        hasPersonalPin = true;
      } else {
        const currentUser = usersFlat.find(u => norm(u.phoneNumber) === norm(phone));
        hasPersonalPin = !!(currentUser && currentUser.personalPin);
      }
    } catch (e) {
      console.error("Error finding user in DB for PIN check:", e);
    }

      let pendingOfficerMessage = null;
      if (req.session.user && req.session.user.phoneNumber) {
        pendingOfficerMessage = await getPendingOfficerMessageByPhone(req.session.user.phoneNumber);
      }

      let tbankSettings = null;
      try {
        tbankSettings = await getTbankSettings();
      } catch (e) {
        console.error("Error fetching tbank settings:", e.message);
      }

 res.render('cliant', {
        user: req.session.user,
        showAgent,
        showDealer,
        firebaseConfig: {
          apiKey: process.env.FIREBASE_API_KEY,
          authDomain: process.env.FIREBASE_AUTH_DOMAIN,
          projectId: process.env.FIREBASE_PROJECT_ID,
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
          messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
          appId: process.env.FIREBASE_APP_ID,
          measurementId: process.env.FIREBASE_MEASUREMENT_ID
        },
       generalExists,
       isTrustee, // Note: This might be true if ANY group has user as trustee
       isOfficial,
       isMember,
       dealerIsVerified,
       agentIsVerified,
       personalIsVerified: req.session.personalVerified || false, // Pass verified status
       hasAgentPin: true,
       hasPersonalPin, // Pass hasPersonalPin to view
       hasDealerPin: req.session.hasDealerPin || false,
       constitutionKeys, // Pass keys to view
       groupMessages, // Pass user's group messages to inbox
       userGroups: userGroups,
       normalizedPhone,
       pendingOfficerMessage,
       lastSelectedAuthOption: (tbankSettings && tbankSettings.lastSelectedAuthOption) || null,
       lastSelectedAuthOptionHistory: (tbankSettings && tbankSettings.lastSelectedAuthOptionHistory) || null
      });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error rendering the page");
  }
});

/* 🔒 Set Personal PIN */
router.post("/set-pin", async (req, res) => {
  try {
    const { pin } = req.body;
    const phone = req.session.user && req.session.user.phoneNumber;

    if (!pin || pin.length < 4) {
      return res.status(400).json({ success: false, message: "Invalid PIN format" });
    }

    // Hash the PIN before saving
    const saltRounds = 10;
    const hashedPin = await bcrypt.hash(pin, saltRounds);

    // Check MongoDB first
    const dbUser = await findUserByPhone(phone);
    if (dbUser) {
      await updateUserPassword(phone, hashedPin, true); // isPin = true
    } else {
      // Fallback to data.json (hierarchical)
      const usersFile = path.join(__dirname, "../data.json");
      const users = readJSON(usersFile, []);
      
      const userLoc = findUserInHierarchy(users, phone);
      if (userLoc) {
        users[userLoc.countyIdx].constituencies[userLoc.consIdx].wards[userLoc.wardIdx].data[userLoc.dataIdx].personalPin = hashedPin;
        writeJSON(usersFile, users);
      } else {
        return res.status(404).json({ success: false, message: "User not found" });
      }
    }

    // Set verified flag in session
    req.session.personalVerified = true;

    res.json({ success: true, message: "PIN set successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/* 🔒 Verify Personal PIN */
router.post("/verify-pin", async (req, res) => {
  try {
    const { pin } = req.body;
    const phone = req.session.user && req.session.user.phoneNumber;

    if (!pin) {
      return res.status(400).json({ success: false, message: "PIN required" });
    }

    let user = await findUserByPhone(phone);
    if (!user) {
      // Fallback to data.json (hierarchical)
      const usersFile = path.join(__dirname, "../data.json");
      const users = readJSON(usersFile, []);
      const usersFlat = flattenUsers(users);
      user = usersFlat.find(u => norm(u.phoneNumber) === norm(phone));
    }

    if (!user || !user.personalPin) {
      console.log(`[Verify PIN] PIN not found for phone: ${phone}`);
      return res.status(404).json({ success: false, message: "PIN not found" });
    }

    console.log(`[Verify PIN] Phone: ${phone}, Entered: ${pin}, Stored: ${user.personalPin}`);

    let isValid = false;
    // 1. Try plaintext direct comparison first (for simple PINs)
    if (String(pin) === String(user.personalPin)) {
      isValid = true;
    } else {
      // 2. Try bcrypt comparison if stored PIN is a valid bcrypt hash
      try {
        if (user.personalPin.startsWith('$2')) {
          isValid = await bcrypt.compare(pin, user.personalPin);
        }
      } catch (err) {
        console.error('[Verify PIN] Bcrypt error:', err);
      }
    }

    console.log(`[Verify PIN] Result: ${isValid ? 'VALID' : 'INVALID'}`);

    if (isValid) {
      req.session.personalVerified = true;
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, message: "Incorrect PIN" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/* 🔒 Change Personal PIN */
router.post("/change-pin", async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const phone = req.session.user && req.session.user.phoneNumber;

    if (!oldPin || !newPin) {
      return res.status(400).json({ success: false, message: "Old PIN and new PIN are required" });
    }

    if (newPin.length < 4 || !/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ success: false, message: "New PIN must be exactly 4 digits" });
    }

    const usersFile = path.join(__dirname, "../data.json");

    // Find user in MongoDB
    let user = await findUserByPhone(phone);
    let isMongoUser = !!user;

    if (!user) {
      // Fallback to data.json (hierarchical)
      const users = readJSON(usersFile, []);
      const userLoc = findUserInHierarchy(users, phone);
      if (!userLoc) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      user = { ...users[userLoc.countyIdx].constituencies[userLoc.consIdx].wards[userLoc.wardIdx].data[userLoc.dataIdx], personalPin: null };
    }

    // Verify old PIN first
    if (!user.personalPin) {
      return res.status(400).json({ success: false, message: "No PIN set. Please set a PIN first." });
    }

    const isOldPinValid = await bcrypt.compare(oldPin, user.personalPin);
    if (!isOldPinValid) {
      return res.status(401).json({ success: false, message: "Incorrect old PIN" });
    }

    // Hash the new PIN and save
    const saltRounds = 10;
    const hashedNewPin = await bcrypt.hash(newPin, saltRounds);
    
    if (isMongoUser) {
      await updateUserPassword(phone, hashedNewPin, true); // isPin = true
    } else {
      const users = readJSON(usersFile, []);
      const usersFlat = flattenUsers(users);
      const userIndex = usersFlat.findIndex(u => norm(u.phoneNumber) === norm(phone));
      if (userIndex !== -1) {
        usersFlat[userIndex].personalPin = hashedNewPin;
        writeJSON(usersFile, users);
      }
    }

    res.json({ success: true, message: "PIN changed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/* 👤 Get User Name by Phone */
router.get("/get-name", (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ success: false, message: "Phone required" });
    
    const usersFile = path.join(__dirname, "../data.json");
    const users = readJSON(usersFile, []);
    const usersFlat = flattenUsers(users);
    const normalized = norm(phone);
    const u = usersFlat.find(user => norm(user.phoneNumber) === normalized);
    
    if (u) {
      const name = `${u.FirstName} ${u.MiddleName || ''} ${u.LastName}`.replace(/\s+/g, ' ').trim();
      res.json({ success: true, name });
    } else {
      res.json({ success: false, message: "User not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* 📂 My Groups */
router.get("/myaccount", (req, res) => {
  try {
    const phone = req.session.user?.phoneNumber;
    // --- DEBUG LOGGING START ---
    console.log(`[MyAccount] Fetching groups for session phone number: ${phone}`);
    const normalizedPhone = norm(phone);
    console.log(`[MyAccount] Normalized phone number for search: ${normalizedPhone}`);

    const groupsRaw = readJSON(groupsFile, {});
    const allGroups = flattenData(groupsRaw);

    const userGroups = allGroups.filter(group => {
      // Check if user is linked to the group in any capacity
      for (const key in group) {
        const item = group[key];
        if (item && typeof item === 'object' && item.phone && norm(item.phone) === normalizedPhone) {
            return true;
        }
      }
      // Also check top-level phone properties
      if (group.phone && norm(group.phone) === normalizedPhone) {
            return true;
      }
      return false;
    });

    // --- DEBUG LOGGING END ---
    console.log(`[MyAccount] Found ${userGroups.length} group(s) for this number.`);
    if (userGroups.length > 0) {
      console.log(`[MyAccount] Group names found: ${userGroups.map(g => g.groupName).join(', ')}`);
    }

    const activeGroups = userGroups.filter(g => parseInt(g.phase || 0) === 3);

    res.render("myaccount", { 
      user: req.session.user,
      groups: activeGroups,
      alert: req.query.alert || null
    });
  } catch (err) {
    console.error("Error fetching user groups for myaccount:", err);
    res.render("myaccount", {
        user: req.session.user,
        groups: [],
        alert: "Error loading your group information."
    });
  }
});

/* 💰 Wallet - Get user's wallet balance and transactions */
router.get("/wallet", (req, res) => {
  try {
    const phone = req.session.user?.phoneNumber;
    if (!phone) return res.status(401).json({ success: false, error: "Not authenticated" });

    const pAccountDir = path.join(__dirname, "../p_account");
    const personalFile = path.join(pAccountDir, "personal.json");
    const personalData = readJSON(personalFile, { personalAccounts: {} });

    const normalizedPhone = norm(phone);
    const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
      norm(personalData.personalAccounts[key].phone) === normalizedPhone
    );

    if (!accountKey) return res.json({ success: true, balance: 0, transactions: [], accountExists: false });

    const account = personalData.personalAccounts[accountKey];
    // Handle both old format (transactions on account) and new format (accounts.xxx.transactions)
    const accountTxns = account.transactions || [];
    const nestedTxns = [];
    if (account.accounts && typeof account.accounts === 'object') {
      Object.values(account.accounts).forEach(acc => {
        if (acc.transactions && Array.isArray(acc.transactions)) {
          nestedTxns.push(...acc.transactions);
        }
      });
    }
    const allTxns = [...accountTxns, ...nestedTxns];

    const transactions = allTxns.map(t => ({
      type: t.type || t.transactionType || 'received',
      acc: (t.from?.name || t.to?.name || 'Personal Account'),
      amt: parseFloat(t.amount || 0),
      date: t.time || t.date,
      accountNumber: t.to?.number || t.from?.number || account.phone,
      notes: t.notes || ''
    }));

    const balance = transactions.length > 0
      ? transactions.reduce((sum, t) => sum + (t.type === 'received' || t.type === 'deposit' ? t.amt : -t.amt), 0)
      : 0;

    res.json({ success: true, balance, transactions, accountExists: true });
  } catch (err) {
    console.error("Error fetching wallet:", err);
    res.status(500).json({ success: false, error: "Failed to load wallet" });
  }
});

/* 🏠 Group Details */
router.get("/group/:groupName", async (req, res) => {
  try {
    const groupName = decodeURIComponent(req.params.groupName);
    const groupsRaw = readJSON(groupsFile, {});
    const allGroups = flattenData(groupsRaw);

    const group = allGroups.find(g => g.groupName === groupName);

    let userRole = 'member';
    const userPhone = norm(req.session.user.phoneNumber);

    if (group) {
      // 1. Determine User's Role
      let found = false;
      for (const key in group) {
        const item = group[key];
        if (item && typeof item === 'object' && item.phone && norm(item.phone) === userPhone) {
           found = true;
           if (key.startsWith('trustee_')) userRole = 'trustee';
           else if (key.startsWith('official_') && userRole !== 'trustee') userRole = 'official';
        }
      }
      if (group.chairpersonalphonenumber && norm(group.chairpersonalphonenumber) === userPhone) {
          userRole = 'trustee';
      }

      // 2. Augment group object with data for the view
      // Check for PIN (Secure Bcrypt Hash)
      group.pinIsSet = !!group.constitutionStartKey && String(group.constitutionStartKey).startsWith('$2');

      // Load user names for fallback
      const usersFile = path.join(__dirname, "../data.json");
      const users = readJSON(usersFile, []);
      const getUserName = (phone) => {
          const u = users.find(user => norm(user.phoneNumber) === norm(phone));
          return u ? `${u.FirstName} ${u.MiddleName || ''} ${u.LastName}`.replace(/\s+/g, ' ').trim() : null;
      };

      // Consolidate members list
      group.members = [];
      const memberKeys = Object.keys(group).filter(k => k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_'));
      
      memberKeys.forEach(key => {
          const item = group[key];
          if (item && typeof item === 'object' && item.phone) {
              const name = item.name || getUserName(item.phone) || "Unknown Name";
              group.members.push({
                  name: name,
                  phone: item.phone,
                  membershipNumber: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
              });
          }
      });

      // Add chairperson if not already in members list
      if (group.chairpersonalphonenumber) {
          const chairName = (group.firstName ? `${group.firstName} ${group.secondName} ${group.lastName}` : getUserName(group.chairpersonalphonenumber)) || "Chairperson";
          if (!group.members.some(m => norm(m.phone) === norm(group.chairpersonalphonenumber))) {
              group.members.unshift({
                  name: chairName,
                  phone: group.chairpersonalphonenumber,
                  membershipNumber: 'Chairperson'
              });
          }
      }

      // 3. Dynamic Constitution Generation
      if (group.principles) {
          const p = group.principles;
          const points = [];
          
          // Identity / Basics
          points.push(`This member group shall officially be known as ${group.groupName}, anchored geographically in ${group.ward} Ward, ${group.constituency} Constituency, ${group.county} County.`);
          points.push(`The maximum proposed capacity for this group is ${group.totalProposedMembers || 15} members.`);
          
          // Meetings & Intervals
          if (p.intervals) {
              points.push(`Members shall collectively meet ${p.intervals.frequency} on every ${p.intervals.period.charAt(0).toUpperCase() + p.intervals.period.slice(1)}.`);
              points.push(`The group savings cycle and account life duration is established for exactly ${p.intervals.endSavingPeriod || '1 year'}.`);
          }
          
          // Accounts & Contributions
          if (p.otherContributions && p.otherContributions.length > 0) {
              const contribs = p.otherContributions.map(c => `${c.accountName} (Account No. ${c.accountNumber}) with amount KES ${c.expectedAmount}`).join('; ');
              points.push(`The standard bank account contributions shall be maintained strictly as: ${contribs}.`);
          }
          
          // Division of Share / Distribution
          if (p.distribution) {
              points.push(`Dividend distribution shall follow a '${p.distribution.model}' model. Official percentage cut: ${p.distribution.officialPct}%. Performance-based share percentage: ${p.distribution.performancePct || 0}%.`);
              if (p.distribution.targetAccountName) {
                  points.push(`Profit division will accumulate towards '${p.distribution.targetAccountName}' account pool.`);
              }
          }
          
          // Balancing and Welfare/Penalty
          if (p.balancing && p.balancing.benefitAccounts) {
              points.push(`Benefits and fines shall be distributed across the following pool accounts: ${p.balancing.benefitAccounts.join(', ')}.`);
          }
          
          // Loans
          if (p.loans) {
              points.push(`Members qualify for loans based on '${p.loans.qualificationType || 'duration'}', specifically after ${p.loans.duration ? p.loans.duration.days : '30'} days of active participation.`);
              points.push(`Active loans shall attract a fixed interest rate of ${p.loans.interestAndLimits ? p.loans.interestAndLimits.interestRate : '0'}% per interval.`);
              points.push(`The maximum loan limit per member is strictly capped at x${p.loans.interestAndLimits ? p.loans.interestAndLimits.limitMultiplier : '3'} of their total savings.`);
              
              if (p.loans.repayment) {
                  points.push(`Loan repayment defaults to ${p.loans.repayment.durationDays || '30'} days, permitting a maximum of ${p.loans.repayment.maxRollovers || '3'} rollovers. Fees applied via '${p.loans.repayment.rolloverMethod || 'fixed'}' scale.`);
              }
          }
          
          // Governance
          if (p.governance) {
              points.push(`For governance, any rapid constitutional changes will mandate at least ${p.governance.fastNotificationThreshold || '60'}% voting quorum.`);
              points.push(`Major account edits and potential member removals strictly require a super-majority consensus threshold of ${p.governance.editAccountThreshold || '75'}%.`);
          }

          group.constitutionPoints = points;
      } else {
          group.constitutionPoints = [
              `This member group shall officially be known as ${group.groupName}, anchored geographically in ${group.ward} Ward, ${group.constituency} Constituency, ${group.county} County.`,
              `The maximum proposed capacity for this group is ${group.totalProposedMembers || 15} members.`,
              `The comprehensive principles and constitution rules have not yet been fully initialized.`
          ];
      }
      
      // 4. Calculate Summary Stats (Countdown and Rounds)
      const now = new Date();
      let daysUntilMeeting = 0;
      let activeRound = 1;
      let remainRounds = 0;
      
      if (group.principles && group.principles.intervals) {
          const mapDays = { 'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6 };
          const p = group.principles;
          
          if (p.intervals.period) {
              const meetingDayInt = mapDays[p.intervals.period.toLowerCase()];
              if (meetingDayInt !== undefined) {
                  const currentDayInt = now.getDay();
                  daysUntilMeeting = meetingDayInt - currentDayInt;
                  if (daysUntilMeeting <= 0) daysUntilMeeting += 7;
                  if (meetingDayInt === currentDayInt) daysUntilMeeting = 0; 
              }
          }
          
          let roundDurationDays = 7;
          const freq = (p.intervals.frequency || 'weekly').toLowerCase();
          if (freq === 'monthly') roundDurationDays = 30;
          if (freq === 'daily') roundDurationDays = 1;

          const startDate = new Date(group.principlesSetAt || group.createdAt || now);
          const diffTime = Math.max(0, now - startDate);
          const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
          activeRound = Math.floor(diffDays / roundDurationDays) + 1;
          
          let totalDurationMonths = 12;
          const endPeriod = (p.intervals.endSavingPeriod || '1-year').toLowerCase();
          if (endPeriod.includes('6-month')) totalDurationMonths = 6;
          else if (endPeriod.includes('1-year') || endPeriod.includes('1 year')) totalDurationMonths = 12;
          else if (endPeriod.includes('2-year') || endPeriod.includes('2 year')) totalDurationMonths = 24;
          
          const totalDays = totalDurationMonths * 30; 
          const totalRounds = Math.floor(totalDays / roundDurationDays);
          
          remainRounds = Math.max(0, totalRounds - activeRound);
      }
      group.summaryStats = {
          daysUntilMeeting,
          activeRound,
          remainRounds
      };
      
      const showAgent = !!(req.session.isAgent || await findAgentByPhone(req.session.user.phoneNumber));
      const showDealer = !!(req.session.isDealer || await findDealerByPhone(req.session.user.phoneNumber));

      res.render("group-details", {
        user: req.session.user,
        userRole: userRole,
        group: group, // Pass the augmented group object
        alert: null,
        showAgent,
        showDealer,
        currentUserPhone: req.session.user.phoneNumber
      });

    } else {
      res.render("myaccount", {
        user: req.session.user,
        groups: [],
        alert: "Group not found."
      });
    }
  } catch (err) {
    console.error("Error fetching group details:", err);
    res.render("myaccount", {
      user: req.session.user,
      groups: [],
      alert: "Error loading group information."
    });
  }
});

/* 👥 Create / Manage General Group */
router.get("/general", (req, res) => {
  try {
    const phone = req.session.user && req.session.user.phoneNumber;
    let isCreation = req.query.mode === 'create';
    let userGroups = [];

    // For management mode (not create), we find user's groups.
    if (!isCreation) {
      const groupsRaw = readJSON(groupsFile, {});
      const allGroups = flattenData(groupsRaw);

      userGroups = allGroups.filter(group => {
        // Check if user is linked to the group in any capacity
        for (const key in group) {
          const item = group[key];
          if (item && typeof item === 'object' && item.phone && norm(item.phone) === norm(phone)) {
            return true;
          }
        }
        // Also check top-level phone properties
        if (group.phone && norm(group.phone) === norm(phone)) {
          return true;
        }
        return false;
      });

      // If no groups found to manage, switch to creation mode.
      // This avoids a popup on an empty management page.
      if (userGroups.length === 0) {
        isCreation = true;
      }
    }
    
    res.render("general_new", { 
      user: req.session.user,
      isCreation: isCreation,
      groups: userGroups, 
      debugMsg: "" 
    });
  } catch (err) {
    console.error("Error processing /general request:", err);
    res.status(500).send("An error occurred while processing your request.");
  }
});

/* ⏳ Fetch Pending Groups for User */
router.get("/pending-groups", (req, res) => {
  try {
    const phone = req.session.user && req.session.user.phoneNumber;
    const generalFile = path.join(__dirname, '../general.json');

    const groups = flattenData(readJSON(generalFile, {}));
    const userGroups = [];

    groups.forEach(group => {
      let isLinked = false;
      Object.keys(group).forEach(key => {
        const item = group[key];
        if (item && item.phone && norm(item.phone) === norm(phone)) {
          isLinked = true;
        }
      });

      if (isLinked) {
        userGroups.push({
          groupName: group.groupName,
          phase: group.phase || 1,
          id: group.id || group.groupName // Fallback for identification
        });
      }
    });

    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* 📝 Save General Group */
router.post("/general", (req, res) => {
  const {
    groupName,
    phone, // Assuming 'phone' is used for chairperson phone
    county,
    constituency,
    ward,
  } = req.body;

  if (!groupName || !phone || !county || !constituency || !ward) {
    // Consider sending an error message back to the user
    console.error("Missing required fields for group creation:", req.body);
    return res.status(400).send("Missing required fields.");
  }

  let accounts = readJSON(groupsFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const newAccount = {
    ...req.body,
    processorPhone: req.session.user.phoneNumber,
    createdAt: new Date().toISOString()
  };

  // Ensure path exists in hierarchy
  if (!accounts[county]) accounts[county] = {};
  if (!accounts[county][constituency]) accounts[county][constituency] = {};
  if (!accounts[county][constituency][ward]) accounts[county][constituency][ward] = [];

  accounts[county][constituency][ward].push(newAccount);

  writeJSON(groupsFile, accounts);

  res.redirect("/personal/myaccount?alert=Group%20Created%20Successfully");
});

/* 💸 Send Money Flow */
router.get("/send-money", (req, res) => {
  try {
    const phone = req.session.user?.phoneNumber;
    const normalizedPhone = norm(phone);
    const groupsRaw = readJSON(groupsFile, {});
    const allGroups = flattenData(groupsRaw);

    const userGroups = allGroups.filter(group => {
      for (const key in group) {
        const item = group[key];
        if (item && typeof item === 'object' && item.phone && norm(item.phone) === normalizedPhone) {
            return true;
        }
      }
      if (group.phone && norm(group.phone) === normalizedPhone) return true;
      return false;
    });

    const activeGroups = userGroups.filter(g => parseInt(g.phase || 0) === 3);

    res.render("send-money", { 
      user: req.session.user,
      groups: activeGroups,
      step: "select-account" 
    });
  } catch (err) {
    console.error("Error in send-money:", err);
    res.redirect("/personal");
  }
});

router.post("/send-money/details", (req, res) => {
  const { groupName } = req.body;
  res.render("send-money", { user: req.session.user, groupName, step: "details" });
});

router.post("/send-money/submit", (req, res) => {
  const { groupName, amount } = req.body;
  
  // 1. Clean input: remove any characters that are not numbers or decimals (removes $ and ,)
  const cleanAmount = String(amount).replace(/[^0-9.]/g, '');
  const val = parseFloat(cleanAmount) || 0;

  // 2. Format strictly as KSh
  const formattedAmount = `KSh ${val.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  // 3. Render Confirm Transfer screen (Popup Content)
  res.render("send-money", { 
    user: req.session.user, step: "confirm", amount: formattedAmount, groupName 
  });
});

router.post("/send-money/complete", (req, res) => {
  const { groupName, amount } = req.body;
  // Ensure amount is formatted correctly for the success screen
  const cleanAmount = String(amount).replace(/[^0-9.]/g, '');
  const val = parseFloat(cleanAmount) || 0;
  const formattedAmount = `KSh ${val.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  res.render("send-money", { 
    user: req.session.user, step: "success", amount: formattedAmount, groupName 
  });
});

router.get("/inbox-status", async (req, res) => {
  try {
    if (!req.session.user) return res.json({ success: true, data: null });
    const phone = req.session.user.phoneNumber;
    const userGroups = [];
    try {
      const groupsFromCollection = await getGroupsForMemberFromGroupsCollection(phone);
      userGroups.push(...groupsFromCollection);
    } catch (e) {
      console.error("[inbox-status] groups collection lookup error:", e.message);
    }
    const constitutionKeys = [];
    const groupMessages = [];
    userGroups.forEach(group => {
      const role = String(group.role || '').toLowerCase();
      const userIsTrusteeInThisGroup = role === 'trustee';

      if (group.messages && Array.isArray(group.messages)) {
        group.messages.forEach(msg => {
          if (msg.to && norm(msg.to) === norm(phone)) {
            groupMessages.push({
              groupName: group.groupName,
              title: msg.title,
              content: msg.content,
              type: msg.type,
              createdAt: msg.createdAt,
              isNew: msg.isNew !== false
            });
          }
        });
      }

      if (group.messages && Array.isArray(group.messages)) {
        group.messages.forEach(msg => {
          if (msg.to && norm(msg.to) === norm(phone)) {
            if (msg.type === 'security_alert' && msg.title === 'Constitution Key') {
              constitutionKeys.push({
                groupName: msg.title || group.groupName,
                key: msg.content,
                type: 'security_alert'
              });
            } else {
              constitutionKeys.push({
                groupName: msg.title || group.groupName,
                type: msg.type,
                content: msg.content,
                isNew: true
              });
            }
          } else if (msg.broadcast && msg.roles && msg.roles.includes('trustee') && userIsTrusteeInThisGroup) {
            constitutionKeys.push({
              groupName: msg.title || group.groupName,
              type: msg.type,
              content: msg.content,
              isNew: true
            });
          }
        });
      }

      if (group.constitutionStartKey && !group.constitutionStartKey.startsWith('$2') && userIsTrusteeInThisGroup) {
        constitutionKeys.push({
          groupName: group.groupName,
          key: group.constitutionStartKey,
          type: 'legacy'
        });
      }
    });

    // Fetch messages from MongoDB messages collection (mirrors main dashboard route)
    try {
      const mongoMessages = await getMessagesForUser(phone);
      mongoMessages.forEach(msg => {
        if (msg.type === 'security_alert' && msg.title === 'Constitution Key' && msg.key) {
          constitutionKeys.push({
            groupName: msg.groupName,
            key: msg.key,
            type: 'security_alert'
          });
        } else if (msg.to && norm(msg.to) === norm(phone)) {
          constitutionKeys.push({
            _id: msg._id,
            groupName: msg.title || 'Notification',
            type: msg.type,
            content: msg.content,
            meta: msg.meta,
            isNew: true
          });
        }
      });
    } catch (e) {
      console.error("[inbox-status] Error fetching messages from MongoDB:", e.message);
    }

    let pendingOfficerMessage = null;
    if (req.session.user && req.session.user.phoneNumber) {
      pendingOfficerMessage = await getPendingOfficerMessageByPhone(req.session.user.phoneNumber);
    }
    res.json({
      success: true,
      data: {
        constitutionKeys,
        groupMessages,
        user: req.session.user,
        pendingOfficerMessage
      }
    });
  } catch (err) {
    res.json({ success: true, data: null });
  }
});

// POST /accept-agent-invite - candidate accepts the agent appointment
router.post("/accept-agent-invite", async (req, res) => {
  try {
    if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
      return res.json({ success: false, message: "Session expired. Please log in again." });
    }
    const phone = normalizePhone(req.session.user.phoneNumber);
    await Agent.findOneAndUpdate({ phoneNumber: phone }, { $set: { accepted: true } });
    const { msgId } = req.body || {};
    if (msgId) {
      await Message.deleteOne({ _id: msgId });
    }
    res.json({ success: true });
  } catch (e) {
    console.error("[accept-agent-invite] error:", e.message);
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;