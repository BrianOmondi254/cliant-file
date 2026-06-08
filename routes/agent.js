const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const PDFDocument = require("pdfkit");

const { findUserByPhone, getAllUsersFlattened } = require("../mongoose");

const agentFile = path.join(__dirname, "../agent.json");
const generalFile = path.join(__dirname, "../general.json");
const dealerFile = path.join(__dirname, "../dealer.json");
const businessFile = path.join(__dirname, "../p_account/business.json");
const perfLogger = require("../performance/group-performance");
const regPerfLogger = require("../performance/registration-performance");

const notification = require("../notification/notification");
const loadJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : fallback;
  } catch (e) {
    console.error("Error reading JSON:", e);
    return fallback;
  }
};

const normPhone = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

const normStr = (s) => (s ? String(s).trim().toLowerCase() : "");

const getUsersFromMongo = async () => {
  try {
    return await getAllUsersFlattened();
  } catch (error) {
    console.error("[AGENT] Error getting users from MongoDB:", error.message);
    return [];
  }
};

const findUserInList = (users, phone) => {
  const normalized = normPhone(phone);
  if (!normalized || !Array.isArray(users)) return null;
  return users.find((u) => normPhone(u.phoneNumber) === normalized) || null;
};

const formatUserName = (user) => {
  if (!user) return "";
  return [user.FirstName, user.MiddleName, user.LastName]
    .map((s) => s && String(s).trim())
    .filter(Boolean)
    .join(" ");
};

const buildUserNameMap = (users) => {
  const userMap = new Map();
  if (!Array.isArray(users)) return userMap;
  users.forEach((u) => {
    if (u.phoneNumber) userMap.set(normPhone(u.phoneNumber), formatUserName(u));
  });
  return userMap;
};

const buildUserDetailMap = (users) => {
  const userMap = new Map();
  if (!Array.isArray(users)) return userMap;
  users.forEach((u) => {
    if (u.phoneNumber) {
      userMap.set(normPhone(u.phoneNumber), {
        name: formatUserName(u),
        id: u.idNumber || u.IDNumber || "",
      });
    }
  });
  return userMap;
};

