const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const agentFile = path.join(__dirname, "../agent.json");
const generalFile = path.join(__dirname, "../general.json");
const dealerFile = path.join(__dirname, "../dealer.json");
const dataFile = path.join(__dirname, "../data.json");

const loadJSON = (file) => {
  if (!fs.existsSync(file)) return [];
  try {
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error("Error reading JSON:", e);
    return [];
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

// GET /agent
router.get("/", (req, res) => {
  // Prevent caching to ensure strict PIN entry logic works on back/forward navigation
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  // 1. Enforce Login: If no session exists, redirect to login immediately.
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  // 2. Use the logged-in user's phone number
  const currentPhoneNumber = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile);
  const users = loadJSON(dataFile);

  // Create a map for faster user name lookups
  const userMap = new Map();
  if (Array.isArray(users)) {
    users.forEach(u => {
        // Filter out empty strings and join with space
        const parts = [u.FirstName, u.MiddleName, u.LastName].map(s => s && String(s).trim()).filter(Boolean);
        if (u.phoneNumber) userMap.set(normPhone(u.phoneNumber), parts.join(' '));
    });
  }

  const agent = agents.find((a) => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  // Helper to render safe views (No dashboard data)
  const renderSafe = (step, msg = null) => {
    return res.render("agent/agent", {
      step: step,
      phoneNumber: currentPhoneNumber,
      agentName: agent ? agent.name : "Unknown",
      agent: agent ? { name: agent.name, phoneNumber: agent.phoneNumber } : null, // Strict sanitization
      user: req.session.user,
      message: msg,
      groups: [], // BLOCK dashboard content
      dealer: null // BLOCK dashboard content
    });
  };

  // If the determined phone number doesn't belong to an agent
  if (!agent) {
    return renderSafe("not-agent", { type: "error", text: "Not qualified to be an agent." });
  }

  // Render the dashboard directly.
  const generalRaw = loadJSON(generalFile);
  const general = flattenData(generalRaw);
  
  const managedGroups = general.filter((g) => {
      const groupWard = g.ward ? normStr(g.ward) : "";
      const agentWard = agent.ward ? normStr(agent.ward) : "";
      const sameWard = groupWard && agentWard && groupWard === agentWard;
      
      const groupCounty = g.county ? normStr(g.county) : "";
      const agentCounty = agent.county ? normStr(agent.county) : "";
      const sameCounty = !agentCounty || (groupCounty && groupCounty === agentCounty);
      
      const groupConst = g.constituency ? normStr(g.constituency) : "";
      const agentConst = agent.constituency ? normStr(agent.constituency) : "";
      const sameConst = !agentConst || (groupConst && groupConst === agentConst);
      
      const isProcessor = g.processorPhone && normPhone(g.processorPhone) === normPhone(agent.phoneNumber);
      const isAgentProcessed = g.agentProcessed && normPhone(g.agentProcessed) === normPhone(agent.phoneNumber);

      return (sameWard && sameCounty && sameConst) || isProcessor || isAgentProcessed;
  });

  // Augment managed groups with a list of members including their full names
  managedGroups.forEach(group => {
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
                // Lookup name from data.json, fallback to existing name, fallback to 'Unknown'
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
  });

  const dealers = loadJSON(dealerFile);
  const dealer = (agent && Array.isArray(dealers)) ? dealers.find(d => normPhone(d.phoneNumber) === normPhone(agent.dealerPhone)) : null;

  const displayAgent = agent ? { ...agent, name: agent.name } : { phoneNumber: currentPhoneNumber, name: "Unknown Agent" };

  res.render("agent/agent", { 
    step: "dashboard", 
    agent: displayAgent, 
    groups: managedGroups, 
    dealer: dealer, 
    message: null, 
    phoneNumber: currentPhoneNumber, 
    user: (req.session && req.session.user) || { phoneNumber: currentPhoneNumber } 
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

  if (Array.isArray(general)) {
       const g = general.find(g => g.groupName === groupName);
       if (g) updateGroup(g);
  } else {
       // Traverse Hierarchy
       for (const c in general) {
           if (typeof general[c] !== 'object') continue;
           for (const co in general[c]) {
               if (typeof general[c][co] !== 'object') continue;
               for (const w in general[c][co]) {
                   const list = general[c][co][w];
                   if (Array.isArray(list)) {
                       const g = list.find(g => g.groupName === groupName);
                       if (g) updateGroup(g);
                   }
               }
           }
       }
  }

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      return res.json({ success: true });
  } else {
      return res.json({ success: false, message: "Group not found." });
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
        name: 'Chairperson' // Temporary name until verified against data.json
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

  if (Array.isArray(general)) {
       const g = general.find(g => g.groupName === groupName);
       if (g) updateGroup(g);
  } else {
       // Traverse Hierarchy
       for (const c in general) {
           if (typeof general[c] !== 'object') continue;
           for (const co in general[c]) {
               if (typeof general[c][co] !== 'object') continue;
               for (const w in general[c][co]) {
                   const list = general[c][co][w];
                   if (Array.isArray(list)) {
                       const g = list.find(g => g.groupName === groupName);
                       if (g) updateGroup(g);
                   }
               }
           }
       }
  }

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      return res.json({ success: true, message: "Group registered successfully" });
  } else {
      return res.json({ success: false, message: "Group not found." });
  }
});

// POST /agent/verify-user - Verify member exists in data.json
router.post("/verify-user", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { phone } = req.body;
  const users = loadJSON(dataFile);
  const normalized = normPhone(phone);
  
  const user = users.find(u => normPhone(u.phoneNumber) === normalized);
  
  if (user) {
      // Construct full verified name
      const name = [user.FirstName, user.MiddleName, user.LastName].map(s => s && String(s).trim()).filter(Boolean).join(' ');
      return res.json({ success: true, name: name });
  } else {
      return res.json({ success: false, message: "User not found in registry." });
  }
});

module.exports = router;