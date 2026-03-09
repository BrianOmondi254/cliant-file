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
    const users = readJSON(usersFile, []);
    const userIndex = users.findIndex(u => norm(u.phoneNumber) === norm(phone));

    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = users[userIndex];

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
    
    users[userIndex].personalPin = hashedNewPin;
    writeJSON(usersFile, users);

    res.json({ success: true, message: "PIN changed successfully" });
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
