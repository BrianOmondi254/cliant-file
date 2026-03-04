const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

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
        if (typeof data[county] !== 'object') continue;
        for (const constituency in data[county]) {
            if (typeof data[county][constituency] !== 'object') continue;
            for (const ward in data[county][constituency]) {
                 const groups = data[county][constituency][ward];
                 if (Array.isArray(groups)) flat.push(...groups);
            }
        }
    }
    return flat;
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
router.get("/", (req, res) => {
  try {
    const phone = req.session.user && req.session.user.phoneNumber;

    const generalFile = path.join(__dirname, '../general.json');

    const generalsRaw = readJSON(generalFile, {});
    const generals = flattenData(generalsRaw);

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
        // Also check if any key matches (important for dealer.json hierarchy)
        const keyMatch = Object.keys(data).some(k => norm(k) === norm(phone));
        if (keyMatch) return true;
        return Object.values(data).some(search);
      }
      return false;
    };

    // Use session flags for showDealer, showAgent, agent, and hasAgentPin
    // To be robust, re-check against files if flags are missing or stale
    const dealerFile = path.join(__dirname, "../dealer.json");
    const agentFile = path.join(__dirname, "../agent.json");
    const dealers = readJSON(dealerFile, []);
    const agents = readJSON(agentFile, []);

    const isDealerInFile = dealers.some(d => norm(d.phoneNumber) === norm(phone));
    const isAgentInFile = agents.some(a => norm(a.phoneNumber) === norm(phone));

    const showDealer = req.session.isDealer || isDealerInFile || false;
    const showAgent = (req.session.isAgent || isAgentInFile || false) && !showDealer; // Agent should not be dealer
    const generalExists = search(generals);

    const hasAgentPin = req.session.hasAgentPin || false;

    const dealerIsVerified = !!req.session.dealerPhone;
    const agentIsVerified = !!req.session.agentVerified;

    // Identify if user is a trustee, official or member and collect keys
    let isTrustee = false;
    let isOfficial = false;
    let isMember = false;
    const constitutionKeys = [];

    // Robust check helper
    const userInThisGroup = (g, phone) => {
       const str = JSON.stringify(g);
       return str.includes(phone); // Simple substring check
    };

    generals.forEach(group => {
      // 1. Check if user is in group at all
      if (userInThisGroup(group, phone)) {
          
          let userIsTrusteeInThisGroup = false;

          // 2. Determine detailed roles
          Object.keys(group).forEach(key => {
             const item = group[key];
             if (item && typeof item === 'object' && item.phone && norm(item.phone) === norm(phone)) {
                 if (key.startsWith('trustee_')) {
                     isTrustee = true;
                     userIsTrusteeInThisGroup = true;
                 }
                 if (key.startsWith('official_')) isOfficial = true;
                 if (key.startsWith('member_')) isMember = true;
             }
          });
          
          // Also check explicit Chair phone field if present
          if (group.chairpersonalphonenumber && norm(group.chairpersonalphonenumber) === norm(phone)) {
              isTrustee = true;
              userIsTrusteeInThisGroup = true;
          }

          // 3. Collect Security Messages
          if (group.messages && Array.isArray(group.messages)) {
              group.messages.forEach(msg => {
                  if (msg.to && norm(msg.to) === norm(phone)) {
                      constitutionKeys.push({
                          groupName: group.groupName,
                          type: msg.type,
                          content: msg.content,
                          isNew: true
                      });
                  } else if (msg.broadcast && msg.roles.includes('trustee') && userIsTrusteeInThisGroup) {
                      constitutionKeys.push({
                          groupName: group.groupName,
                          type: msg.type,
                          content: msg.content,
                          isNew: true
                      });
                  }
              });
          }

          // Legacy support for plain-text initial keys
          if (group.constitutionStartKey && !group.constitutionStartKey.startsWith('$2') && userIsTrusteeInThisGroup) {
              constitutionKeys.push({
                  groupName: group.groupName,
                  key: group.constitutionStartKey,
                  type: 'legacy'
              });
          }
      }
    });

    const normalizedPhone = norm(phone);
    const userGroups = generals.filter(group => {
      for (const key in group) {
        const item = group[key];
        if (item && typeof item === 'object' && item.phone && norm(item.phone) === normalizedPhone) {
            return true;
        }
      }
      if (group.phone && norm(group.phone) === normalizedPhone) {
            return true;
      }
      return false;
    });

    // Check if user has a personal PIN in data.json
    const usersFile = path.join(__dirname, "../data.json");
    const users = readJSON(usersFile, []);
    const currentUser = users.find(u => norm(u.phoneNumber) === norm(phone));
    const hasPersonalPin = !!(currentUser && currentUser.personalPin);

    res.render('cliant', {
      user: req.session.user,
      showAgent,
      showDealer,
      generalExists,
      isTrustee, // Note: This might be true if ANY group has user as trustee
      isOfficial,
      isMember,
      dealerIsVerified,
      agentIsVerified,
      personalIsVerified: req.session.personalVerified || false, // Pass verified status
      hasAgentPin,
      hasPersonalPin, // Pass hasPersonalPin to view
      hasDealerPin: req.session.hasDealerPin || false,
      constitutionKeys, // Pass keys to view
      userGroups,
      normalizedPhone
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

    const usersFile = path.join(__dirname, "../data.json");
    const users = readJSON(usersFile, []);
    const userIndex = users.findIndex(u => norm(u.phoneNumber) === norm(phone));

    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Hash the PIN before saving
    const saltRounds = 10;
    const hashedPin = await bcrypt.hash(pin, saltRounds);
    
    users[userIndex].personalPin = hashedPin;
    writeJSON(usersFile, users);

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

    const usersFile = path.join(__dirname, "../data.json");
    const users = readJSON(usersFile, []);
    const user = users.find(u => norm(u.phoneNumber) === norm(phone));

    if (!user || !user.personalPin) {
      return res.status(404).json({ success: false, message: "PIN not found" });
    }

    const isValid = await bcrypt.compare(pin, user.personalPin);
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

    res.render("myaccount", { 
      user: req.session.user,
      groups: userGroups,
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

/* 🏠 Group Details */
router.get("/group/:groupName", (req, res) => {
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
          
          points.push(`This group shall be known as ${group.groupName}, located in ${group.ward} Ward, ${group.constituency} Constituency, ${group.county} County.`);
          
          if (p.intervals) {
              points.push(`Members shall meet ${p.intervals.frequency} on ${p.intervals.period.charAt(0).toUpperCase() + p.intervals.period.slice(1)} to conduct group business.`);
              points.push(`The group savings cycle is established for a duration of ${p.intervals.endSavingPeriod || '1 year'}.`);
          }
          
          if (p.otherContributions && p.otherContributions.length > 0) {
              const contribs = p.otherContributions.map(c => `${c.accountName} (Account ${c.accountNumber}) at KES ${c.expectedAmount}`).join(', ');
              points.push(`Standard contributions shall include: ${contribs}.`);
          }
          
          if (p.loans) {
              points.push(`Members qualify for loans after ${p.loans.duration ? p.loans.duration.days : '30'} days of active participation.`);
              points.push(`Loans shall attract an interest rate of ${p.loans.interestAndLimits ? p.loans.interestAndLimits.interestRate : '0'}% per period.`);
              points.push(`The maximum loan amount is set at x${p.loans.interestAndLimits ? p.loans.interestAndLimits.limitMultiplier : '3'} of a member's total savings.`);
          }
          
          if (p.governance) {
              points.push(`A quorum of ${p.governance.fastNotificationThreshold || '60'}% is required for fast-tracked constitutional changes.`);
              points.push(`Major account edits and member removals require a consensus threshold of ${p.governance.editAccountThreshold || '75'}%.`);
          }

          group.constitutionPoints = points;
      }
      
      res.render("group-details", {
        user: req.session.user,
        userRole: userRole,
        group: group, // Pass the augmented group object
        alert: null
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
    
    res.render("general", { 
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

    res.render("send-money", { 
      user: req.session.user,
      groups: userGroups,
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

module.exports = router;
