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

  if (!groupName || !chairpersonalphonenumber || !firstName || !county) {
    return res.status(400).send("Missing required fields.");
  }

  // 1. Hierarchical official verification
  const agentFile = path.join(__dirname, "../agent.json");
  const dealerFile = path.join(__dirname, "../dealer.json");
  const hqFile = path.join(__dirname, "../hq.json");

  const agents = readJSON(agentFile, []);
  const dealers = readJSON(dealerFile, []);
  const hqs = readJSON(hqFile, []);

  let allocatedOfficial = null;
  let officialType = "";

  // Check Agent
  const agent = agents.find(a => a.ward && a.ward.toLowerCase() === ward.toLowerCase());
  if (agent) {
    allocatedOfficial = agent;
    officialType = "Agent";
  } else {
    // Check Dealer
    const dealer = dealers.find(d => d.ward && d.ward.toLowerCase() === ward.toLowerCase());
    if (dealer) {
      allocatedOfficial = dealer;
      officialType = "Dealer";
    } else {
      // Check Regional Office (HQ) by constituency (regional block)
      const hq = hqs.find(h => h.constituency && h.constituency.toLowerCase() === constituency.toLowerCase());
      if (hq) {
        allocatedOfficial = hq;
        officialType = "Regional Office";
      }
    }
  }

  let notificationContent = "";
  if (allocatedOfficial) {
    const officialPhone = allocatedOfficial.phoneNumber || allocatedOfficial.hqPhone || allocatedOfficial.dealerPhone;
    notificationContent = `Your application for ${groupName} is pending. ${officialType} available at your location. Contact: ${officialPhone}`;
  } else {
    notificationContent = `Your application for ${groupName} is pending. Note: Your regional block is not yet allocated to any of our officials.`;
  }

  const messagesList = [
    {
      to: req.session?.user?.phoneNumber,
      type: "security_alert",
      title: "Group Creation",
      content: notificationContent,
      createdAt: new Date().toISOString()
    }
  ];

  if (allocatedOfficial) {
    const officialPhone = allocatedOfficial.phoneNumber || allocatedOfficial.hqPhone || allocatedOfficial.dealerPhone;
    messagesList.push({
      to: officialPhone,
      type: "security_alert",
      title: "Group Creation",
      content: `Group Creation Request: ${groupName}. Submitted by Processor: ${req.session?.user?.phoneNumber || 'Anonymous'}. Chairperson Phone: ${chairpersonalphonenumber}. Location: ${county}/${constituency}/${ward}. Please verify this request.`,
      createdAt: new Date().toISOString()
    });
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
    messages: messagesList,
    totalProposedMembers: parseInt(totalProposedMembers) || 0,
    phase: 1 // Initial phase
  };

  // Add members from the form
  const STD_TRUSTEES = 3;
  const STD_OFFICIALS = 3;

  // 1. Chairperson is always trustee_1
  newAccount.trustee_1 = {
      phone: chairpersonalphonenumber,
      name: `${firstName} ${secondName || ''} ${lastName}`.trim(),
      type: 'trustee',
      title: 'Chairperson'
  };

  // 2. Add other trustees from the `trustees` array. They will be trustee_2, trustee_3.
  if (Array.isArray(trustees)) {
      trustees.slice(0, STD_TRUSTEES - 1).forEach((t, i) => { // Limit to fill up to trustee_3
          if (t && t.phone && t.name) {
              newAccount[`trustee_${i + 2}`] = {
                  phone: t.phone,
                  name: t.name,
                  id: t.id || null,
                  type: 'trustee'
              };
          }
      });
  }

  // 3. Add officials. They start from index 4.
  if (Array.isArray(officials)) {
      officials.slice(0, STD_OFFICIALS).forEach((o, i) => { // Limit to fill up to official_6
          if (o && o.phone && o.name) {
              newAccount[`official_${STD_TRUSTEES + i + 1}`] = {
                  phone: o.phone,
                  name: o.name,
                  id: o.id || null,
                  type: 'official'
              };
          }
      });
  }

  // 4. Add members. They start from index 7.
  if (Array.isArray(members)) {
      members.forEach((m, i) => {
          if (m && m.phone && m.name) {
              newAccount[`member_${STD_TRUSTEES + STD_OFFICIALS + i + 1}`] = {
                  phone: m.phone,
                  name: m.name,
                  id: m.id || null,
                  type: 'member'
              };
          }
      });
  }

  if (!accounts[county]) accounts[county] = {};
  if (!accounts[county][constituency]) accounts[county][constituency] = {};
  if (!accounts[county][constituency][ward])
    accounts[county][constituency][ward] = [];

  accounts[county][constituency][ward].push(newAccount);

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

  // --- Notification Logic ---
  const agentPhone = req.session?.user?.phoneNumber || "Unknown";
  let agentName = "System Agent";
  try {
    const agentFile = path.join(__dirname, "../agent.json");
    if (fs.existsSync(agentFile)) {
      const agents = JSON.parse(fs.readFileSync(agentFile, "utf8"));
      const foundAgent = agents.find(a => norm(a.phoneNumber) === norm(agentPhone));
      if (foundAgent) agentName = foundAgent.name;
    }
  } catch (e) {
    console.error("Error looking up agent name:", e);
  }

  const messages = updatedAccount.messages || [];
  
  Object.values(membersData).forEach(member => {
    if (member && member.phone) {
      const memberPhone = member.phone;
      const memberType = member.type || "member";
      const memberIndex = member.index || "N/A";
      
      const messageContent = `You have been added to ${groupName}. \n` +
                             `Agent: ${agentName} (${agentPhone})\n` +
                             `Chairperson: ${chairpersonalphonenumber}\n` +
                             `Role: ${memberType.charAt(0).toUpperCase() + memberType.slice(1)}`;

      // Create message for this member
      const newMessage = {
        to: memberPhone,
        type: "group_added",
        title: "Group Registration Notice",
        content: messageContent,
        createdAt: new Date().toISOString(),
        isNew: true
      };

      // Avoid duplicate notifications for the same group in this session
      const alreadyNotified = messages.some(m => 
        m.to === memberPhone && 
        m.type === "group_added" && 
        m.content.includes(groupName)
      );
      
      if (!alreadyNotified) {
        messages.push(newMessage);
      }
    }
  });

  updatedAccount.messages = messages;
  // --- End Notification Logic ---

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
        phase: group.phase || 1, // Added phase tracking
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
    return res.render("group-details", { group: null, userRole: null });
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
      group.members.push({
        name,
        phone: item.phone,
        role: item.type || 'member',
        title: item.title || item.type || 'Member',
        id: item.id || ''
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

  return res.render("group-details", { group, userRole });
});

