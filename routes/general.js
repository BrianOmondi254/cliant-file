const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const generalFile = path.join(__dirname, "../general.json");

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
    for (const constituency in data[county]) {
      for (const ward in data[county][constituency]) {
        flat.push(...data[county][constituency][ward]);
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
  
  // Pass flat list to frontend for dropdowns etc.
  res.render("general_new", {
    groups: allGroups,
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

/* ✅ Verify Member Phone Numbers against data.json (POST) */
router.post("/verify-members", (req, res) => {
  const { phoneNumbers } = req.body;
  const dataFile = path.join(__dirname, "../data.json");
  const userData = readJSON(dataFile, []);

  const results = phoneNumbers.map((member) => {
    const inputPhone = String(member.phone).trim();
    const inputId = String(member.id).trim();

    const user = userData.find(
      (u) => String(u.phoneNumber).trim() === inputPhone,
    );

    let status = "not-found";
    let foundName = "Not Found";

    if (user) {
      if (String(user.idNumber).trim() === inputId) {
        status = "verified";
        foundName = `${user.FirstName} ${user.LastName}`;
      } else {
        status = "mismatch";
        foundName = "ID does not match Phone";
      }
    }

    return {
      ...member,
      status,
      verified: status === "verified",
      foundName,
    };
  });

  return res.json({ success: true, results });
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
  } = req.body;

  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }

  if (!groupName || !chairpersonalphonenumber || !firstName || !county) {
    return res.status(400).send("Missing required fields.");
  }

  const newAccount = {
    groupName,
    phone: chairpersonalphonenumber,
    firstName,
    secondName,
    lastName,
    county,
    constituency,
    ward,
    processorPhone: req.session?.user?.phoneNumber || "Anonymous",
    createdAt: new Date().toISOString(),
  };

  if (!accounts[county]) accounts[county] = {};
  if (!accounts[county][constituency]) accounts[county][constituency] = {};
  if (!accounts[county][constituency][ward])
    accounts[county][constituency][ward] = [];

  accounts[county][constituency][ward].push(newAccount);

  writeJSON(generalFile, accounts);

  res.redirect("/login?alert=Account%20Created%20Successfully");
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
    writeJSON(generalFile, accounts);
  }

  let targetGroup = null;
  let locationPath = null;

  outer: for (const c in accounts) {
    for (const consti in accounts[c]) {
      for (const w in accounts[c][consti]) {
        const list = accounts[c][consti][w];
        const idx = list.findIndex(
          (acc) =>
            acc.groupName === groupName &&
            (acc.chairpersonalphonenumber === chairpersonalphonenumber ||
              acc.phone === chairpersonalphonenumber),
        );
        if (idx !== -1) {
          targetGroup = list[idx];
          locationPath = { c, consti, w, idx };
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

  accounts[locationPath.c][locationPath.consti][locationPath.w][
    locationPath.idx
  ] = updatedAccount;

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

  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].principles = principles;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].principlesSetAt = new Date().toISOString();
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].phase = 3;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].accountNumber = accountNumber;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].pin = targetGroup.constitutionStartKey || null;
  
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
        if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
          userGroups.push({
            groupName: group.groupName,
            phone: group.phone,
            role: memberInfo.type,
            roleTitle: memberInfo.title || '',
            accountNumber: group.accountNumber || ''
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
    
    for (const key in group) {
      if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
        const memberInfo = group[key];
        if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
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
      userGroups.push({
        groupName: group.groupName,
        role: userRoleInGroup,
        phone: group.phone,
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

module.exports = router;
