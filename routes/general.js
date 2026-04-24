const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const generalFile = path.join(__dirname, "../general.json");
const notification = require("../notification/notification");
const perfLogger = require("../performance/group-performance");

/* ================= HELPERS ================= */
const readJSON = (file, fallback) => {
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
 * Restructures flat group data into hierarchy:
 * County -> Constituency -> Ward -> [Groups]
 */
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
  return structured;
};

/**
 * Flattens hierarchical data back to array for frontend compatibility
 */
const flattenData = (data) => {
  if (Array.isArray(data)) return data;
  const flat = [];
  for (const county in data) {
    if (county === 'performance') continue;
    for (const constituency in data[county]) {
      if (constituency === 'performance') continue;
      const items = data[county][constituency];
      if (Array.isArray(items)) {
        let currentWard = "Unknown Ward";
        items.forEach(item => {
          if (typeof item === 'string') {
            currentWard = item;
          } else if (typeof item === 'object' && item !== null && !item.isPerformance) {
            flat.push({
              ...item,
              county,
              constituency,
              ward: currentWard
            });
          }
        });
      }
    }
  }
  return flat;
};

/* ================= ROUTES ================= */

/* 📋 General Form (GET) */
router.get("/", (req, res) => {
  let raw = readJSON(generalFile, {});
  
  // Auto-migrate if array is detected
  if (Array.isArray(raw)) {
    raw = restructureData(raw);
    writeJSON(generalFile, raw);
  }

  let allGroups = flattenData(raw);
  const isCreation = req.query.mode === 'create';

  let selectedGroup = null;
  if (req.query.groupName) {
    selectedGroup = allGroups.find(g => g.groupName === req.query.groupName);
    
    if (selectedGroup) {
      // --- Restructure Display Data for View ---
      
      // 1. Load User Registry for Name Lookup
      const usersFile = path.join(__dirname, "../data.json");
      const users = readJSON(usersFile, []);
      const getUserName = (phone) => {
          const u = users.find(user => norm(user.phoneNumber) === norm(phone));
          return u ? `${u.FirstName} ${u.MiddleName || ''} ${u.LastName}`.replace(/\s+/g, ' ').trim() : null;
      };

      // 2. Consolidate Members List
      // Create a clean array of members from the disparate trustee_x, official_x, member_x keys
      selectedGroup.members = [];
      const memberKeys = Object.keys(selectedGroup).filter(k => k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_'));
      
      memberKeys.forEach(key => {
          const item = selectedGroup[key];
          if (item && typeof item === 'object' && item.phone) {
              const name = item.name || getUserName(item.phone) || "Unknown Name";
              selectedGroup.members.push({
                  name: name,
                  phone: item.phone,
                  role: item.type || 'member',
                  title: item.title || item.type || 'Member',
                  id: item.id || ''
              });
          }
      });

      // Sort: Trustees first, then Officials, then Members
      const roleOrder = { 'trustee': 1, 'official': 2, 'member': 3 };
      selectedGroup.members.sort((a, b) => (roleOrder[a.role] || 4) - (roleOrder[b.role] || 4));

      // 3. Generate Display Stats
      const now = new Date();
      const created = new Date(selectedGroup.createdAt || now);
      const diffTime = Math.abs(now - created);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      
      selectedGroup.summaryStats = {
         activeRound: Math.ceil(diffDays / 7) || 1,
         daysUntilMeeting: 7 - (diffDays % 7),
         totalMembers: selectedGroup.members.length
      };

      // 4. Pin Status
      selectedGroup.pinIsSet = !!selectedGroup.constitutionStartKey;
      // --- End Restructure ---
    }
  }
  
  // Pass flat list to frontend for dropdowns etc.
  res.render("general_new", {
    groups: allGroups,
    isCreation,
    selectedGroup,
    user: req.session ? req.session.user : null,
  });
});

/* 🔍 Verify Chairperson & Get TBank Config (POST) */
router.post("/verify", (req, res) => {
  const { chairpersonalphonenumber, groupName } = req.body;
  const tbankFile = path.join(__dirname, "../tbank.json");

  let accounts = readJSON(generalFile, {});
  // Ensure structure
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
    writeJSON(generalFile, accounts);
  }

  const flatAccounts = flattenData(accounts);
  const tbankData = readJSON(tbankFile, null);

  // 1. Verify Phone AND Group Match
  const account = flatAccounts.find(
    (acc) =>
      acc.groupName === groupName &&
      (acc.chairpersonalphonenumber === chairpersonalphonenumber ||
        acc.phone === chairpersonalphonenumber),
  );

  if (!account) {
    return res.json({
      success: false,
      message: "Chairperson phone number does not match the selected group.",
    });
  }

  // 2. Check TBank Completion
  if (
    !tbankData ||
    !tbankData.compliance ||
    tbankData.compliance.completed !== true
  ) {
    return res.json({
      success: false,
      message: "T-Bank compliance not completed.",
    });
  }

  // 3. Return Counts and Fees
  const { trustees, officials, members, maxMembers } =
    tbankData.compliance.membership;
  const { newGroupFee, renewalFee } = tbankData.compliance.registration;

  return res.json({
    success: true,
    counts: {
      trustees: parseInt(trustees) || 0,
      officials: parseInt(officials) || 0,
      members: parseInt(members) || 0,
      maxMembers: parseInt(maxMembers) || 100,
    },
    fees: {
      newGroup: parseFloat(newGroupFee) || 0,
      renewal: parseFloat(renewalFee) || 0,
    },
  });
});