/* ================= API: Verify Members Against data.json ================= */
router.post("/api/verify-members", (req, res) => {
  try {
    const { members } = req.body;
    
    if (!members || !Array.isArray(members)) {
      return res.status(400).json({ error: "members array is required" });
    }

    console.log(`✓ Received ${members.length} members to verify`);

    // Read data.json to get registered users
    const usersFile = path.join(__dirname, "../data.json");
    const users = readJSON(usersFile, []);
    console.log(`✓ Loaded ${users.length} users from data.json`);
    
    // Read general.json to get group members
    const generalData = readJSON(generalFile, {});
    console.log(`✓ Loaded general.json for group member lookup`);

    // Build a map of phone numbers from general.json groups (trustees, officials, members)
    const generalMembersMap = new Map();
    const flattenForSearch = (obj) => {
      if (!obj) return;
      for (const key of Object.keys(obj)) {
        if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
          const m = obj[key];
          if (m.phone) {
            const normPhone = norm(m.phone);
            if (!generalMembersMap.has(normPhone)) {
              generalMembersMap.set(normPhone, {
                name: m.name || m.title || key,
                id: m.id || null,
                memberNumber: m.memberNumber || null
              });
            }
          }
        }
      }
    };
    
    // Search through all groups in general.json
    for (const county in generalData) {
      const countyData = generalData[county];
      if (countyData && typeof countyData === 'object') {
        for (const constituency in countyData) {
          const constData = countyData[constituency];
          if (constData && typeof constData === 'object') {
            for (const ward in constData) {
              const wardData = constData[ward];
              if (Array.isArray(wardData)) {
                wardData.forEach(group => flattenForSearch(group));
              } else {
                flattenForSearch(wardData);
              }
            }
          }
        }
      }
    }
    console.log(`✓ Built general members map with ${generalMembersMap.size} entries`);

    // Verify each member against data.json and general.json
    const results = members.map(member => {
      const { key, phone, id, role, title, index } = member;
      
      // Normalize phone for comparison
      const normalizedPhone = norm(phone);
      
      // Find matching user in data.json by phone number
      const matchedUser = users.find(u => norm(u.phoneNumber) === normalizedPhone);
      
      let verificationResult = {
        key,
        phone,
        id: id || null,
        role,
        title,
        index,
        name: null,
        verified: false,
        notRegistered: true
      };
      
      if (matchedUser) {
        // Phone found in data.json - get name
        const fullName = `${matchedUser.FirstName} ${matchedUser.MiddleName || ''} ${matchedUser.LastName}`.replace(/\s+/g, ' ').trim();
        
        // Check if ID matches
        const idMatch = id && String(matchedUser.idNumber || '').trim() === String(id).trim();
        
        verificationResult = {
          ...verificationResult,
          name: fullName,
          verified: idMatch,
          notRegistered: false
        };
        
        console.log(`✓ Match in data.json: ${phone} → ${fullName} (ID match: ${idMatch})`);
      } else {
        // Check if member exists in general.json (from any group)
        const generalMember = generalMembersMap.get(normalizedPhone);
        if (generalMember) {
          const fullName = generalMember.name || 'Group Member';
          const idMatch = id && generalMember.id && String(generalMember.id).trim() === String(id).trim();
          
          verificationResult = {
            ...verificationResult,
            name: fullName,
            verified: idMatch || false,
            notRegistered: false,
            source: 'general'
          };
          
          console.log(`✓ Match in general.json: ${phone} → ${fullName} (ID match: ${idMatch})`);
        } else {
          console.log(`✗ Not found: ${phone}`);
        }
      }
      
      return verificationResult;
    });

    console.log(`✓ Verification complete. Returning ${results.length} results`);
    return res.json({ success: true, members: results });
  } catch (err) {
    console.error("Error in /api/verify-members:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

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

module.exports = router;