const flattenData = (data) => {
  if (Array.isArray(data)) return data;
  const flat = [];
  if (!data) return flat;
  for (const county in data) {
    if (county === "performance" || typeof data[county] !== "object") continue;
    for (const constituency in data[county]) {
      if (constituency === "performance") continue;
      const items = data[county][constituency];
      if (Array.isArray(items)) {
        let currentWard = "Unknown Ward";
        items.forEach((item) => {
          if (typeof item === "string") {
            currentWard = item;
          } else if (typeof item === "object" && item !== null && !item.isPerformance && item.groupName) {
            flat.push({
              ...item,
              county: item.county || county,
              constituency: item.constituency || constituency,
              ward: item.ward || currentWard,
            });
          }
        });
      } else if (typeof items === "object" && items !== null) {
        for (const ward in items) {
          const groups = items[ward];
          if (!Array.isArray(groups)) continue;
          let currentWard = ward;
          groups.forEach((item) => {
            if (typeof item === "string") {
              currentWard = item;
            } else if (typeof item === "object" && item !== null && !item.isPerformance && item.groupName) {
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
  }
  return flat;
};

const resolveAgentProfile = (agent, mongoUser, managedGroupsForInfer = []) => {
  const profile = {
    name: agent?.name || "",
    phoneNumber: agent?.phoneNumber || "",
    county: (agent?.county || "").trim(),
    constituency: (agent?.constituency || "").trim(),
    ward: (agent?.ward || "").trim(),
    dealerPhone: agent?.dealerPhone || "",
  };
  if (mongoUser && !profile.name) {
    profile.name = formatUserName(mongoUser);
  }
  // Agent territory comes from agent.json only (not personal MongoDB registration).
  if (!profile.county && managedGroupsForInfer.length > 0) {
    const g = managedGroupsForInfer[0];
    profile.county = g.county || profile.county;
    profile.constituency = g.constituency || profile.constituency;
    profile.ward = g.ward || profile.ward;
  }
  return profile;
};

const matchesAgentRegion = (group, profile) => {
  if (!profile.county) return false;
  if (normStr(group.county) !== normStr(profile.county)) return false;
  if (profile.constituency && group.constituency && normStr(group.constituency) !== normStr(profile.constituency)) {
    return false;
  }
  if (profile.ward && group.ward && normStr(group.ward) !== normStr(profile.ward)) {
    return false;
  }
  return true;
};

const isGroupManagedByAgent = (group, agentPhone, profile) => {
  const agentNorm = normPhone(agentPhone);
  const agentPhones = [
    group.agentProcessed,
    group.registeredByAgent,
    group.processorPhone,
  ];
  if (agentPhones.some((p) => p && normPhone(p) === agentNorm)) {
    return true;
  }
  if (profile.county && profile.constituency && profile.ward) {
    return matchesAgentRegion(group, profile);
  }
  return false;
};

const buildRegionalGroups = (groups, profile) => {
  const regionalGroups = {};
  groups.forEach((group) => {
    const county = group.county || profile.county || "Unassigned";
    const constituency = group.constituency || profile.constituency || "Unassigned";
    const ward = group.ward || profile.ward || "Unassigned";
    if (!regionalGroups[county]) regionalGroups[county] = {};
    if (!regionalGroups[county][constituency]) regionalGroups[county][constituency] = {};
    if (!regionalGroups[county][constituency][ward]) regionalGroups[county][constituency][ward] = [];
    regionalGroups[county][constituency][ward].push(group);
  });
  return regionalGroups;
};

// GET /agent
router.get("/", async (req, res) => {
  // Prevent caching to ensure strict PIN entry logic works on back/forward navigation
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  // 1. Enforce Login: If no session exists, redirect to login immediately.
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const currentPhoneNumber = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile, []);
  const users = await getUsersFromMongo();

  // 2. Try agent.json first (fastest)
  let agent = agents.find((a) => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  // 3. Verify against MongoDB counties collection
  let mongoUser = findUserInList(users, currentPhoneNumber);
  if (!mongoUser) {
    try {
      mongoUser = await findUserByPhone(currentPhoneNumber);
    } catch (dbErr) {
      console.error("[AGENT] MongoDB verification error:", dbErr.message);
    }
  }
  if (mongoUser && !agent) {
    agent = agents.find((a) => normPhone(a.phoneNumber) === normPhone(mongoUser.phoneNumber));
  }

  const userMap = buildUserNameMap(users);

  // Helper to render safe views (No dashboard data)
  const renderSafe = (step, msg = null) => {
    return res.render("agent/agent", {
      step: step,
      phoneNumber: currentPhoneNumber,
      agentName: agent ? agent.name : "Unknown",
      agent: agent ? { name: agent.name, phoneNumber: agent.phoneNumber } : null, // Strict sanitization
      user: req.session.user,
      message: msg,
      groups: [],
      regionalGroups: {},
      dealer: null
    });
  };

  // If the determined phone number doesn't belong to an agent, render a diagnostic message
  if (!agent) {
    return res.render("agent/agent", {
      step: "not-agent",
      phoneNumber: currentPhoneNumber,
      agentName: "Unknown",
      agent: null,
      user: req.session.user,
      message: {
        type: "error",
        text: "Not qualified to be an agent.",
        details:
          "Session phone: " + currentPhoneNumber +
          " | agent.json match: " + (agent ? "yes" : "no") +
          " | MongoDB user: " + (mongoUser ? "found" : "not found") +
          " | MongoDB users total: " + users.length +
          " | registry match: " + (mongoUser ? "yes" : "no")
      },
      groups: [],
      regionalGroups: {},
      dealer: null
    });
  }

  // Load groups from general.json; match by agent phone, then by agent.json territory
  const generalRaw = loadJSON(generalFile, {});
  const general = flattenData(generalRaw);
  const agentNorm = normPhone(currentPhoneNumber);
  const phoneMatchedGroups = general.filter((g) => {
    const fields = [g.agentProcessed, g.registeredByAgent, g.processorPhone];
    return fields.some((p) => p && normPhone(p) === agentNorm);
  });
  let agentProfile = agent
    ? resolveAgentProfile(agent, mongoUser, phoneMatchedGroups)
    : null;
  let managedGroups = phoneMatchedGroups;
  if (managedGroups.length === 0 && agentProfile) {
    managedGroups = general.filter((g) => isGroupManagedByAgent(g, currentPhoneNumber, agentProfile));
  }
  if (!agentProfile?.county && managedGroups.length > 0) {
    agentProfile = resolveAgentProfile(agent, mongoUser, managedGroups);
  }

  // Augment managed groups with a list of members including their full names
  managedGroups.forEach(group => {
    // Only create a membersList if the group is already populated with members
    if (group.membersPopulatedAt || (group.phase && group.phase >= 2)) {
        group.membersList = [];
        for (const key in group) {
            if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
                let member = group[key];
                let phone = null;
                
                if (member && typeof member === 'object' && member.phone) {
                    phone = member.phone;
                } else if (typeof member === 'string') {
                    phone = member;
                }

                if (phone) {
                    const normalizedPhone = normPhone(phone);
                    // Lookup name from MongoDB registry, fallback to existing name, fallback to 'Unknown'
                    const memberName = userMap.get(normalizedPhone) || (typeof member === 'object' && member.name ? member.name : '') || 'Unknown Name';
                    
                    // Standardize member object
                    const memberObj = typeof member === 'object' ? { ...member } : { phone: phone, type: key.split('_')[0] };
                    memberObj.name = memberName;

                    // 1. Add to cleaned list for easy iteration
                    group.membersList.push(memberObj);

                    // 2. Update the original key in the group object so legacy views find the name
                    if (typeof group[key] === 'object') {
                        group[key].name = memberName;
                    } else {
                        // Convert string-only member to object in-memory
                        group[key] = memberObj;
                    }
                }
            }
        }
    }
  });

  const dealers = loadJSON(dealerFile);
  const dealer = (agentProfile && Array.isArray(dealers))
    ? dealers.find((d) => normPhone(d.phoneNumber) === normPhone(agentProfile.dealerPhone))
    : null;

  const displayAgent = agentProfile
    ? { ...agent, ...agentProfile, name: agentProfile.name || agent.name }
    : { phoneNumber: currentPhoneNumber, name: "Unknown Agent" };

  const selectedGroupName = req.query.groupName;
  const selectedGroupIndex = selectedGroupName ? managedGroups.findIndex(g => g.groupName === selectedGroupName) : -1;
  let selectedGroup = selectedGroupIndex > -1 ? managedGroups[selectedGroupIndex] : null;

  // If a group is selected and it's new (not populated), get registration config
  let registrationConfig = null;
  if (selectedGroup && !selectedGroup.membersPopulatedAt && (!selectedGroup.phase || selectedGroup.phase < 2)) {
    const tbankFile = path.join(__dirname, "../tbank.json");
    const tbankData = loadJSON(tbankFile, {});
    
    if (tbankData && tbankData.compliance && tbankData.compliance.membership) {
      const { trustees, officials, members, maxMembers } = tbankData.compliance.membership;
      registrationConfig = {
        trustees: parseInt(trustees) || 0,
        officials: parseInt(officials) || 0,
        members: parseInt(members) || 0,
        maxMembers: parseInt(maxMembers) || 40,
        showRegistrationForm: true,
      };
    }
    // To robustly prevent the "Existing Members" view, we replace the group object
    // in the main list with a minimal one, ensuring the template receives no conflicting data.
    const minimalGroup = { groupName: selectedGroup.groupName, isNew: true };
    managedGroups[selectedGroupIndex] = minimalGroup;
    selectedGroup = minimalGroup;
  }

  const regionalGroups = buildRegionalGroups(managedGroups, agentProfile);

  // Calculate business account float from business.json based on agent's phone
  const getBusinessPhone = () => {
    if (!Array.isArray(agents)) return currentPhoneNumber;
    const found = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));
    return found ? found.phoneNumber : currentPhoneNumber;
  };
  const businessPhone = getBusinessPhone();
  let businessFloat = 0;
  let businessShare = 0;
  let businessTotal = 0;
  try {
    const businessRaw = loadJSON(businessFile, { businessAccounts: {} });
    const businessAccounts = businessRaw.businessAccounts || {};
    const matchedKey = Object.keys(businessAccounts).find(key => normPhone(businessAccounts[key].phone) === normPhone(businessPhone));
    if (matchedKey) {
      const account = businessAccounts[matchedKey];
      const txns = account.transactions || [];
      if (txns.length > 0 && typeof txns[txns.length - 1].closingBalance === 'number') {
        businessFloat = txns[txns.length - 1].closingBalance;
      } else {
        let balance = 0;
        (txns || []).forEach(t => {
          const amt = parseFloat(t.amount) || 0;
          balance += t.type === 'received' ? amt : -amt;
        });
        businessFloat = balance;
      }
      businessShare = parseFloat((businessFloat * 0.10).toFixed(2));
      businessTotal = parseFloat((businessFloat + businessShare).toFixed(2));
    }
  } catch (e) {
    console.error("[AGENT] Business float calculation error:", e.message);
  }

  res.render("agent/agent", {
    step: "dashboard",
    agent: displayAgent,
    groups: managedGroups,
    regionalGroups,
    selectedGroup: selectedGroup,
    dealer: dealer,
    message: null,
    phoneNumber: currentPhoneNumber,
    user: (req.session && req.session.user) || { phoneNumber: currentPhoneNumber },
    registrationConfig: registrationConfig,
    businessFloat,
    businessShare,
    businessTotal
  });

});

// GET /agent/new-group - Redirect to a dedicated page for populating new group requests
router.get("/new-group", (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const { groupName } = req.query;
  const agents = loadJSON(agentFile);
  const general = flattenData(loadJSON(generalFile, {}));
  
  const currentPhoneNumber = req.session.user.phoneNumber;
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));
  
  if (!agent) {
    return res.redirect("/agent");
  }

  // Find the group
  const group = general.find(g => g.groupName === groupName);
  if (!group) {
    return res.redirect("/agent");
  }

  // Get compliance standards
  const tbankFile = path.join(__dirname, "../tbank.json");
  const tbankData = loadJSON(tbankFile, {});
  
  let registrationConfig = {
    trustees: 3,
    officials: 3,
    members: 10,
    maxMembers: 100,
    newGroupFee: 50
  };

  if (tbankData && tbankData.compliance) {
    if (tbankData.compliance.membership) {
      const { trustees, officials, members, maxMembers } = tbankData.compliance.membership;
      registrationConfig.trustees = parseInt(trustees) || 3;
      registrationConfig.officials = parseInt(officials) || 3;
      registrationConfig.members = parseInt(members) || 10;
      registrationConfig.maxMembers = parseInt(maxMembers) || 100;
    }
    if (tbankData.compliance.registration && tbankData.compliance.registration.newGroupFee) {
      registrationConfig.newGroupFee = parseInt(tbankData.compliance.registration.newGroupFee) || 50;
    }
  }

  res.render("agent/new_group", {
    agent: agent,
    group: group,
    registrationConfig: registrationConfig,
    user: req.session.user
  });
});

// PIN related routes removed


// POST /agent/set-constitution-key
router.post("/set-constitution-key", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { groupName, key } = req.body;
  if (!key) return res.json({ success: false, message: "Key is required" });
  
  // Reload fresh data
  let general = loadJSON(generalFile);

  let found = false;

  // Logic to find and update group
  const updateGroup = (g) => {
      g.constitutionStartKey = key;
      g.constitutionKeySetByAgentAt = new Date().toISOString();
      found = true;
  };

  const flat = flattenData(general);
  const g = flat.find(g => g.groupName === groupName);
  if (g) updateGroup(g);

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      return res.json({ success: true });
  } else {
      return res.json({ success: false, message: "Group not found." });
  }
});