/* 💳 Confirm Payment & Setup Registration Form (POST) */
router.post("/confirm-payment", (req, res) => {
  const { paymentMethod, totalMembers } = req.body;
  const tbankFile = path.join(__dirname, "../tbank.json");
  const tbankData = readJSON(tbankFile, null);

  if (!tbankData || !tbankData.compliance) {
      return res.json({ success: false, message: "Compliance data unavailable." });
  }

  // 1. Validate Payment
  if (!['agent', 'mpesa'].includes(paymentMethod)) {
      return res.json({ success: false, message: "Invalid payment method selected." });
  }

  // 2. Calculate Counts
  const { trustees, officials, maxMembers, members: defaultMembers } = tbankData.compliance.membership;
  const tCount = parseInt(trustees) || 0;
  const oCount = parseInt(officials) || 0;
  const max = parseInt(maxMembers) || 40;

  let mCount = parseInt(defaultMembers) || 0;

  if (totalMembers) {
      const total = parseInt(totalMembers);
      if (total > max) {
          return res.json({ success: false, message: `Total members cannot exceed ${max}.` });
      }
      if (total < (tCount + oCount)) {
          return res.json({ success: false, message: `Total must include at least ${tCount} trustees and ${oCount} officials.` });
      }
      mCount = total - tCount - oCount;
  }

  return res.json({
    success: true,
    counts: {
      trustees: tCount,
      officials: oCount,
      members: mCount
    }
  });
});

/* ⚙️ Get TBank Config (for new group form) */
router.get("/tbank-config", (req, res) => {
  const tbankFile = path.join(__dirname, "../tbank.json");
  const tbankData = readJSON(tbankFile, null);

  // Check TBank Completion
  if (
    !tbankData ||
    !tbankData.compliance ||
    tbankData.compliance.completed !== true
  ) {
    return res.json({
      success: false,
      message: "T-Bank compliance not completed by HQ.",
    });
  }

  // Return Counts
  const { trustees, officials, members, maxMembers } =
    tbankData.compliance.membership;
  
  return res.json({
    success: true,
    counts: {
      trustees: parseInt(trustees) || 0,
      officials: parseInt(officials) || 0,
      members: parseInt(members) || 0,
      maxMembers: parseInt(maxMembers) || 100,
    }
  });
});

/* ✅ Verify Member Phone Numbers against data.json (POST) */
/**
 * Combined and robust member verification route
 */
router.post("/verify-members", (req, res) => {
  try {
    const { members, phoneNumbers } = req.body;
    const inputList = members || phoneNumbers || [];
    
    if (!Array.isArray(inputList)) {
      return res.status(400).json({ success: false, message: "Invalid payload format" });
    }

    const dataFile = path.join(__dirname, "../data.json");
    const userData = readJSON(dataFile, []);
    const generalData = readJSON(generalFile, {});

    // Build a map of phone numbers from all groups in general.json for cross-referencing
    const generalMembersMap = new Map();
    const flattenForSearch = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach(key => {
        if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
          const m = obj[key];
          if (m && typeof m === 'object' && m.phone) {
            const normalized = norm(m.phone);
            if (!generalMembersMap.has(normalized)) {
              generalMembersMap.set(normalized, {
                name: m.name || m.title || "Group Member",
                id: m.id || null,
                memberNumber: m.memberNumber || null
              });
            }
          }
        }
      });
    };

    // Traverse the hierarchy (supports both hybrid array and object structures)
    for (const county in generalData) {
      if (county === 'performance') continue;
      const constituencies = generalData[county];
      for (const constituency in constituencies) {
        const wardsOrGroups = constituencies[constituency];
        if (Array.isArray(wardsOrGroups)) {
          wardsOrGroups.forEach(item => {
            if (typeof item === 'object' && item !== null && !item.isPerformance) flattenForSearch(item);
          });
        } else if (typeof wardsOrGroups === 'object') {
          for (const ward in wardsOrGroups) {
            const list = wardsOrGroups[ward];
            if (Array.isArray(list)) {
              list.forEach(g => { if (typeof g === 'object') flattenForSearch(g); });
            }
          }
        }
      }
    }

    const results = inputList.map(member => {
      const phone = member.phone || member.phoneNumber;
      const id = member.id || member.idNumber;
      const normalized = norm(phone);
      
      const user = userData.find(u => norm(u.phoneNumber) === normalized);
      
      let resMember = {
        ...member,
        verified: false,
        name: "Not Found",
        status: "not-found"
      };

      if (user) {
        const fullName = [user.FirstName, user.MiddleName, user.LastName].filter(Boolean).join(' ');
        const idMatch = id && String(user.idNumber).trim() === String(id).trim();
        resMember.name = fullName;
        resMember.verified = idMatch || false;
        resMember.status = idMatch ? "verified" : (id ? "mismatch" : "partial");
      } else {
        const gen = generalMembersMap.get(normalized);
        if (gen) {
          resMember.name = gen.name;
          resMember.verified = id && gen.id && String(gen.id).trim() === String(id).trim() || false;
          resMember.status = resMember.verified ? "verified" : "mismatch";
          resMember.source = "general";
        }
      }
      return resMember;
    });

    return res.json({ success: true, results, members: results });
  } catch (err) {
    console.error("Verification Error:", err);
    return res.status(500).json({ success: false, message: "Server error during verification" });
  }
});

