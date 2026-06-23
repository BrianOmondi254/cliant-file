const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const generalFile = path.join(__dirname, "../general.json");
const notification = require("../notification/notification");
const perfLogger = require("../performance/group-performance");
const regPerfLogger = require("../performance/registration-performance");
const { saveGeneralGroupToMongo, isGroupNameAvailableInMongo, cleanupStaleGroupKeys, fixGroupKeyIndex, mongoose, findGeneralGroupsByMemberPhone } = require("../mongoose");

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

/* ================= MEMBER REQUEST HELPERS ================= */

const normalizeKenyanPhone = (p = "") => {
  let digits = String(p).replace(/\D/g, "");
  if (digits.startsWith("254")) digits = digits.substring(3);
  if (digits.startsWith("0")) digits = digits.substring(1);
  if (digits.length > 9) digits = digits.slice(-9);
  return digits;
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

const getMemberMetaFromGeneralGroupByName = (group, memberName) => {
  const wanted = String(memberName || "").trim().toLowerCase();
  if (!group || !wanted) return { index: "", memberNumber: "", phone: "" };

  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
  );

  for (const key of memberKeys) {
    const person = group[key];
    const personName = String(person && person.name ? person.name : "").trim().toLowerCase();
    if (personName && personName === wanted) {
      return {
        index: person.index || "",
        memberNumber: person.memberNumber || "",
        phone: person.phone || ""
      };
    }
  }

  return { index: "", memberNumber: "", phone: "" };
};

const defaultMemberStructure = () => ({
  group: {}
});

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
  const memberData = defaultMemberStructure();

  if (!memberData.group) {
    memberData.group = {};
  }

  allGroups.forEach(group => {
    const groupName = group.groupName;
    if (!groupName) return;

    const memberKeys = Object.keys(group).filter(k =>
      k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
    );

    const membersObj = {};
    memberKeys.forEach(key => {
      const item = group[key];
      if (item && item.phone) {
        const memberName = getUserName(item.phone) || item.title || key.replace(/_/g, ' ').replace(/(\d+)/, '#$1');

        membersObj[item.phone] = {
          memberId: item.phone,
          name: memberName,
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
    });

    if (memberData.group[groupName]) {
      Object.keys(membersObj).forEach(phone => {
        if (!memberData.group[groupName].members[phone]) {
          memberData.group[groupName].members[phone] = membersObj[phone];
        } else if (membersObj[phone].name) {
          memberData.group[groupName].members[phone].name = membersObj[phone].name;
        }
      });
    } else {
      let foundKey = Object.keys(memberData.group).find(k => memberData.group[k].groupName === groupName);
      if (foundKey) {
        Object.keys(membersObj).forEach(phone => {
          if (!memberData.group[foundKey].members[phone]) {
            memberData.group[foundKey].members[phone] = membersObj[phone];
          } else if (membersObj[phone].name) {
            memberData.group[foundKey].members[phone].name = membersObj[phone].name;
          }
        });
      } else {
        const groupNum = Object.keys(memberData.group).length + 1;
        const accountNum = group.accountNumber || "ACC" + groupNum;
        memberData.group[accountNum] = {
          groupNumber: groupNum,
          groupName: groupName,
          groupFinancials: {
            totalOpeningBalance: 0,
            totalAmountIn: 0,
            totalAmountOut: 0,
            totalClosingBalance: 0,
            availableWithdrawalBalance: 0
          },
          accountSchema: {
            "001": { accountId: "001", accountName: "Saving", expectedAmount: "100" },
            "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
            "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
            "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
          },
          members: membersObj
        };
      }
    }
  });

  // No longer writing to member.json - only using general.json
};

/* ================= ROUTES ================= */

/* 🔒 Auth middleware for protected routes */
router.use((req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  next();
});

/* 📋 General Form (GET) */
router.get("/", (req, res) => {
  let raw = readJSON(generalFile, {});
  const phone = req.session.user && req.session.user.phoneNumber;
  
  // Auto-migrate if array is detected
  if (Array.isArray(raw)) {
    raw = restructureData(raw);
    writeJSON(generalFile, raw);
  }

  let allGroups = flattenData(raw);
  let isCreation = req.query.mode === 'create';

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
  // Determine if user is agent or dealer for navigation
  const agentFile = path.join(__dirname, "../agent.json");
  const dealerFile = path.join(__dirname, "../dealer.json");
  const agents = readJSON(agentFile, []);
  const dealers = readJSON(dealerFile, []);

  const checkItem = (item, phone) => {
    if (!item) return false;
    let itemPhone = "";
    if (typeof item === 'string') itemPhone = item;
    else if (item.phoneNumber) itemPhone = item.phoneNumber;
    else if (item.phone) itemPhone = item.phone;
    return norm(itemPhone) === norm(phone);
  };

  const searchInFile = (data, phone) => {
    if (!data) return false;
    if (checkItem(data, phone)) return true;
    if (Array.isArray(data)) return data.some(item => searchInFile(item, phone));
    if (typeof data === 'object') {
      const keyMatch = Object.keys(data).some(k => norm(k) === norm(phone));
      if (keyMatch) return true;
      return Object.values(data).some(val => (typeof val === 'object' || Array.isArray(val)) && searchInFile(val, phone));
    }
    return false;
  };

const userPhone = req.session?.user?.phoneNumber;
   const showAgent = userPhone ? searchInFile(agents, userPhone) : false;
   const showDealer = userPhone ? searchInFile(dealers, userPhone) : false;

   // Filter groups to only those the user is a member of
   const userGroups = allGroups.filter(group => {
     for (const key in group) {
       if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
         const item = group[key];
         if (item && typeof item === 'object' && item.phone && norm(item.phone) === norm(userPhone)) {
           return true;
         }
       }
     }
     // Also check top-level phone properties
     if (group.phone && norm(group.phone) === norm(userPhone)) {
       return true;
     }
     return false;
   });

   // If no groups found and not in creation mode, switch to creation mode
   if (userGroups.length === 0 && !isCreation) {
     isCreation = true;
   }

   res.render("general_new", {
     groups: userGroups,
     isCreation,
     selectedGroup,
     user: req.session ? req.session.user : null,
     showAgent,
     showDealer
   });
});