// POST /agent/verify-constitution-key - Verify the constitution key matches the database
router.post("/verify-constitution-key", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { groupName, key } = req.body;
  if (!key) return res.json({ success: false, message: "Key is required" });

  let general = loadJSON(generalFile);
  let verified = false;

  const checkKey = (g) => {
    if (g.constitutionStartKey === key) {
      verified = true;
    }
  };

  const flat = flattenData(general);
  const g = flat.find(g => g.groupName === groupName);
  if (g) checkKey(g);

  if (verified) {
    return res.json({ success: true });
  } else {
    return res.json({ success: false, message: "Incorrect key" });
  }
});

// POST /agent/register-new-group - Register new group with members
router.post("/register-new-group", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { groupName, chairpersonPhone, trustees, officials, members } = req.body;
  
  if (!groupName || !chairpersonPhone) {
    return res.json({ success: false, message: "Group name and chairperson phone are required" });
  }
  
  // Load general.json
  let general = loadJSON(generalFile);
  
  // Find and update the group
  let found = false;
  
  const updateGroup = (g) => {
      // Add chairperson as trustee_1
      g.trustee_1 = {
        phone: chairpersonPhone,
        type: 'trustee',
        title: 'Chairperson',
        name: 'Chairperson' // Temporary name until verified against MongoDB registry
      };
      g.phone = chairpersonPhone;
      g.createdAt = g.createdAt || new Date().toISOString();
      g.updatedAt = new Date().toISOString();
      g.registeredByAgent = req.session.user.phoneNumber;
      
      // Add trustees
      if (trustees && trustees.length > 0) {
          trustees.forEach((t, idx) => {
              g[`trustee_${idx + 1}`] = { 
                  name: t.name, 
                  id: t.id, 
                  phone: t.phone, 
                  type: 'trustee' 
              };
              if (idx === 0) {
                  g.trustee_1_name = t.name;
              }
          });
      }
      
      // Add officials
      if (officials && officials.length > 0) {
          officials.forEach((o, idx) => {
              g[`official_${idx + 1}`] = { 
                  name: o.name, 
                  id: o.id, 
                  phone: o.phone, 
                  type: 'official' 
              };
          });
      }
      
      // Add members
      if (members && members.length > 0) {
          members.forEach((m, idx) => {
              g[`member_${idx + 1}`] = { 
                  name: m.name, 
                  id: m.id, 
                  phone: m.phone, 
                  type: 'member' 
              };
          });
          g.totalProposedMembers = trustees.length + officials.length + members.length;
      }
      
      found = true;
  };

  const flat = flattenData(general);
  const g = flat.find(g => g.groupName === groupName);
  if (g) updateGroup(g);

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      
      // Log Registration Performance
      try {
          // Since we might not have full location here easily, we search for the group's location or use agent's location
          // For simplicity, let's assume we use the agent's location if available
          const agents = loadJSON(agentFile, []);
          const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(req.session.user.phoneNumber));
          if (agent) {
              regPerfLogger.logRegistration(agent.county, agent.constituency, agent.ward, 'groups');
              // Increment members too
              const memberCount = (trustees ? trustees.length : 0) + (officials ? officials.length : 0) + (members ? members.length : 0);
              if (memberCount > 0) {
                  regPerfLogger.logRegistration(agent.county, agent.constituency, agent.ward, 'members', memberCount);
              }
          }
      } catch (e) {
          console.error("Registration performance log error:", e);
      }

      return res.json({ success: true, message: "Group registered successfully" });
  } else {
      return res.json({ success: false, message: "Group not found." });
  }
});