/* 💾 Save General Account (POST) */
router.post("/", (req, res) => {
  const {
    groupName,
    chairpersonalphonenumber,
    firstName,
    secondName,
    lastName,
    county,
    constituency,
    ward,
    // New fields from the form
    trustees,
    officials,
    members,
    totalProposedMembers
  } = req.body;

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  if (!groupName || !chairpersonalphonenumber || !firstName || !county || !constituency || !ward) {
    return res.status(400).send("Missing required fields (Check county, constituency, and ward).");
  }

  const newAccount = {
    groupName,
    phone: chairpersonalphonenumber,
    firstName,
    secondName,
    lastName,
    processorPhone: req.session?.user?.phoneNumber || "Anonymous",
    createdAt: new Date().toISOString(),
    totalProposedMembers: parseInt(totalProposedMembers) || 0,
    phase: 1 // Initial phase
  };

  // Centralized Notification Service - Pass location data explicitly since it's not stored in newAccount
  const { notificationContent } = notification.sendGroupCreationAlerts({
    ...newAccount,
    ward,
    constituency,
    county
  }, req.session?.user?.phoneNumber);

  // 1. Chairperson is always trustee_1
  newAccount.trustee_1 = {
      phone: chairpersonalphonenumber,
      type: 'trustee',
      title: 'Chairperson'
  };

  // 2. Add other trustees
  if (Array.isArray(trustees)) {
      trustees.slice(0, 2).forEach((t, i) => {
          if (t && t.phone && t.name) {
              newAccount[`trustee_${i + 2}`] = { phone: t.phone, name: t.name, id: t.id || null, type: 'trustee' };
          }
      });
  }

  // 3. Add officials
  if (Array.isArray(officials)) {
      officials.slice(0, 3).forEach((o, i) => {
          if (o && o.phone && o.name) {
              newAccount[`official_${4 + i}`] = { phone: o.phone, name: o.name, id: o.id || null, type: 'official' };
          }
      });
  }

  // 4. Add members
  if (Array.isArray(members)) {
      members.forEach((m, i) => {
          if (m && m.phone && m.name) {
              newAccount[`member_${7 + i}`] = { phone: m.phone, name: m.name, id: m.id || null, type: 'member' };
          }
      });
  }

  if (!accounts[county]) accounts[county] = {};
  if (!accounts[county][constituency]) accounts[county][constituency] = [];

  // Remove redundant location fields (county, constituency, and ward) as they are already in the hierarchy
  const { county: _co, constituency: _cn, ward: _wd, ...accountToSave } = newAccount;

  const constituencyArray = accounts[county][constituency];
  let wardIndex = constituencyArray.findIndex(item => typeof item === 'string' && item.toLowerCase() === ward.toLowerCase());

  if (wardIndex === -1) {
    // Ward doesn't exist, append ward name then the group
    constituencyArray.push(ward);
    constituencyArray.push(accountToSave);
  } else {
    // Ward exists, find the position of the last group in this ward
    let insertIndex = wardIndex + 1;
    while (insertIndex < constituencyArray.length && typeof constituencyArray[insertIndex] === 'object') {
      insertIndex++;
    }
    constituencyArray.splice(insertIndex, 0, accountToSave);
  }

  // Log Performance (New Group Created in Phase 1)
  perfLogger.logActivity(county, constituency, ward, 1);

  writeJSON(generalFile, accounts);

  // Return a success view with the message
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Submission Successful</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #0f172a, #1e293b); color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .success-card { background: white; color: #1e293b; padding: 40px; border-radius: 24px; text-align: center; max-width: 400px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
        .icon-box { background: #dcfce7; color: #16a34a; width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 40px; }
        h2 { margin: 0 0 12px; font-weight: 800; color: #0f172a; }
        p { color: #64748b; font-size: 0.95rem; line-height: 1.6; margin-bottom: 24px; }
        .btn { display: inline-block; background: #0f9d58; color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 700; transition: all 0.3s; width: 100%; box-sizing: border-box; }
        .btn:hover { background: #0b7d46; transform: translateY(-2px); }
      </style>
    </head>
    <body>
      <div class="success-card">
        <div class="icon-box"><i class="fas fa-check"></i></div>
        <h2>Group Creation</h2>
        <p>${notificationContent}</p>
        <p>Please wait for agent response. This notice has been posted to your inbox.</p>
        <a href="/personal" class="btn">Back to Wallet</a>
      </div>
    </body>
    </html>
  `);
});

/* 📝 Update Group Members (Agent Submission) */
router.post("/update-members", (req, res) => {
  const {
    groupName,
    chairpersonalphonenumber,
    membersData,
    totalProposedMembers,
  } = req.body;

  if (!groupName || !chairpersonalphonenumber) {
    return res.json({
      success: false,
      message: "Missing group identification.",
    });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
    // Check for phase graduation
  if (updatedAccount.phase !== targetGroup.phase) {
    const allGroups = flattenData(accounts);
    const self = allGroups.find(g => g.groupName === groupName);
    if (self) {
      perfLogger.logActivity(self.county, self.constituency, self.ward, updatedAccount.phase, true, targetGroup.phase);
    }
  }

  writeJSON(generalFile, accounts);
  }

  let targetGroup = null;
  let locationPath = null;

  outer: for (const c in accounts) {
    for (const consti in accounts[c]) {
      const list = accounts[c][consti];
      if (Array.isArray(list)) {
        const idx = list.findIndex(
          (acc) =>
            typeof acc === 'object' && acc !== null &&
            acc.groupName === groupName &&
            (acc.chairpersonalphonenumber === chairpersonalphonenumber ||
              acc.phone === chairpersonalphonenumber),
        );
        if (idx !== -1) {
          targetGroup = list[idx];
          locationPath = { c, consti, idx };
          break outer;
        }
      }
    }
  }

  if (!targetGroup) {
    return res.json({
      success: false,
      message: "Group not found or verification failed.",
    });
  }

  const updatedAccount = {
    ...targetGroup,
    ...membersData,
    membersPopulatedAt: new Date().toISOString(),
    agentProcessed: req.session?.user?.phoneNumber || "Unknown",
  };

  const actualPeopleCount = Object.keys(updatedAccount).filter(
    (key) =>
      key.startsWith("trustee_") ||
      key.startsWith("official_") ||
      key.startsWith("member_"),
  ).length;

  const totalProposed = parseInt(totalProposedMembers) || 0;

  if (totalProposed > 0) {
    updatedAccount.totalProposedMembers = totalProposed;
    if (actualPeopleCount < totalProposed) {
      updatedAccount.phase = 1;
    } else {
      updatedAccount.phase = 2;
    }
  } else {
    updatedAccount.phase = 2;
  }

  // --- Notification Logic using Centralized Service ---
  const agentPhone = req.session?.user?.phoneNumber || "Unknown";
  let agentName = "System Agent";
  try {
    const agentFile = path.join(__dirname, "../agent.json");
    if (fs.existsSync(agentFile)) {
      const agents = JSON.parse(fs.readFileSync(agentFile, "utf8"));
      const foundAgent = agents.find(a => notification.norm(a.phoneNumber) === notification.norm(agentPhone));
      if (foundAgent) agentName = foundAgent.name;
    }
  } catch (e) {
    console.error("Error looking up agent name:", e);
  }

  notification.sendMemberAddedNotices(updatedAccount, membersData, agentName, agentPhone);
  // --- End Notification Logic ---

  // Check for phase graduation (Member Update might graduate from Phase 1 to Phase 2)
  if (updatedAccount.phase !== targetGroup.phase) {
      perfLogger.logActivity(locationPath.c, locationPath.consti, targetGroup.ward || "Unknown", updatedAccount.phase, true, targetGroup.phase);
  }

  accounts[locationPath.c][locationPath.consti][locationPath.idx] = updatedAccount;

  writeJSON(generalFile, accounts);

  return res.json({
    success: true,
    message: "Group members updated successfully!",
  });
});

// ✅ Save Group Principles (financial rules set by Trustee)
router.post("/set-principles", (req, res) => {
  const { groupName, principles } = req.body;
  if (!groupName || !principles) return res.json({ success: false, message: "Missing data" });

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) accounts = restructureData(accounts);

  let targetGroup = null;
  let locationPath = null;

  outer: for (const c in accounts) {
    for (const consti in accounts[c]) {
      const list = accounts[c][consti];
      if (Array.isArray(list)) {
        let currentWard = "Unknown Ward";
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (typeof item === 'string') {
            currentWard = item;
          } else if (typeof item === 'object' && item !== null && item.groupName === groupName) {
            targetGroup = item;
            locationPath = { c, consti, idx: i, w: currentWard };
            break outer;
          }
        }
      }
    }
  }

  if (!targetGroup) return res.json({ success: false, message: "Group not found" });

  const locationsFile = path.join(__dirname, "../locations.json");
  const locationsData = readJSON(locationsFile, {});
  
  let countyIdx = 0;
  let globalConstiIdx = 0;
  let globalWardIdx = 0;
  
  let foundCounty = false, foundConsti = false, foundWard = false;
  
  const counties = Object.keys(locationsData);
  for (let c = 0; c < counties.length; c++) {
    const cName = counties[c];
    if (!foundCounty) countyIdx++;
    if (cName === locationPath.c) foundCounty = true;
    
    const constituencies = Object.keys(locationsData[cName]);
    for (let cn = 0; cn < constituencies.length; cn++) {
      const cnName = constituencies[cn];
      if (!foundConsti) globalConstiIdx++;
      if (cName === locationPath.c && cnName === locationPath.consti) foundConsti = true;
      
      const wardObj = locationsData[cName][cnName];
      const wards = Array.isArray(wardObj) ? wardObj : (wardObj.wards || []);
      for (let w = 0; w < wards.length; w++) {
        const wName = wards[w];
        if (!foundWard) globalWardIdx++;
        if (cName === locationPath.c && cnName === locationPath.consti && wName === locationPath.w) foundWard = true;
      }
    }
  }

  const accountNumber = "254" + 
                       countyIdx.toString().padStart(3, '0') + 
                       globalConstiIdx.toString().padStart(3, '0') + 
                       globalWardIdx.toString().padStart(4, '0') + 
                       (locationPath.idx + 1).toString().padStart(3, '0');

  // Check for phase graduation (Set Principles graduates group to Phase 3)
  if (targetGroup.phase !== 3) {
      perfLogger.logActivity(locationPath.c, locationPath.consti, locationPath.w, 3, true, targetGroup.phase);
  }

  accounts[locationPath.c][locationPath.consti][locationPath.idx].principles = principles;
  accounts[locationPath.c][locationPath.consti][locationPath.idx].principlesSetAt = new Date().toISOString();
  accounts[locationPath.c][locationPath.consti][locationPath.idx].phase = 3;
  accounts[locationPath.c][locationPath.consti][locationPath.idx].accountNumber = accountNumber;
  accounts[locationPath.c][locationPath.consti][locationPath.idx].pin = targetGroup.constitutionStartKey || null;

  writeJSON(generalFile, accounts);

  const totalMembers = Object.keys(targetGroup).filter(k => 
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  ).length;

  res.json({ 
    success: true, 
    accountNumber, 
    groupName: targetGroup.groupName,
    totalMembers 
  });
});

// JSON endpoints for client-side consumption
// GET /general/groups -> returns all groups
router.get("/groups", (req, res) => {
  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
    writeJSON(generalFile, accounts);
  }
  res.json(flattenData(accounts));
});

// GET /general/my-groups -> returns groups where user is a member
router.get("/my-groups", (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;
  
  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const allGroups = flattenData(accounts);
  const userGroups = [];

  for (const group of allGroups) {
    for (const key in group) {
      if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
        const memberInfo = group[key];
        const memberPhone = memberInfo ? String(memberInfo.phone || "").trim() : "";
        
        if (memberPhone && norm(memberPhone) === norm(userPhone)) {
          // Find assigned agent
          const agentFile = path.join(__dirname, "../agent.json");
          const agents = readJSON(agentFile, []);
          const matchedAgent = agents.find(a => 
             String(a.county || '').trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
             String(a.constituency || '').trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase() &&
             String(a.ward || '').trim().toLowerCase() === String(group.ward || '').trim().toLowerCase()
          ) || agents.find(a => 
             String(a.county || '').trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
             String(a.constituency || '').trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase()
          );

          userGroups.push({
            groupName: group.groupName,
            phone: group.phone,
            role: memberInfo.type || (key.startsWith("trustee_") ? "trustee" : (key.startsWith("official_") ? "official" : "member")),
            roleTitle: memberInfo.title || '',
            phase: parseInt(group.phase) || 1,
            totalProposedMembers: group.totalProposedMembers || 0,
            createdAt: group.createdAt,
            membersPopulatedAt: group.membersPopulatedAt,
            assignedAgentName: matchedAgent ? matchedAgent.name : "To be assigned",
            assignedAgentPhone: matchedAgent ? matchedAgent.phoneNumber : "N/A",
            accountNumber: group.accountNumber || '',
            county: group.county || '',
            constituency: group.constituency || '',
            ward: group.ward || ''
          });
          break;
        }
      }
    }
  }

  res.json({ 
    success: true, 
    groups: userGroups,
    userPhone: userPhone
  });
});

// GET /general/agent-for-group -> returns agent assigned to a group's ward
router.get("/agent-for-group", (req, res) => {
  const { groupName } = req.query;
  if (!groupName) {
    return res.status(400).json({ success: false, message: "Missing groupName" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) accounts = restructureData(accounts);
  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.status(404).json({ success: false, message: "Group not found" });
  }

  const agentFile = path.join(__dirname, "../agent.json");
  const agents = readJSON(agentFile, []);

  // Find agent matching group's county+constituency+ward
  const agent = agents.find(a =>
    String(a.county).trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
    String(a.constituency).trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase() &&
    String(a.ward).trim().toLowerCase() === String(group.ward || '').trim().toLowerCase()
  );

  if (agent) {
    return res.json({ success: true, agentName: agent.name, agentPhone: agent.phoneNumber });
  }

  // No agent in this exact ward - try constituency level
  const constituencyAgent = agents.find(a =>
    String(a.county).trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
    String(a.constituency).trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase()
  );

  if (constituencyAgent) {
    return res.json({ success: true, agentName: constituencyAgent.name, agentPhone: constituencyAgent.phoneNumber, note: 'constituency' });
  }

  return res.json({ success: false, message: "No agent assigned to this area yet" });
});

// POST /general/verify-access
router.post("/verify-access", (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;
  const { groupName, chairpersonPhone } = req.body;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const allGroups = flattenData(accounts);
  
  const userGroups = [];
  for (const group of allGroups) {
    for (const key in group) {
      if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
        const memberInfo = group[key];
        if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
          userGroups.push(group);
          break;
        }
      }
    }
  }

  if (userGroups.length > 0) {
    if (!groupName) {
      return res.json({ 
        success: false, 
        requiresGroupSelection: true,
        message: "Please select a group to verify" 
      });
    }

    const targetGroup = allGroups.find(g => g.groupName === groupName);
    if (!targetGroup) {
      return res.json({ success: false, message: "Group not found" });
    }

    const chairpersonPhoneMatch = targetGroup.phone === chairpersonPhone || 
                                  targetGroup.chairpersonalphonenumber === chairpersonPhone;
    
    if (!chairpersonPhoneMatch) {
      return res.json({ success: false, message: "Chairperson phone does not match the group" });
    }

    return res.json({ 
      success: true, 
      verified: true,
      verificationType: "group",
      groupName: targetGroup.groupName
    });

  } else {
    if (!chairpersonPhone) {
      return res.json({ 
        success: false, 
        requiresGroupSelection: false,
        message: "Please enter your phone number for verification" 
      });
    }

    if (String(chairpersonPhone).trim() !== String(userPhone).trim()) {
      return res.json({ 
        success: false, 
        message: "Phone number does not match your account." 
      });
    }

    return res.json({ 
      success: true, 
      verified: true,
      verificationType: "personal",
      userPhone: userPhone
    });
  }
});

// POST /general/verify-member
router.post("/verify-member", (req, res) => {
  const { groupName } = req.body;
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  if (!groupName) {
    return res.json({ success: false, message: "Group name required" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.json({ success: false, message: "Group not found" });
  }

  let userRole = null;
  let memberInfo = null;

  for (const key in group) {
    if (key.startsWith("trustee_") || key.startsWith("official_")) {
      const info = group[key];
      if (info && String(info.phone).trim() === String(userPhone).trim()) {
        userRole = info.type;
        memberInfo = info;
        break;
      }
    }
  }

  if (!userRole) {
    return res.json({ 
      success: false, 
      message: "You are not authorized to access this group." 
    });
  }

  res.json({ 
    success: true, 
    role: userRole,
    memberInfo: memberInfo,
    groupName: group.groupName
  });
});

// GET /general/users
router.get("/users", (req, res) => {
  const dataFile = path.join(__dirname, "../data.json");
  const users = readJSON(dataFile, []);
  res.json(users);
});

// POST /general/verify-pin
router.post("/verify-pin", async (req, res) => {
  const { groupName, pin } = req.body;
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  if (!groupName || !pin) {
    return res.json({ success: false, message: "Group name and PIN required" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.json({ success: false, message: "Group not found" });
  }

  const bcrypt = require("bcrypt");
  const storedPin = group.constitutionStartKey; // This is now a Bcrypt hash

  if (!storedPin) {
    return res.json({ success: false, message: "PIN not set for this group." });
  }

  try {
    const isValid = await bcrypt.compare(pin, storedPin);
    if (isValid) {
      return res.json({ 
        success: true, 
        verified: true,
        message: "PIN verified successfully" 
      });
    } else {
      return res.json({ 
        success: false, 
        verified: false,
        message: "Invalid PIN." 
      });
    }
  } catch (err) {
    console.error("Bcrypt error:", err);
    return res.json({ success: false, message: "Verification error." });
  }
});

// POST /general/generate-key
router.post("/generate-key", async (req, res) => {
  const { groupName, customKey } = req.body;
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  if (!groupName) {
    return res.json({ success: false, message: "Group name required" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  let targetGroup = null;
  let locationPath = null;

  outer: for (const c in accounts) {
    for (const consti in accounts[c]) {
      for (const w in accounts[c][consti]) {
        const list = accounts[c][consti][w];
        const idx = list.findIndex(acc => acc.groupName === groupName);
        if (idx !== -1) {
          targetGroup = list[idx];
          locationPath = { c, consti, w, idx };
          break outer;
        }
      }
    }
  }

  if (!targetGroup) {
    return res.json({ success: false, message: "Group not found" });
  }

  // Auth check: Is current user a Trustee or Official?
  let isAuthorized = false;
  let currentUserRole = '';
  for (const key in targetGroup) {
    if (key.startsWith("trustee_") || key.startsWith("official_")) {
      const info = targetGroup[key];
      if (info && String(info.phone).trim() === String(userPhone).trim()) {
        isAuthorized = true;
        currentUserRole = info.type;
        break;
      }
    }
  }

  if (!isAuthorized) {
    return res.json({ success: false, message: "You are not authorized" });
  }

  const bcrypt = require("bcrypt");
  const saltRounds = 10;

  let newKey;
  let isCustom = false;
  if (customKey && customKey.length >= 4 && customKey.length <= 6) {
    newKey = customKey;
    isCustom = true;
  } else {
    newKey = Math.floor(100000 + Math.random() * 900000).toString();
  }
  
  const chairpersonPhone = targetGroup.phone || targetGroup.chairpersonalphonenumber;
  const chairpersonName = `${targetGroup.firstName} ${targetGroup.lastName}`;

  // Hash the key for the database
  const hashedKey = await bcrypt.hash(newKey, saltRounds);

  // Update group data
  const groupUpdate = accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx];
  groupUpdate.constitutionStartKey = hashedKey; // Store Bcrypt hash
  groupUpdate.constitutionKeyGeneratedAt = new Date().toISOString();
  groupUpdate.constitutionKeySetBy = userPhone;
  
  // Create structured notifications (stored in a 'messages' array on the group)
  if (!groupUpdate.messages) groupUpdate.messages = [];
  
  const timestamp = new Date().toLocaleString();
  
  // 1. Message for Chairperson (Full Info)
  const chairMsg = {
    to: chairpersonPhone,
    type: 'security_update',
    content: `[Security Update] Your group "${groupName}" is now secured. The new Constitution Key is: ${newKey}. Set by: ${chairpersonName} (${timestamp}).`,
    timestamp: new Date().toISOString()
  };
  
  // 2. Message for Trustees (Notification only)
  const trusteeMsg = {
    broadcast: true,
    roles: ['trustee'],
    type: 'security_alert',
    content: `[Security Alert] A new Secure Group PIN and Security Key have been established for "${groupName}" by Chairperson ${chairpersonName}. Keys have been updated securely. (${timestamp})`,
    timestamp: new Date().toISOString()
  };
  
  groupUpdate.messages.push(chairMsg, trusteeMsg);
  
  writeJSON(generalFile, accounts);

  // In a real app, you would send SMS here
  console.log(`[SMS-CHAIR] Sending to ${chairpersonPhone}: Key is ${newKey}`);
  console.log(`[SMS-TRUSTEES] Notifying trustees that ${chairpersonName} updated security.`);

  res.json({ 
    success: true, 
    message: isCustom ? "PIN created successfully" : "New Security Key generated",
    newKey: isCustom ? "****" : newKey, // Hide custom PIN in response
    chairpersonPhone: chairpersonPhone,
    sent: true
  });
});

// GET /general/user-role-type
router.get("/user-role-type", (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  const allGroups = flattenData(accounts);
  
  let isTrustee = false;
  let isOfficial = false;
  let isMember = false;
  const userGroups = [];

  for (const group of allGroups) {
    let userRoleInGroup = null;
    let userTitleInGroup = null;
    
    // Check if user is the chairperson
    const chairPhone = group.phone || group.chairpersonalphonenumber;
    if (!userRoleInGroup && chairPhone && String(chairPhone).trim() === String(userPhone).trim()) {
      userRoleInGroup = "trustee";
      userTitleInGroup = "Chairperson";
    }
    
    for (const key in group) {
      if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
        const memberInfo = group[key];
        if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
          userTitleInGroup = memberInfo.title || memberInfo.type || "";
          if (key.startsWith("trustee_")) {
            isTrustee = true;
            userRoleInGroup = "trustee";
          } else if (key.startsWith("official_")) {
            isOfficial = true;
            userRoleInGroup = userRoleInGroup || "official";
          } else if (key.startsWith("member_")) {
            isMember = true;
            userRoleInGroup = userRoleInGroup || "member";
          }
        }
      }
    }

    if (userRoleInGroup) {
      // Find assigned agent for this group's location
      const agentFile = path.join(__dirname, "../agent.json");
      const agents = readJSON(agentFile, []);
      const matchedAgent = agents.find(a => 
         String(a.county || '').trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
         String(a.constituency || '').trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase() &&
         String(a.ward || '').trim().toLowerCase() === String(group.ward || '').trim().toLowerCase()
      ) || agents.find(a => 
         String(a.county || '').trim().toLowerCase() === String(group.county || '').trim().toLowerCase() &&
         String(a.constituency || '').trim().toLowerCase() === String(group.constituency || '').trim().toLowerCase()
      );

      // Compute stats
      const now = new Date();
      const created = new Date(group.createdAt || now);
      const diffDays = Math.ceil(Math.abs(now - created) / (1000 * 60 * 60 * 24));
      const activeRound = Math.ceil(diffDays / 7) || 1;

      userGroups.push({
        groupName: group.groupName,
        role: userRoleInGroup,
        roleTitle: userTitleInGroup,
        phone: group.phone,
        phase: group.phase || 1,
        assignedAgentName: matchedAgent ? matchedAgent.name : "To be assigned",
        assignedAgentPhone: matchedAgent ? matchedAgent.phoneNumber : "N/A",
        createdAt: group.createdAt,
        membersPopulatedAt: group.membersPopulatedAt,
        activeRound: activeRound,
        remainRounds: Math.max(0, 52 - activeRound),
        accountNumber: group.accountNumber || '',
        constitutionStartKey: group.constitutionStartKey || ''
      });
    }
  }

  res.json({
    success: true,
    isTrustee,
    isOfficial,
    isMember,
    hasGroupAccount: isTrustee || isOfficial,
    groups: userGroups
  });
});

// POST /general/user-role
router.post("/user-role", (req, res) => {
  const { groupName } = req.body;
  const userPhone = req.session?.user?.phoneNumber;

  if (!groupName || !userPhone) {
    return res.status(400).json({ role: "error", message: "Missing info." });
  }

  const accounts = readJSON(generalFile, {});
  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.status(404).json({ role: "error", message: "Group not found." });
  }

  let userRole = "not_member";

  for (const key in group) {
    if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
      const memberInfo = group[key];
      if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
        userRole = memberInfo.type;
        break;
      }
    }
  }

  res.json({ role: userRole });
});


// GET /general/group/:groupName -> renders group-details.ejs for an active group
router.get("/group/:groupName", (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.redirect("/login");
  }

  const groupName = decodeURIComponent(req.params.groupName);

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
    writeJSON(generalFile, accounts);
  }

  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.render("group-details", { group: null, userRole: null, currentUserPhone: userPhone });
  }

  // Determine logged-in user's role in this group
  let userRole = null;
  for (const key in group) {
    if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
      const info = group[key];
      if (info && String(info.phone).trim() === String(userPhone).trim()) {
        userRole = info.type; // 'trustee' | 'official' | 'member'
        break;
      }
    }
  }

  // If user is not a member of this group, redirect back
  if (!userRole) {
    return res.redirect("/general");
  }

  // Build flat members array for the view
  const usersFile = path.join(__dirname, "../data.json");
  const users = readJSON(usersFile, []);
  const getUserName = (phone) => {
    const u = users.find(user => norm(user.phoneNumber) === norm(phone));
    return u ? `${u.FirstName} ${u.MiddleName || ''} ${u.LastName}`.replace(/\s+/g, ' ').trim() : null;
  };

  group.members = [];
  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  );

  memberKeys.forEach(key => {
    const item = group[key];
    if (item && typeof item === 'object' && item.phone) {
      const name = item.name || getUserName(item.phone) || "Unknown";
      const memberNum = key.replace(/[a-z_]/g, '');
      group.members.push({
        name,
        phone: item.phone,
        role: item.type || 'member',
        title: item.title || item.type || 'Member',
        id: item.id || '',
        memberNumber: memberNum
      });
    }
  });

  // Sort: Trustees first, Officials second, Members last
  const roleOrder = { trustee: 1, official: 2, member: 3 };
  group.members.sort((a, b) => (roleOrder[a.role] || 4) - (roleOrder[b.role] || 4));

  // Compute summary stats
  const now = new Date();
  const created = new Date(group.createdAt || now);
  const diffDays = Math.ceil(Math.abs(now - created) / (1000 * 60 * 60 * 24));

  group.summaryStats = {
    activeRound: Math.ceil(diffDays / 7) || 1,
    daysUntilMeeting: 7 - (diffDays % 7),
    remainRounds: Math.max(0, 52 - Math.ceil(diffDays / 7)),
    totalMembers: group.members.length
  };

  // PIN status for Group Account tab
  group.pinIsSet = !!group.constitutionStartKey;

  return res.render("group-details", { group, userRole, currentUserPhone: userPhone });
});

// Redundant verify-members removed (Consolidated at line 310)

/* 📥 API: Track Form Download */
router.post("/api/form-download-log", (req, res) => {
  try {
    const { groupName, formRef, year, userPhone, latitude, longitude, address } = req.body;
    
    if (!groupName || !formRef) {
      return res.status(400).json({ error: "Missing groupName or formRef" });
    }

    const allData = readJSON(generalFile, {});
    
    // Search through nested structure: County > Constituency > Ward > Groups
    let groupFound = false;
    let groupUpdated = false;
    
    for (const county in allData) {
      for (const constituency in allData[county]) {
        const wards = allData[county][constituency];
        if (Array.isArray(wards)) {
          for (let i = 0; i < wards.length; i++) {
            const group = wards[i];
            if (group.groupName && group.groupName.toLowerCase() === groupName.toLowerCase()) {
              groupFound = true;
              
              // Initialize formDownloads array if not exists
              if (!group.formDownloads) {
                group.formDownloads = [];
              }

              // Calculate sequence
              const totalDownloads = group.formDownloads.length;
              const sequenceByUser = (totalDownloads + 1) + '-' + (userPhone || 'unknown');
              const newDownload = {
                downloadId: totalDownloads + 1,
                timestamp: new Date().toISOString(),
                formRef: formRef,
                sequenceNumber: totalDownloads + 1,
                sequenceByUser: sequenceByUser,
                totalDownloads: totalDownloads + 1,
                location: latitude && longitude ? {
                  latitude: latitude,
                  longitude: longitude,
                  address: address || "Unknown"
                } : null
              };

              // Add to download history
              group.formDownloads.push(newDownload);
              groupUpdated = true;
              break;
            }
          }
        }
        if (groupUpdated) break;
      }
      if (groupUpdated) break;
    }
    
    if (!groupFound) {
      return res.status(404).json({ error: "Group not found: " + groupName });
    }

    // Save back to file
    writeJSON(generalFile, allData);

    console.log(`✓ Form download logged for ${groupName}: ${formRef}`);

    return res.json({ 
      success: true, 
      message: "Download logged successfully",
      download: newDownload
    });
  } catch (err) {
    console.error("Error in /api/form-download-log:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* 📥 API: Get Form Download History */
router.get("/api/form-downloads/:groupName", (req, res) => {
  try {
    const { groupName } = req.params;
    const allData = readJSON(generalFile, {});
    
    let groupFound = null;
    
    // Search through nested structure
    for (const county in allData) {
      for (const constituency in allData[county]) {
        const wards = allData[county][constituency];
        if (Array.isArray(wards)) {
          for (const group of wards) {
            if (group.groupName && group.groupName.toLowerCase() === groupName.toLowerCase()) {
              groupFound = group;
              break;
            }
          }
        }
        if (groupFound) break;
      }
      if (groupFound) break;
    }
    
    if (!groupFound) {
      return res.status(404).json({ error: "Group not found" });
    }

    return res.json({ 
      success: true, 
      formDownloads: groupFound.formDownloads || [],
      totalDownloads: groupFound.formDownloads ? groupFound.formDownloads.length : 0
    });
  } catch (err) {
    console.error("Error in /api/form-downloads:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* 📥 API: Process Group Deductions */
router.post("/api/process-deduction", (req, res) => {
  try {
    const { groupName, deductions } = req.body;
    
    if (!groupName || !deductions || !Array.isArray(deductions) || deductions.length === 0) {
      return res.status(400).json({ error: "Missing groupName or deductions array" });
    }

    const allData = readJSON(generalFile, {});
    let groupFound = null;
    let groupUpdated = false;
    
    // Search through nested structure
    for (const county in allData) {
      for (const constituency in allData[county]) {
        const wards = allData[county][constituency];
        if (Array.isArray(wards)) {
          for (let i = 0; i < wards.length; i++) {
            const group = wards[i];
            if (group.groupName && group.groupName.toLowerCase() === groupName.toLowerCase()) {
              groupFound = group;
              
              // Initialize deductions array if not exists
              if (!group.deductions) {
                group.deductions = [];
              }
              
              // Add each deduction with timestamp
              deductions.forEach(ded => {
                group.deductions.push({
                  id: (group.deductions.length + 1),
                  timestamp: new Date().toISOString(),
                  memberPhone: ded.memberPhone,
                  memberName: ded.memberName,
                  memberAccount: ded.memberAccount,
                  accountType: ded.accountType,
                  amount: parseFloat(ded.amount),
                  note: ded.note || '',
                  processedBy: req.session?.user?.phoneNumber || 'unknown'
                });
              });
              
              groupUpdated = true;
              break;
            }
          }
        }
        if (groupUpdated) break;
      }
      if (groupUpdated) break;
    }
    
    if (!groupFound) {
      return res.status(404).json({ error: "Group not found: " + groupName });
    }

    // Save back to file
    writeJSON(generalFile, allData);

    console.log(`✓ Deductions processed for ${groupName}: ${deductions.length} item(s)`);

    return res.json({ 
      success: true, 
      message: "Deductions processed successfully",
      totalDeductions: groupFound.deductions ? groupFound.deductions.length : 0
    });
  } catch (err) {
    console.error("Error in /api/process-deduction:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* 📥 API: Get Group Deductions */
router.get("/api/group-deductions/:groupName", (req, res) => {
  try {
    const groupName = decodeURIComponent(req.params.groupName);
    const allData = readJSON(generalFile, {});
    let groupFound = null;
    
    for (const county in allData) {
      for (const constituency in allData[county]) {
        const wards = allData[county][constituency];
        if (Array.isArray(wards)) {
          for (const group of wards) {
            if (group.groupName && group.groupName.toLowerCase() === groupName.toLowerCase()) {
              groupFound = group;
              break;
            }
          }
        }
        if (groupFound) break;
      }
      if (groupFound) break;
    }
    
    if (!groupFound) {
      return res.status(404).json({ error: "Group not found" });
    }

    return res.json({ 
      success: true, 
      deductions: groupFound.deductions || [],
      totalDeductions: groupFound.deductions ? groupFound.deductions.length : 0
    });
  } catch (err) {
    console.error("Error in /api/group-deductions:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