/* 🆕 Create Group Request (POST) — MongoDB only */
router.post("/", async (req, res) => {
  try {
    const {
      groupName,
      chairpersonalphonenumber,
      firstName,
      secondName,
      lastName,
      county,
      constituency,
      ward,
      trustees,
      officials,
      members,
      totalProposedMembers
    } = req.body;

    const cleanGroupName = String(groupName || "").trim();
    const cleanPhone = String(chairpersonalphonenumber || "").trim();

    if (!cleanGroupName || !cleanPhone || !county || !constituency || !ward) {
      if (req.headers['content-type'] === 'application/json') {
        return res.status(400).json({ success: false, message: "Missing required fields. Please fill in all details." });
      }
      return res.status(400).send("Missing required fields (Check county, constituency, and ward).");
    }

    if (!firstName || !lastName) {
      if (req.headers['content-type'] === 'application/json') {
        return res.json({ success: false, message: "Chairperson full name is required." });
      }
      return res.status(400).send("Chairperson full name is required.");
    }

    // Check if group name already exists
    const availability = await isGroupNameAvailableInMongo(cleanGroupName);
    if (availability.unavailable) {
      if (req.headers['content-type'] === 'application/json') {
        return res.json({ success: false, message: availability.message || "Database is currently unavailable. Please try again shortly." });
      }
      return res.status(503).send(availability.message || "Database is currently unavailable.");
    }
    if (availability.exists) {
      if (req.headers['content-type'] === 'application/json') {
        return res.json({ success: false, message: "Group name already exists. Please choose a different name." });
      }
      return res.status(400).send("Group name already exists. Please choose a different name.");
    }

    const nowIso = new Date().toISOString();
    const groupData = {
      groupName: cleanGroupName,
      chairpersonalphonenumber: cleanPhone,
      phone: cleanPhone,
      firstName: String(firstName || "").trim(),
      secondName: String(secondName || "").trim(),
      lastName: String(lastName || "").trim(),
      county: String(county).trim(),
      constituency: String(constituency).trim(),
      ward: String(ward).trim(),
      phase: 1,
      totalProposedMembers: parseInt(totalProposedMembers) || 0,
      createdAt: nowIso,
      createdBy: req.session?.user?.phoneNumber || "unknown",
    };

    // Sync to MongoDB first
    const mongoResult = await saveGeneralGroupToMongo(groupData);
    if (!mongoResult) {
      return res.status(503).json({ success: false, message: "Database unavailable. Please try again shortly." });
    }

    // Send creation notifications
    const { notificationContent } = notification.sendGroupCreationAlerts({
      groupName: cleanGroupName,
      phone: cleanPhone,
      firstName: groupData.firstName,
      secondName: groupData.secondName,
      lastName: groupData.lastName,
      ward,
      constituency,
      county,
      processorPhone: req.session?.user?.phoneNumber || "Anonymous"
    }, req.session?.user?.phoneNumber);

    // Log activity
    perfLogger.logActivity(county, constituency, ward, 1);

    try {
      regPerfLogger.logRegistration(county, constituency, ward, 'groups');
      if (groupData.totalProposedMembers > 0) {
        regPerfLogger.logRegistration(county, constituency, ward, 'members', groupData.totalProposedMembers);
      }
    } catch (e) {
      console.error("Registration performance log error:", e);
    }

    if (req.headers['content-type'] === 'application/json') {
      return res.json({ success: true, redirect: '/general?groupName=' + encodeURIComponent(cleanGroupName), message: 'Group created successfully!' });
    }

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
  } catch (err) {
    console.error("Error creating group (POST /general):", err.message);
    // Handle duplicate key errors specifically
    if (err.code === 11000 || err.message?.includes('E11000') || err.message?.includes('duplicate key')) {
      if (req.headers['content-type'] === 'application/json') {
        return res.status(500).json({
          success: false,
          message: "A group with this name already exists in the database. Please choose a different group name.",
        });
      }
      return res.status(500).send("A group with this name already exists in the database. Please choose a different group name.");
    }
    if (req.headers['content-type'] === 'application/json') {
      return res.status(500).json({
        success: false,
        message: "Server error while creating group. Please try again.",
      });
    }
    return res.status(500).send("Server error while creating group. Please try again.");
  }
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
      (norm(acc.chairpersonalphonenumber) === norm(chairpersonalphonenumber) ||
        norm(acc.phone) === norm(chairpersonalphonenumber)),
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

/* ✅ Verify Member Phone Numbers against MongoDB (POST) */
/**
 * Member verification route - queries MongoDB counties and groups collections
 */
router.post("/verify-members", async (req, res) => {
  try {
    const { members, phoneNumbers } = req.body;
    const inputList = members || phoneNumbers || [];
    
    if (!Array.isArray(inputList)) {
      return res.status(400).json({ success: false, message: "Invalid payload format" });
    }

    // Query MongoDB connection for user lookup
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: "MongoDB not connected" });
    }
    const db = mongoose.connection.db;

    // Get all users from counties collection for verification
    let allMongoUsers = [];
    try {
      const counties = await db.collection('counties').find({}).toArray();
      for (const countyDoc of counties) {
        for (const cons of (countyDoc.constituencies || [])) {
          for (const ward of (cons.wards || [])) {
            for (const user of (ward.data || [])) {
              allMongoUsers.push({
                ...user,
                county: countyDoc.county,
                constituency: cons.name,
                ward: ward.name
              });
            }
          }
        }
      }
      // Also check legacy users collection
      const legacyUsers = await db.collection('users').find({}).toArray();
      allMongoUsers = [...allMongoUsers, ...legacyUsers];
    } catch (dbErr) {
      console.error('[verify-members] MongoDB lookup error:', dbErr.message);
    }

    // Query MongoDB groups collection for existing group member cross-reference
    const groupsCollectionMembers = new Map();
    try {
      const countyDocs = await db.collection('groups').find({}).toArray();
      for (const doc of countyDocs) {
        for (const key in doc) {
          if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
            const m = doc[key];
            if (m && typeof m === 'object' && m.phone) {
              const normalized = norm(m.phone);
              if (!groupsCollectionMembers.has(normalized)) {
                groupsCollectionMembers.set(normalized, {
                  name: m.name || m.title || "Group Member",
                  id: m.id || null,
                  memberNumber: m.memberNumber || null,
                  county: doc.county || 'Unknown'
                });
              }
            }
          }
          // Handle nested constituency/ward structure
          if (Array.isArray(doc[key])) {
            for (const item of doc[key]) {
              if (typeof item === 'object' && item !== null) {
                for (const subKey in item) {
                  if (subKey.startsWith('trustee_') || subKey.startsWith('official_') || subKey.startsWith('member_')) {
                    const m = item[subKey];
                    if (m && typeof m === 'object' && m.phone) {
                      const normalized = norm(m.phone);
                      if (!groupsCollectionMembers.has(normalized)) {
                        groupsCollectionMembers.set(normalized, {
                          name: m.name || m.title || "Group Member",
                          id: m.id || null,
                          memberNumber: m.memberNumber || null,
                          county: doc.county || 'Unknown'
                       });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (groupsErr) {
      console.error('[verify-members] MongoDB groups lookup error:', groupsErr.message);
    }

    const results = inputList.map(member => {
      const phone = member.phone || member.phoneNumber;
      const id = member.id || member.idNumber;
      const normalized = norm(phone);

      // Check counties collection first (primary source)
      const mongoUser = allMongoUsers.find(u => norm(u.phoneNumber) === normalized);
      if (mongoUser) {
        const fullName = [mongoUser.FirstName, mongoUser.MiddleName, mongoUser.LastName].filter(Boolean).join(' ');
        const idMatch = id && String(mongoUser.idNumber).trim() === String(id).trim();
        return {
          ...member,
          verified: true,
          name: fullName || mongoUser.name || "Verified User",
          id: mongoUser.idNumber || id,
          county: mongoUser.county,
          constituency: mongoUser.constituency,
          ward: mongoUser.ward,
          status: idMatch ? "verified" : (id ? "mismatch" : "partial"),
          source: "mongo-counties"
        };
      }

      // Check MongoDB groups collection as fallback
      const groupsMember = groupsCollectionMembers.get(normalized);
      if (groupsMember) {
        const idMatch = id && groupsMember.id && String(groupsMember.id).trim() === String(id).trim();
        return {
          ...member,
          verified: true,
          name: groupsMember.name,
          id: groupsMember.id || id,
          county: groupsMember.county,
          status: idMatch ? "verified" : (id ? "mismatch" : "partial"),
          source: "mongo-groups"
        };
      }

      // Not found in MongoDB
      return {
        ...member,
        verified: false,
        name: "Not Found in Registry",
        status: "not-found"
        };
    });

    return res.json({ success: true, results, members: results });
  } catch (err) {
    console.error("Verification Error:", err);
    return res.status(500).json({ success: false, message: "Server error during verification" });
  }
});

/* ✅ Verify Group Name Availability (GET) */
router.get("/verify-group-name", async (req, res) => {
  try {
    const { groupName } = req.query;
    if (!groupName) {
      return res.json({ exists: false, unavailable: true, message: "Group name is required" });
    }

    const verificationResult = await isGroupNameAvailableInMongo(groupName);
    return res.json(verificationResult);
  } catch (err) {
    console.error("Error verifying group name:", err);
    return res.status(500).json({ unavailable: true, message: "Server error verifying group name" });
  }
});

/* 📍 Locations API */
router.get("/locations/counties", (req, res) => {
  const locationsFile = path.join(__dirname, "../locations.json");
  const locationsData = readJSON(locationsFile, {});
  res.json(Object.keys(locationsData).sort());
});

router.get("/locations/constituencies", (req, res) => {
  const { county } = req.query;
  const locationsData = readJSON(path.join(__dirname, "../locations.json"), {});
  const data = locationsData[county];
  if (!data) return res.json([]);
  res.json(Object.keys(data).sort());
});

router.get("/locations/wards", (req, res) => {
  const { county, constituency } = req.query;
  const locationsData = readJSON(path.join(__dirname, "../locations.json"), {});
  const constData = locationsData?.[county]?.[constituency];
  if (!constData) return res.json([]);
  const wards = Array.isArray(constData) ? constData : (constData.wards || []);
  res.json(wards.sort());
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
            (norm(acc.chairpersonalphonenumber) === norm(chairpersonalphonenumber) ||
              norm(acc.phone) === norm(chairpersonalphonenumber)),
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
      
      // If graduating to phase 2, it might be the first time members are actually "registered" 
      // but they were already counted in the proposed count usually.
      // However, if we want to be precise about WHEN they are added:
      if (updatedAccount.phase === 2) {
          // You could log more here if needed
      }
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

  // Also save to MongoDB groups collection
  const groupForMongo = {
    ...accounts[locationPath.c][locationPath.consti][locationPath.idx],
    county: locationPath.c,
    constituency: locationPath.consti,
    ward: locationPath.w,
    principles: principles,
    principlesSetAt: new Date().toISOString(),
    phase: 3,
    accountNumber: accountNumber,
    pin: targetGroup.constitutionStartKey || null
  };
  saveGeneralGroupToMongo(groupForMongo).catch(e => console.error('[general/set-principles] MongoDB save error:', e.message));

  // Send notification to chairperson about constitution key being set
  const chairpersonPhone = targetGroup.phone || targetGroup.trustee_1?.phone;
  if (chairpersonPhone && targetGroup.constitutionStartKey) {
    notification.processMessage(targetGroup.groupName, {
      to: chairpersonPhone,
      type: "security_alert",
      title: "Constitution Key",
      key: targetGroup.constitutionStartKey,
      content: `Constitution Start Key: ${targetGroup.constitutionStartKey}`
    });
  }

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
// GET /general/groups -> returns all groups from MongoDB
router.get("/groups", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.json([]);
  }
  
  const db = mongoose.connection.db;
  if (!db) {
    return res.json([]);
  }

  try {
    const countyDocs = await db.collection('groups').find({}).toArray();
    const flat = [];
    
    for (const doc of countyDocs) {
      const county = doc.county;
      for (const key in doc) {
        if (key === '_id' || key === 'county') continue;
        const items = doc[key];
        if (!Array.isArray(items)) continue;
        let currentWard = "Unknown Ward";
        items.forEach(item => {
          if (typeof item === 'string') {
            currentWard = item;
          } else if (item && typeof item === 'object') {
            flat.push({ ...item, county, constituency: key, ward: currentWard });
          }
        });
      }
    }
    
    res.json(flat);
  } catch (err) {
    console.error('[general/groups] MongoDB query error:', err.message);
    res.json([]);
  }
});

// GET /general/my-groups -> returns groups where user is a member from MongoDB
router.get("/my-groups", async (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;
  
  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.json({ success: true, groups: [], userPhone: userPhone });
  }
  
  const db = mongoose.connection.db;
  if (!db) {
    return res.json({ success: true, groups: [], userPhone: userPhone });
  }

  try {
    const flat = [];
    const countyDocs = await db.collection('groups').find({}).toArray();
    
    for (const doc of countyDocs) {
      const county = doc.county;
      for (const key in doc) {
        if (key === '_id' || key === 'county') continue;
        const items = doc[key];
        if (!Array.isArray(items)) continue;
        let currentWard = "Unknown Ward";
        items.forEach(item => {
          if (typeof item === 'string') {
            currentWard = item;
          } else if (item && typeof item === 'object') {
            flat.push({ ...item, county, constituency: key, ward: currentWard });
          }
        });
      }
    }

    const userGroups = [];
    let agents = readJSON(agentFile, []);
    
    if (mongoose.connection.readyState === 1) {
      try {
        const db = mongoose.connection.db;
        if (db) {
          const mongoAgents = await db.collection('agents').find({}).toArray();
          if (mongoAgents && mongoAgents.length > 0) {
            agents = mongoAgents;
          }
        }
      } catch (agentErr) {
        console.error('[general/my-groups] MongoDB agents fetch error:', agentErr.message);
      }
    }

    for (const group of flat) {
      for (const key in group) {
        if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
          const memberInfo = group[key];
          const memberPhone = memberInfo ? String(memberInfo.phone || "").trim() : "";
          
          if (memberPhone && norm(memberPhone) === norm(userPhone)) {
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
  } catch (err) {
    console.error('[general/my-groups] MongoDB query error:', err.message);
    res.json({ success: true, groups: [], userPhone: userPhone });
  }
});

// GET /general/mongo-groups -> returns groups from MongoDB 'groups' collection where user is a member
router.get("/mongo-groups", async (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;

  if (!userPhone) {
    return res.status(401).json({ success: false, message: "Not logged in" });
  }

  try {
    const mongoGroups = await findGeneralGroupsByMemberPhone(userPhone);

    const userGroups = await Promise.all(mongoGroups.map(async group => {
      // Determine user's role in this group from MongoDB data
      let userRoleInGroup = null;
      let userTitleInGroup = null;
      
      const chairPhone = group.phone || group.chairpersonalphonenumber;
      if (chairPhone && norm(chairPhone) === norm(userPhone)) {
        userRoleInGroup = "trustee";
        userTitleInGroup = "Chairperson";
      }
      
      for (const key in group) {
        if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
          const memberInfo = group[key];
          if (memberInfo && norm(memberInfo.phone) === norm(userPhone)) {
            userTitleInGroup = memberInfo.title || memberInfo.type || "";
            if (key.startsWith("trustee_")) {
              userRoleInGroup = "trustee";
            } else if (key.startsWith("official_")) {
              userRoleInGroup = userRoleInGroup || "official";
            } else if (key.startsWith("member_")) {
              userRoleInGroup = userRoleInGroup || "member";
            }
          }
        }
      }

const now = new Date();
       const created = new Date(group.createdAt || now);
       const diffDays = Math.ceil(Math.abs(now - created) / (1000 * 60 * 60 * 24));
       const activeRound = Math.ceil(diffDays / 7) || 1;

       let assignedAgentName = group.assignedAgentName || "To be assigned";
       let assignedAgentPhone = group.assignedAgentPhone || "N/A";
       
       if (!group.assignedAgentName && mongoose.connection.readyState === 1) {
         try {
           const db = mongoose.connection.db;
           if (db) {
             const matchedAgent = await db.collection('agents').findOne({
               county: { $regex: `^${group.county || ''}$`, $options: 'i' },
               constituency: { $regex: `^${group.constituency || ''}$`, $options: 'i' }
             });
             if (matchedAgent) {
               assignedAgentName = matchedAgent.name || "To be assigned";
               assignedAgentPhone = matchedAgent.phoneNumber || "N/A";
             }
           }
         } catch (e) {}
       }

       return {
         groupName: group.groupName,
         role: userRoleInGroup || "member",
         roleTitle: userTitleInGroup || "",
         phone: group.phone || group.chairpersonalphonenumber || "",
         phase: group.phase || 1,
         assignedAgentName: assignedAgentName,
         assignedAgentPhone: assignedAgentPhone,
         createdAt: group.createdAt,
         membersPopulatedAt: group.membersPopulatedAt,
         activeRound: activeRound,
         remainRounds: Math.max(0, 52 - activeRound),
         accountNumber: group.accountNumber || "",
         constitutionStartKey: group.constitutionStartKey || "",
          source: "mongo"
        };
    }));

    res.json({
      success: true,
      groups: userGroups,
      userPhone: userPhone
    });
  } catch (err) {
    console.error("Error fetching MongoDB groups:", err);
    res.status(500).json({ success: false, message: "Error fetching groups from database" });
  }
});


// GET /general/agent-for-group -> returns agent assigned to a group's ward
router.get("/agent-for-group", async (req, res) => {
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

  let agents = readJSON(agentFile, []);
  if (mongoose.connection.readyState === 1) {
    try {
      const db = mongoose.connection.db;
      if (db) {
        const mongoAgents = await db.collection('agents').find({}).toArray();
        if (mongoAgents && mongoAgents.length > 0) {
          agents = mongoAgents;
        }
      }
    } catch (e) {}
  }

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
        if (memberInfo && norm(memberInfo.phone) === norm(userPhone)) {
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

    const chairpersonPhoneMatch = norm(targetGroup.phone) === norm(chairpersonPhone) || 
                                  norm(targetGroup.chairpersonalphonenumber) === norm(chairpersonPhone);
    
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
      if (info && norm(info.phone) === norm(userPhone)) {
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

// GET /general/users - returns all users from MongoDB counties collection
router.get("/users", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.json([]);
  }
  
  const db = mongoose.connection.db;
  if (!db) {
    return res.json([]);
  }

  try {
    const flatUsers = [];
    // Query counties collection
    const counties = await db.collection('counties').find({}).toArray();
    for (const countyDoc of counties) {
      for (const cons of (countyDoc.constituencies || [])) {
        for (const ward of (cons.wards || [])) {
          for (const user of (ward.data || [])) {
            flatUsers.push({
              ...user,
              county: countyDoc.county,
              constituency: cons.name,
              ward: ward.name
            });
          }
        }
      }
    }
    
    // Also include legacy users collection
    const legacyUsers = await db.collection('users').find({}).toArray();
    res.json([...flatUsers, ...legacyUsers]);
  } catch (err) {
    console.error('[general/users] MongoDB query error:', err.message);
    res.json([]);
  }
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
      if (info && norm(info.phone) === norm(userPhone)) {
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
    if (!userRoleInGroup && chairPhone && norm(chairPhone) === norm(userPhone)) {
      userRoleInGroup = "trustee";
      userTitleInGroup = "Chairperson";
    }
    
    for (const key in group) {
      if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
        const memberInfo = group[key];
        if (memberInfo && norm(memberInfo.phone) === norm(userPhone)) {
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
      if (memberInfo && norm(memberInfo.phone) === norm(userPhone)) {
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
      if (info && norm(info.phone) === norm(userPhone)) {
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

  // Determine role-based navigation flags
  const agentFile = path.join(__dirname, "../agent.json");
  const dealerFile = path.join(__dirname, "../dealer.json");
  const agents = readJSON(agentFile, []);
  const dealers = readJSON(dealerFile, []);

  const checkItem = (item, phone) => {
    if (!item) return false;
    let itemPhone = "";
    if (typeof item === 'string') itemPhone = item;
    else if (item.phoneNumber) itemPhone = item.phoneNumber;
    else if (item.phone) itemPhone = item.phone;
    return norm(itemPhone) === norm(phone);
  };

  const searchInFile = (data, phone) => {
    if (!data) return false;
    if (checkItem(data, phone)) return true;
    if (Array.isArray(data)) return data.some(item => searchInFile(item, phone));
    if (typeof data === 'object') {
      const keyMatch = Object.keys(data).some(k => norm(k) === norm(phone));
      if (keyMatch) return true;
      return Object.values(data).some(val => (typeof val === 'object' || Array.isArray(val)) && searchInFile(val, phone));
    }
    return false;
  };

  const showAgent = userPhone ? searchInFile(agents, userPhone) : false;
  const showDealer = userPhone ? searchInFile(dealers, userPhone) : false;

  return res.render("group-details", { 
    group, 
    userRole, 
    currentUserPhone: userPhone,
    showAgent,
    showDealer
  });
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

/* 🗑️ API: Delete Group Request */
router.post("/delete-group", (req, res) => {
  try {
    const { groupName } = req.body;
    if (!groupName) {
      return res.status(400).json({ success: false, message: "Missing groupName" });
    }

    const accounts = readJSON(generalFile, {});
    let groupDeleted = false;

    for (const county in accounts) {
      for (const constituency in accounts[county]) {
        const constituencyArray = accounts[county][constituency];
        if (Array.isArray(constituencyArray)) {
          // Find index of the group object matching the groupName (case-insensitive)
          const index = constituencyArray.findIndex(item => 
            typeof item === 'object' && 
            item !== null && 
            item.groupName && 
            item.groupName.toLowerCase() === groupName.toLowerCase()
          );

          if (index !== -1) {
            // Delete the group from array
            constituencyArray.splice(index, 1);
            groupDeleted = true;
            break;
          }
        }
      }
      if (groupDeleted) break;
    }

    if (!groupDeleted) {
      return res.status(404).json({ success: false, message: "Group request not found" });
    }

    // Save updated structure back to general.json database
    writeJSON(generalFile, accounts);

    console.log(`✓ Group request deleted: ${groupName}`);

    return res.json({ success: true, message: "Group request deleted successfully from database" });
  } catch (err) {
    console.error("Error deleting group request:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/* 🔧 Cleanup null groupKeys in MongoDB (admin endpoint) */
router.post("/cleanup-group-keys", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: "MongoDB not connected" });
    }
    const db = mongoose.connection.db;
    const col = db.collection('groups');
    const cleaned = await cleanupStaleGroupKeys(col);
    const indexFixed = await fixGroupKeyIndex();
    res.json({ success: true, cleaned, indexFixed, message: `Cleaned ${cleaned} documents with null/empty groupKey` });
  } catch (err) {
    console.error("Cleanup error:", err);
    res.status(500).json({ success: false, message: "Cleanup failed: " + err.message });
  }
});

/* 🔧 Full fix for groupKey index issues */
router.post("/fix-groupkey-index", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: "MongoDB not connected" });
    }
    const db = mongoose.connection.db;
    const col = db.collection('groups');
    const cleaned = await cleanupStaleGroupKeys(col);
    const indexFixed = await fixGroupKeyIndex();
    res.json({ success: true, cleaned, indexFixed, message: `Fixed ${cleaned} null documents and recreated sparse index` });
  } catch (err) {
    console.error("Fix index error:", err);
    res.status(500).json({ success: false, message: "Fix failed: " + err.message });
  }
});

module.exports = router;