// Activate new group with bypassed payment
router.post("/activate-group", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const payload = req.body;
  const { groupName: displayName, groupType, groupCertificateNumber, phone, totalMembers, totalAmount, paymentMethod, constitutionStartKey, phase, createdAt, processorPhone, agentProcessed, trustees, officials, members, messages } = payload;

  if (!trustees || trustees.length === 0) {
    return res.json({ success: false, message: "Invalid data - no trustees" });
  }

  // Get agent's location from agent.json based on session
  const agentPhone = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile, []);
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(agentPhone));
  
  if (!agent) {
    return res.json({ success: false, message: "Agent not found" });
  }

  const county = agent.county || '';
  const constituency = agent.constituency || '';
  const ward = agent.ward || '';

  if (!county) {
    return res.json({ success: false, message: "Agent location not set" });
  }

  // Load general.json
  let general = loadJSON(generalFile, {});

  // Identify/Handle Ward Groups
  let wardGroups = null;
  let isArrayStructure = false;

  // Find county (case insensitive)
  let countyKey = Object.keys(general).find(k => normStr(k) === normStr(county));
  if (!countyKey) {
      countyKey = county;
      general[countyKey] = {};
  }

  // Find constituency (case insensitive)
  let constituencyKey = Object.keys(general[countyKey]).find(k => normStr(k) === normStr(constituency));
  if (!constituencyKey) {
      constituencyKey = constituency;
      general[countyKey][constituencyKey] = {};
  }

  let constituencyObj = general[countyKey][constituencyKey];

  if (Array.isArray(constituencyObj)) {
    // It's the [WardName, Group1, ...] structure
    isArrayStructure = true;
    wardGroups = constituencyObj;
  } else {
    // Object-based structure
    if (!constituencyObj[ward]) {
        // Try to find ward case-insensitively
        const wardKey = Object.keys(constituencyObj).find(k => normStr(k) === normStr(ward));
        if (wardKey) {
            wardGroups = constituencyObj[wardKey];
        } else {
            constituencyObj[ward] = [];
            wardGroups = constituencyObj[ward];
        }
    } else {
        wardGroups = constituencyObj[ward];
    }
  }

  const groupName = displayName;

  // Check if group already exists (Use normalized comparison)
  let existingGroupIndex = -1;
  if (groupName && wardGroups) {
    existingGroupIndex = wardGroups.findIndex(g => typeof g === 'object' && g !== null && normStr(g.groupName) === normStr(groupName));
  }

  // NO BLOCK: Allow updating even if group already has members if we are in activation flow

  // Build group object following general.json arrangement
  // Field order: groupName, groupType, accountNumber, pin, createdAt, agentProcessed, phase, totalProposedMembers,
  // trustee entries, official entries, member entries, requests, groupCertificateNumber, constitution keys, principlesSetAt
  const group = {
    groupName,
    groupType: groupType || '',
    accountNumber: phone || '',
    pin: constitutionStartKey || '',
    createdAt: createdAt || new Date().toISOString(),
    agentProcessed: agentProcessed || agentPhone || 'n/a',
    phase: phase || 2,
    totalProposedMembers: totalMembers || 0
  };

  // Add trustees/officials/members
  trustees.forEach((t, i) => {
    group[`trustee_${i + 1}`] = { index: String(i + 1), type: 'trustee', ...t };
  });
  if (officials) {
    officials.forEach((o, i) => {
      group[`official_${trustees.length + i + 1}`] = { index: String(trustees.length + i + 1), type: 'official', ...o };
    });
  }
  if (members) {
    members.forEach((m, i) => {
      const idx = trustees.length + (officials ? officials.length : 0) + i + 1;
      group[`member_${idx}`] = { index: String(idx), type: 'member', ...m };
    });
  }


  // Add requests section with addMember entries
  group.requests = {
    addMember: []
  };

  // Add remaining fields in correct order
  group.groupCertificateNumber = groupCertificateNumber || '';
  group.constitutionStartKey = constitutionStartKey || '';
  group.constitutionKeyGeneratedAt = new Date().toISOString();
  group.principlesSetAt = new Date().toISOString();
  
  // Add principles object (empty for now, can be filled later)
  group.principles = {};
  
  // messages field
  group.messages = messages;

  // Update existing group or add new one
  if (existingGroupIndex >= 0) {
    const oldPhase = wardGroups[existingGroupIndex].phase || 1;
    // Update existing group
    wardGroups[existingGroupIndex] = group;

    // Log Performance Graduation (Phase 1 -> Phase 2)
    try {
        perfLogger.logActivity(county, constituency, ward, group.phase, true, oldPhase, group.totalProposedMembers);
    } catch(e) { console.error("Performance log error (Update):", e); }

    console.log(`✓ Updated existing group: ${groupName}`);
  } else {
    // Add new group
    if (isArrayStructure) {
        // Find ward index or append if missing (though usually it should be there)
        let wardIdx = wardGroups.findIndex(item => typeof item === 'string' && normStr(item) === normStr(ward));
        if (wardIdx === -1) {
            wardGroups.push(ward);
            wardGroups.push(group);
        } else {
            // Insert after the ward name
            wardGroups.splice(wardIdx + 1, 0, group);
        }
    } else {
        wardGroups.push(group);
    }

    // Increment regional counts only for new groups
    general[county].countyGroupCount = (general[county].countyGroupCount || 0) + 1;
    if (constituency) {
      if (typeof general[county][constituency] === 'object' && !Array.isArray(general[county][constituency])) {
          general[county][constituency].constituencyGroupCount = (general[county][constituency].constituencyGroupCount || 0) + 1;
          if (ward && general[county][constituency][ward]) {
              general[county][constituency][ward].wardGroupCount = (general[county][constituency][ward].wardGroupCount || 0) + 1;
          }
      }
    }
    console.log(`✓ Created new group: ${groupName}`);

    // Log Performance New Activity (Starts at Phase 2)
    try {
        perfLogger.logActivity(county, constituency, ward, group.phase, false, null, group.totalProposedMembers);
        // Also log registration performance
        regPerfLogger.logRegistration(county, constituency, ward, 'groups');
        if (group.totalProposedMembers > 0) {
            regPerfLogger.logRegistration(county, constituency, ward, 'members', group.totalProposedMembers);
        }
    } catch(e) { console.error("Performance log error (Create):", e); }
  }

  // Send Notifications
  try {
    const agentName = agent.name || "System Agent";
    notification.sendActivationNotices(group, payload, agentName, agentPhone);
  } catch (e) {
    console.error("Notification broadcast error:", e);
  }

  // Save
  try {
    fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
    res.json({ success: true, message: existingGroupIndex >= 0 ? "Group updated successfully" : "Group activated successfully", groupName });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: "Failed to save" });
  }
});

