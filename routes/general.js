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
  // console.log("Data restructured to hierarchy.");
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
  const { view } = req.query; // Get view from query params
  const userPhone = req.session?.user?.phoneNumber;

  // Auto-migrate if array is detected
  if (Array.isArray(raw)) {
    raw = restructureData(raw);
    writeJSON(generalFile, raw);
  }

  let allGroups = flattenData(raw);
  let displayGroups = allGroups;

  if (view === 'my_groups' && userPhone) {
    displayGroups = allGroups.filter(group => group.processorPhone === userPhone);
  }

  // Pass flat list to frontend for dropdowns etc.
  res.render("general", {
    groups: displayGroups,
    view: view, // Pass the view type to the template
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
  const { phoneNumbers } = req.body; // Array of { type, phone, id }
  const dataFile = path.join(__dirname, "../data.json");
  const userData = readJSON(dataFile, []);

  const results = phoneNumbers.map((member) => {
    // Normalize inputs
    const inputPhone = String(member.phone).trim();
    const inputId = String(member.id).trim();

    // Find user by phone number
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
  // Extract fields from body
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
    // We don't write immediately, we write after pushing new data
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

  // Ensure path exists in hierarchy
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

  // Find the group in hierarchy
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

  // Update the account with new member data
  const updatedAccount = {
    ...targetGroup,
    ...membersData,
    membersPopulatedAt: new Date().toISOString(),
    agentProcessed: req.session?.user?.phoneNumber || "Unknown",
  };

  // Count actual people submitted
  const actualPeopleCount = Object.keys(updatedAccount).filter(
    (key) =>
      key.startsWith("trustee_") ||
      key.startsWith("official_") ||
      key.startsWith("member_"),
  ).length;

  const totalProposed = parseInt(totalProposedMembers) || 0;

  // Phase Logic
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

  // Update in place
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

  // 1. Generate Account Number (Kenya Government Setup)
  // Structure: Country(254) + CountyCode(3) + ConstiCode(3) + WardCode(4) + Position(3)
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

  // 2. Update Group Record
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].principles = principles;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].principlesSetAt = new Date().toISOString();
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].phase = 3;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].accountNumber = accountNumber;
  accounts[locationPath.c][locationPath.consti][locationPath.w][locationPath.idx].pin = targetGroup.constitutionStartKey || null;
  
  writeJSON(generalFile, accounts);

  // Get total members for success display
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
// GET /general/groups -> returns all groups (flattened for legacy compatibility)
router.get("/groups", (req, res) => {
  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
    writeJSON(generalFile, accounts);
  }
  res.json(flattenData(accounts));
});

// GET /general/users -> returns all users
router.get("/users", (req, res) => {
  const dataFile = path.join(__dirname, "../data.json");
  const users = readJSON(dataFile, []);
  res.json(users);
});

/* 🙋‍♂️ Get User Role in a specific group */
router.post("/user-role", (req, res) => {
  const { groupName } = req.body;
  const userPhone = req.session?.user?.phoneNumber;

  if (!groupName || !userPhone) {
    return res.status(400).json({ role: "error", message: "Missing info." });
  }

  const accounts = readJSON(generalFile, {});
  // Use existing flatten function, but ensure it doesn't modify data we need
  const allGroups = flattenData(accounts);
  const group = allGroups.find(g => g.groupName === groupName);

  if (!group) {
    return res.status(404).json({ role: "error", message: "Group not found." });
  }

  let userRole = "not_member";

  // Iterate over all properties of the group to find member entries
  for (const key in group) {
    // Check for keys like trustee_1, official_1, member_1, etc.
    if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
      const memberInfo = group[key];
      if (memberInfo && String(memberInfo.phone).trim() === String(userPhone).trim()) {
        userRole = memberInfo.type; // This will be 'trustee', 'official', or 'member'
        break; // Found the user, no need to loop further
      }
    }
  }

  res.json({ role: userRole });
});

module.exports = router;
