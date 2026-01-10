const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const generalFile = path.join(__dirname, "../general.json");

/* ================= HELPERS ================= */
const readJSON = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) {
        console.warn(`File not found: ${file}`);
        return fallback;
    }
    const data = fs.readFileSync(file, "utf8");
    if (!data) return fallback;
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

/* ================= ROUTES ================= */

/* 📋 General Form (GET) */
router.get("/", (req, res) => {
  // DEBUG MODE: Forced Hardcoded Data
  const accounts = [
    { groupName: "HARDCODED GROUP 1", phone: "0700000001" },
    { groupName: "HARDCODED GROUP 2", phone: "0700000002" }
  ];

  console.log("Serving HARDCODED accounts:", accounts);

  res.render("general", { 
    groups: accounts, 
    debugMsg: "Using Hardcoded Data"
  });
});

/* 🔍 Verify Chairperson & Get TBank Config (POST) */
router.post("/verify", (req, res) => {
  const { chairpersonalphonenumber, groupName } = req.body;
  const tbankFile = path.join(__dirname, "../tbank.json");
  const accounts = readJSON(generalFile, []);
  const tbankData = readJSON(tbankFile, null);

  // 1. Verify Phone AND Group Match
  const account = accounts.find(acc => 
    acc.groupName === groupName && 
    (acc.chairpersonalphonenumber === chairpersonalphonenumber || acc.phone === chairpersonalphonenumber)
  );

  if (!account) {
    return res.json({ success: false, message: "Chairperson phone number does not match the selected group." });
  }

  // 2. Check TBank Completion
  if (!tbankData || !tbankData.compliance || tbankData.compliance.completed !== true) {
    return res.json({ success: false, message: "T-Bank compliance not completed." });
  }

  // 3. Return Counts and Fees
  const { trustees, officials, members, maxMembers } = tbankData.compliance.membership;
  const { newGroupFee, renewalFee } = tbankData.compliance.registration;
  
  return res.json({ 
    success: true, 
    counts: { 
      trustees: parseInt(trustees) || 0, 
      officials: parseInt(officials) || 0, 
      members: parseInt(members) || 0,
      maxMembers: parseInt(maxMembers) || 100
    },
    fees: {
      newGroup: parseFloat(newGroupFee) || 0,
      renewal: parseFloat(renewalFee) || 0
    }
  });
});

/* ✅ Verify Member Phone Numbers against data.json (POST) */
router.post("/verify-members", (req, res) => {
  const { phoneNumbers } = req.body; // Array of { type, phone, id }
  const dataFile = path.join(__dirname, "../data.json");
  const userData = readJSON(dataFile, []);

  const results = phoneNumbers.map(member => {
    // Find user by phone number
    const user = userData.find(u => u.phoneNumber === member.phone);
    return {
      ...member,
      verified: !!user,
      foundName: user ? `${user.FirstName} ${user.LastName}` : "Not Found"
    };
  });

  return res.json({ success: true, results });
});

/* 💾 Save General Account (POST) */
router.post("/", (req, res) => {
  // Extract fields from body
  const {
    groupName,
    chairpersonalphonenumber,
    firstName,
    secondName,
    lastName,
    county,
    constituency,
    ward // New field
  } = req.body;

  const accounts = readJSON(generalFile, []);

  // Basic validation (optional)
  if (!groupName || !chairpersonalphonenumber || !firstName || !lastName || !county) {
    // In a real app, you might re-render with errors
    return res.status(400).send("Missing required fields.");
  }

  const newAccount = {
    groupName,
    phone: chairpersonalphonenumber, // Map back to 'phone' for DB consistency
    firstName,
    secondName,
    lastName,
    county,
    constituency,
    ward,
    processorPhone: req.session?.user?.phoneNumber || "Anonymous", // Track who processed if logged in
    createdAt: new Date().toISOString()
  };

  accounts.push(newAccount);
  writeJSON(generalFile, accounts);

  // Redirect or show success
  // For now, redirect back or to a success page
  res.redirect("/login?alert=Account%20Created%20Successfully");
});

/* 📝 Update Group Members (Agent Submission) */
router.post("/update-members", (req, res) => {
  const { groupName, chairpersonalphonenumber, membersData } = req.body;
  
  if (!groupName || !chairpersonalphonenumber) {
    return res.json({ success: false, message: "Missing group identification." });
  }

  const accounts = readJSON(generalFile, []);
  
  // Find the group
  const accountIndex = accounts.findIndex(acc => 
    acc.groupName === groupName && 
    (acc.chairpersonalphonenumber === chairpersonalphonenumber || acc.phone === chairpersonalphonenumber)
  );

  if (accountIndex === -1) {
    return res.json({ success: false, message: "Group not found or verification failed." });
  }

  // Update the account with new member data
  accounts[accountIndex] = {
    ...accounts[accountIndex],
    ...membersData,
    membersPopulatedAt: new Date().toISOString(),
    agentProcessed: req.session?.user?.phoneNumber || "Unknown"
  };

  writeJSON(generalFile, accounts);

  return res.json({ success: true, message: "Group members updated successfully!" });
});

// JSON endpoints for client-side consumption
// GET /general/groups -> returns all groups
router.get('/groups', (req, res) => {
  const accounts = readJSON(generalFile, []);
  res.json(accounts);
});

// GET /general/users -> returns all users
router.get('/users', (req, res) => {
  const dataFile = path.join(__dirname, '../data.json');
  const users = readJSON(dataFile, []);
  res.json(users);
});

module.exports = router;