// POST /agent/verify-user - Verify member exists in MongoDB counties registry
router.post("/verify-user", async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { phone } = req.body;
  let user = null;
  try {
    user = await findUserByPhone(phone);
  } catch (dbErr) {
    console.error("[AGENT] verify-user MongoDB error:", dbErr.message);
  }
  if (!user) {
    const users = await getUsersFromMongo();
    user = findUserInList(users, phone);
  }

  if (user) {
    return res.json({ success: true, name: formatUserName(user) });
  }
  return res.json({ success: false, message: "User not found in registry." });
});

// GET /agent/group-form/:groupName - Display group registration form
router.get("/group-form/:groupName", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const { groupName } = req.params;
  const decodedGroupName = decodeURIComponent(groupName);
  const agents = loadJSON(agentFile);
  const general = flattenData(loadJSON(generalFile, {}));

  const currentPhoneNumber = req.session.user.phoneNumber;
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  if (!agent) {
    return res.status(403).json({ error: "Agent not found" });
  }

  // Find group
  let group = general.find(g => g.groupName === decodedGroupName);
  if (!group) {
    group = general.find(g => g.groupName && g.groupName.toLowerCase() === decodedGroupName.toLowerCase());
  }

  if (!group) {
    return res.status(404).json({
      error: `Group "${decodedGroupName}" not found`
    });
  }

  const tbank = require('../tbank.json');
  const users = await getUsersFromMongo();

  // Get next form reference number from general.json
  const generalData = loadJSON(generalFile, {});
  let totalDownloads = 0;
  
  // Search through nested structure
  for (const county in generalData) {
    for (const constituency in generalData[county]) {
      const wards = generalData[county][constituency];
      if (Array.isArray(wards)) {
        for (const group of wards) {
          if (group.groupName && group.groupName.toLowerCase() === decodedGroupName.toLowerCase()) {
            totalDownloads = group.formDownloads ? group.formDownloads.length : 0;
            break;
          }
        }
      }
    }
  }
  const nextFormRef = String(totalDownloads + 1).padStart(3, '0');

  const getNameByPhone = (phone) => formatUserName(findUserInList(users, phone));

  // Populate names for trustees, officials, members
  Object.keys(group).forEach(key => {
    if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
      if (group[key] && group[key].phone) {
        group[key].name = getNameByPhone(group[key].phone);
      }
    }
  });

  res.render("group_form", {
    agent: agent,
    group: group,
    user: req.session.user,
    tbank: tbank,
    userPhone: req.session.user ? req.session.user.phoneNumber : null,
    formRefNumber: nextFormRef
  });
});

// GET /agent/group-registration-pdf/:groupName - Download group registration form PDF
router.get("/group-registration-pdf/:groupName", async (req, res) => {
  try {
    // Check authorization first
    if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { groupName } = req.params;
    const decodedGroupName = decodeURIComponent(groupName);
    const agents = loadJSON(agentFile);
    const general = flattenData(loadJSON(generalFile, {}));
    const users = await getUsersFromMongo();

    const currentPhoneNumber = req.session.user.phoneNumber;
    const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

    if (!agent) {
      return res.status(403).json({ error: "Agent not found" });
    }

    // Find group - try exact match first, then case-insensitive
    let group = general.find(g => g.groupName === decodedGroupName);
    if (!group) {
      group = general.find(g => g.groupName && g.groupName.toLowerCase() === decodedGroupName.toLowerCase());
    }



    if (!group) {
      return res.status(404).json({
        error: `Group "${decodedGroupName}" not found`,
        availableGroups: general.map(g => g.groupName)
      });
    }

  const userMap = buildUserDetailMap(users);

  // Collect members
  const members = [];
  for (const key in group) {
    if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
      let member = group[key];
      let phone = null;
      let name = '';
      let id = '';
      let title = '';
      let index = 0;

      if (member && typeof member === 'object' && member.phone) {
        phone = member.phone;
        name = member.name || '';
        id = member.id || '';
        title = member.title || '';
        index = member.index || 0;
      } else if (typeof member === 'string') {
        phone = member;
      }

      if (phone) {
        const normalizedPhone = normPhone(phone);
        const userData = userMap.get(normalizedPhone);
        if (userData) {
          name = userData.name;
          id = userData.id;
        }

        const role = key.split('_')[0];
        // Set default titles for trustees if not specified
        if (role === 'trustee' && !title) {
          const trusteeIndex = parseInt(key.split('_')[1]) || 1;
          if (trusteeIndex === 1) title = 'Chairperson';
          else if (trusteeIndex === 2) title = 'Treasurer';
          else if (trusteeIndex === 3) title = 'Secretary';
          else title = 'Trustee';
        }

        members.push({
          role: role.charAt(0).toUpperCase() + role.slice(1),
          name: name,
          phone: phone,
          id: id,
          title: title,
          index: index || members.length + 1
        });
      }
    }
  }

  // Sort members by index
  members.sort((a, b) => a.index - b.index);



    // All validation passed, now generate PDF
    const filename = `${decodedGroupName.replace(/\s+/g, '_')}_Registration_Form.pdf`;

    // Set headers BEFORE any response
    res.setHeader('Content-disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-type', 'application/pdf');

    let doc;
    try {
      doc = new PDFDocument();
      doc.pipe(res);
    } catch (pdfError) {
      console.error('PDF Document creation error:', pdfError);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating PDF document' });
      }
      return;
    }

  // Professional Header
  let infoBoxY;
  try {
    doc.fontSize(18);
    doc.text('T-BANK INVESTMENT GROUP', { align: 'center' });
    doc.fontSize(14);
    doc.text('REGISTRATION FORM', { align: 'center' });
    doc.moveDown(0.5);

    // Decorative line
    doc.moveTo(100, doc.y).lineTo(500, doc.y).stroke();
    doc.moveDown(1);

    // Group Information Box
    infoBoxY = doc.y;
    doc.rect(50, infoBoxY, 500, 50).stroke();
    doc.fontSize(11);
  } catch (headerError) {
    console.error('Header generation error:', headerError);
    doc.end();
    return res.status(500).send('Error generating PDF header');
  }

  doc.text(`Location: ${group.county} | ${group.constituency} | ${group.ward}`, 70, infoBoxY + 10);
  doc.text(`Registration Agent: ${agent.name}`, 70, infoBoxY + 25);
  doc.text(`Agent Contact: ${agent.phoneNumber}`, 320, infoBoxY + 25);

doc.y = infoBoxY + 70;
  doc.moveDown();

  // Load tbank.json for membership requirements
  const tbank = loadJSON('tbank.json', {});
  const membership = tbank.compliance?.membership || {};
  const trusteesCount = parseInt(membership.trustees) || 4;
  const officialsCount = parseInt(membership.officials) || 4;
  const maxMembers = parseInt(membership.maxMembers) || 40;
  const regularMembersCount = maxMembers - trusteesCount - officialsCount;

  // Find chairperson phone number from existing members
  const chairperson = members.find(m => m.title === 'Chairperson');
  const chairpersonPhone = chairperson ? chairperson.phone : '';

  // Helper function to draw section table with grid lines
  function drawSectionTable(sectionTitle, rowCount, isTrusteesSection = false) {
    // Check if we need a new page
    if (doc.y > 700) {
      doc.addPage();
    }

    doc.fontSize(12);
    doc.text(sectionTitle, { underline: true });
    doc.moveDown(0.3);

    const tableTop = doc.y;
    const rowHeight = 15;
    const colWidths = [40, 80, 140, 250, 370, 470, 570];
    const tableWidth = 540;

    // Table headers
    doc.fontSize(10);
    doc.text('Index', 40, tableTop);
    doc.text('Title', 80, tableTop);
    doc.text('Name', 140, tableTop);
    doc.text('Phone Number', 250, tableTop);
    doc.text('ID Number', 370, tableTop);
    doc.text('ID (Optional)', 470, tableTop);

    // Header underline
    doc.moveTo(30, tableTop + 12).lineTo(570, tableTop + 12).stroke();

    // Table content
    let yPosition = tableTop + 20;

    for (let i = 0; i < rowCount; i++) {
      // Check if we need a new page mid-table
      if (yPosition > 750) {
        doc.addPage();
        yPosition = 50;
      }

      doc.fontSize(9);

      // Index column - empty for manual input
      doc.text('', 40, yPosition);

      // Title column
      if (isTrusteesSection && i === 0) {
        doc.text('Chairperson', 80, yPosition);
      } else if (isTrusteesSection && i === 1) {
        doc.text('Treasurer', 80, yPosition);
      } else if (isTrusteesSection && i === 2) {
        doc.text('Secretary', 80, yPosition);
      } else if (isTrusteesSection && i === 3) {
        doc.text('Trustee', 80, yPosition);
      } else {
        doc.text('', 80, yPosition);
      }

      // Name column - empty
      doc.text('', 140, yPosition);

      // Phone Number column - pre-populate chairperson only
      if (isTrusteesSection && i === 0 && chairpersonPhone) {
        doc.text(chairpersonPhone, 250, yPosition);
      } else {
        doc.text('', 250, yPosition);
      }

      // ID Number column - empty
      doc.text('', 370, yPosition);

      // ID (Optional) column - empty
      doc.text('', 470, yPosition);

      // Row separator (horizontal line)
      doc.moveTo(30, yPosition + 12).lineTo(570, yPosition + 12).stroke();
      yPosition += rowHeight;
    }

    // Draw vertical lines for all columns
    for (let i = 0; i < colWidths.length; i++) {
      doc.moveTo(colWidths[i], tableTop - 5).lineTo(colWidths[i], yPosition).stroke();
    }

    // Section border
    doc.rect(30, tableTop - 5, tableWidth, yPosition - tableTop + 5).stroke();
    doc.moveDown(0.5);
  }

  // Draw Trustees Section
  try {
    drawSectionTable('TRUSTEES SECTION', trusteesCount, true);
  } catch (trusteesError) {
    console.error('Trustees section error:', trusteesError);
  }

  // Draw Officials Section
  try {
    drawSectionTable('OFFICIALS SECTION', officialsCount, false);
  } catch (officialsError) {
    console.error('Officials section error:', officialsError);
  }

  // Draw Regular Members Section
  try {
    drawSectionTable('REGULAR MEMBERS SECTION', regularMembersCount, false);
  } catch (membersError) {
    console.error('Members section error:', membersError);
  }

  // Signature sections
  doc.moveDown(2);
  const signatureY = doc.y;
  const leftX = 50;
  const rightX = 320;

  // Prepared By Section - Left Column
  doc.fontSize(12);
  doc.text('PREPARED BY', leftX, signatureY);
  doc.moveTo(leftX, signatureY + 15).lineTo(leftX + 200, signatureY + 15).stroke();

  doc.fontSize(10);
  doc.text('Title/Position:', leftX, signatureY + 25);
  doc.text('Phone Number:', leftX, signatureY + 45);
  doc.text('Name:', leftX, signatureY + 65);
  doc.text('Date:', leftX, signatureY + 85);

  // Signature line
  doc.text('Signature:', leftX, signatureY + 105);
  doc.moveTo(leftX + 60, signatureY + 120).lineTo(leftX + 200, signatureY + 120).stroke();

  // Chairperson Section - Right Column
  doc.fontSize(12);
  doc.text('CHAIRPERSON APPROVAL', rightX, signatureY);
  doc.moveTo(rightX, signatureY + 15).lineTo(rightX + 200, signatureY + 15).stroke();

  doc.fontSize(10);
  doc.text('Phone Number:', rightX, signatureY + 25);
  doc.text('Name:', rightX, signatureY + 45);
  doc.text('Date:', rightX, signatureY + 85);

  // Signature line
  doc.text('Signature:', rightX, signatureY + 105);
  doc.moveTo(rightX + 60, signatureY + 120).lineTo(rightX + 200, signatureY + 120).stroke();

  // Chairperson instructions
  doc.moveDown(1);
  doc.fontSize(8);
  doc.text('Chairperson details pre-populated in Trustees section. Verify and update ID Number if needed.', rightX, doc.y, { width: 200, align: 'left' });
  doc.text('Chairperson must sign to approve all member registrations.', rightX, doc.y + 10, { width: 200, align: 'left' });

  doc.end();
  } catch (error) {
    console.error('Route error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error', details: error.message });
    }
  }
});

// GET /agent/con-group - Display specific group details for Phase 2 (Pending Approval) groups
router.get("/con-group", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const { groupName } = req.query;
  if (!groupName) {
    return res.redirect("/agent");
  }

  const agents = loadJSON(agentFile);
  const general = flattenData(loadJSON(generalFile, {}));
  const users = await getUsersFromMongo();

  const currentPhoneNumber = req.session.user.phoneNumber;
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  if (!agent) {
    return res.redirect("/agent");
  }

  // Find the specific group
  const group = general.find(g => g.groupName === groupName);
  if (!group) {
    return res.redirect("/agent");
  }

  const userMap = buildUserNameMap(users);

  // Augment group with membersList if populated
  if (group.membersPopulatedAt || (group.phase && group.phase >= 2)) {
    group.membersList = [];
    for (const key in group) {
      if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
        let member = group[key];
        let phone = null;

        if (member && typeof member === 'object' && member.phone) {
          phone = member.phone;
        } else if (typeof member === 'string') {
          phone = member;
        }

        if (phone) {
          const normalizedPhone = normPhone(phone);
          const memberName = userMap.get(normalizedPhone) || (typeof member === 'object' && member.name ? member.name : '') || 'Unknown Name';

          const memberObj = typeof member === 'object' ? { ...member } : { phone: phone, type: key.split('_')[0] };
          memberObj.name = memberName;
          group.membersList.push(memberObj);
        }
      }
    }
  }

  const existingKey = group.constitutionStartKey || null;
  const hasExistingKey = existingKey && !existingKey.startsWith('$2b$');
  const keyValue = hasExistingKey ? existingKey : null;

  res.render("agent/con_group", {
    agent: agent,
    group: group,
    user: req.session.user,
    userMap: userMap,
    existingKey: keyValue,
    keyRequired: !hasExistingKey
  });
});

// GET /conform - View/download constitution form
router.get("/conform", async (req, res) => {
  const { groupName } = req.query;
  
  if (!groupName) {
    return res.redirect("/agent");
  }
  
  const generalData = loadJSON(generalFile, {});
  const flatGroups = flattenData(generalData);
  const group = flatGroups.find(g => g.groupName === groupName);
  
  if (!group) {
    return res.status(404).send("Group not found");
  }
  
  const users = await getUsersFromMongo();
  const userMap = buildUserNameMap(users);

   res.render("agent/conform", {
     group: group,
     user: req.session.user,
     userMap: userMap
   });
 });

  // GET /agent/group-performance - Display group performance dashboard
  router.get("/group-performance", async (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
      return res.redirect("/login");
    }

     const { groupName } = req.query;
     if (!groupName) {
       return res.redirect("/agent");
     }

     const generalData = loadJSON(generalFile, {});
     const flatGroups = flattenData(generalData);
     const group = flatGroups.find(g => g.groupName === groupName);

     if (!group) {
       return res.status(404).send("Group not found");
     }

     const agents = loadJSON(agentFile);
      const membersData = loadJSON(path.join(__dirname, "../tran_account/member.json"), {});
      const groupAccountsData = loadJSON(path.join(__dirname, "../tran_account/group.json"), {});
      const users = await getUsersFromMongo();

      const currentPhoneNumber = req.session.user.phoneNumber;
      const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

      if (!agent) {
        return res.redirect("/agent");
      }

      const userMap = buildUserNameMap(users);

       // Find corresponding group in member.json (handles both regional and flat formats)
       let groupMembersData = {};
       let groupFinancials = {};
       let groupAccountSchema = {};

       // Helper: flatten regional member.json -> { [groupName]: { members, groupFinancials, accountSchema } }
       const flattenMemberData = (md) => {
         const flat = {};
         if (md.groups) {
           // Old flat format
           for (const [gKey, g] of Object.entries(md.groups)) {
             flat[(g.groupName || gKey).trim()] = {
               members: g.members || {},
               groupFinancials: g.groupFinancials || {},
               accountSchema: g.accountSchema || {}
             };
           }
         } else if (typeof md === 'object' && !Array.isArray(md)) {
           // New regional format: county -> constituencies -> wards -> data[]
           for (const county in md) {
             if (!md[county].constituencies) continue;
             for (const cons of md[county].constituencies) {
               for (const ward of cons.wards) {
                 if (Array.isArray(ward.data)) {
                   ward.data.forEach(g => {
                     const gname = (g.groupName || '').trim();
                     if (!gname) return;
                     flat[gname] = {
                       members: g.regionalMembers || {},
                       groupFinancials: g.groupFinancials || {},
                       accountSchema: g.accountSchema || {}
                     };
                   });
                 }
               }
             }
           }
         }
         return flat;
       };

       const flatMembers = flattenMemberData(membersData);
       const normalizedGroupName = normStr(groupName);
       const match = flatMembers[normalizedGroupName];
       if (match) {
         groupMembersData = match.members;
         groupFinancials = match.groupFinancials;
         groupAccountSchema = match.accountSchema;
       }

    // Enhance group with member details from member.json
    const enrichedMembers = {};
    Object.keys(groupMembersData).forEach(memberId => {
      const memberData = groupMembersData[memberId];
      const normalizedPhone = normPhone(memberId);
      const memberName = userMap.get(normalizedPhone) || memberData.name || 'Unknown';

      enrichedMembers[memberId] = {
        ...memberData,
        name: memberName,
        phone: memberId
      };
    });

     // Attach enriched members, group financials, and account schema to group object
     group.members = enrichedMembers;
     group.groupFinancials = groupFinancials;
     group.accountSchema = groupAccountSchema;

      // Extract Savings account closing balance from group.json
      let savingsClosingBalance = 0;
      let totalGroupClosingBalance = 0;
      let totalGroupAmountIn = 0;
      let benefitAccountsTotal = 0;
      const groupDataKey = Object.keys(groupAccountsData.groupData || {}).find(key =>
        groupAccountsData.groupData[key] &&
        groupAccountsData.groupData[key].groupName &&
        normStr(groupAccountsData.groupData[key].groupName) === normStr(groupName)
      );

      if (groupDataKey && groupAccountsData.groupData[groupDataKey].groupFinancials) {
        const groupFinancials = groupAccountsData.groupData[groupDataKey].groupFinancials;
        totalGroupClosingBalance = parseFloat(groupFinancials.totalClosingBalance) || 0;
        totalGroupAmountIn = parseFloat(groupFinancials.totalAmountIn) || 0;

        // accountWise is nested inside groupFinancials
        const accountWise = groupFinancials.accountWise || {};
        const savingAccount = accountWise["001"];
        if (savingAccount) {
          savingsClosingBalance = parseFloat(savingAccount.closingBalance) || 0;
        }

        // Calculate Benefit Accounts Total from principles.balancing.benefitAccounts
        const benefitAccountNames = (group.principles?.balancing?.benefitAccounts || []);
        Object.values(accountWise).forEach(acc => {
          if (benefitAccountNames.includes(acc.accountName)) {
            benefitAccountsTotal += parseFloat(acc.closingBalance) || 0;
          }
        });
      }

    // Get performance data for this group's county/constituency/ward if available
    const perfData = require("../performance/group-performance").readPerformance();
    const county = group.county;
    const constituency = group.constituency;
    const ward = group.ward;

     let groupPerf = null;
     if (perfData.counties[county] && perfData.counties[county].constituencies[constituency] &&
         perfData.counties[county].constituencies[constituency].wards[ward]) {
       groupPerf = perfData.counties[county].constituencies[constituency].wards[ward];
     }

     // Merge group base data with performance data (if exists)
     // Performance data should not overwrite group-level fields like totalProposedMembers, groupFinancials
     const mergedGroupData = groupPerf ? { ...group, ...groupPerf } : group;

     // Ensure critical group-level fields are preserved
     mergedGroupData.totalProposedMembers = group.totalProposedMembers;
     mergedGroupData.groupFinancials = group.groupFinancials;

      res.render("agent/group_performance", {
        agent: agent,
        group: group,
        user: req.session.user,
        userMap: userMap,
        performance: groupPerf,
        groupData: mergedGroupData,
        totalMembers: group.totalProposedMembers, // explicit separate variable
        savingsClosingBalance: savingsClosingBalance,
        totalClosingBalance: totalGroupClosingBalance,
        totalAmountIn: totalGroupAmountIn,
        benefitAccountsTotal: benefitAccountsTotal
      });
  });

module.exports = router;