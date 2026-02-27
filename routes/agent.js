const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const agentFile = path.join(__dirname, "../agent.json");
const generalFile = path.join(__dirname, "../general.json");
const dealerFile = path.join(__dirname, "../dealer.json");

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

  // 2. Agent Found, No PIN (Create PIN)
  if (!agent.pin) {
    return renderSafe("create-pin");
  }

  // 3. Agent Found, Has PIN - Enforce PIN entry on every visit unless just logged in
  if (req.session.justLoggedIn) {
    req.session.justLoggedIn = false;
    // The session is still considered verified for this one request.
  } else {
    // For any subsequent request, the agent is no longer considered verified.
    req.session.agentVerified = false;
  }

  // Save the updated session state.
  req.session.save((err) => {
    if (err) {
      console.error("Session save error:", err);
      return res.status(500).send("Server error");
    }

    // Now, after the session is saved, check if the agent is verified.
    if (!req.session.agentVerified) {
      return renderSafe("enter-pin");
    }

    // If verified, render the dashboard.
    const generalRaw = loadJSON(generalFile);
    const general = flattenData(generalRaw);
    
    // 🔥 Improved filtering: Match by Ward/County/Const OR by Processor Phone
    const managedGroups = general.filter((g) => {
        // Normalize ward names for comparison (handle case differences)
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

        // Link by Ward (within same area) OR explicit Processing link
        const matches = (sameWard && sameCounty && sameConst) || isProcessor || isAgentProcessed;
        
        // Debug logging (can be removed in production)
        if (matches) {
          console.log(`Group "${g.groupName}" matched for agent ${agent.phoneNumber}: sameWard=${sameWard}, sameCounty=${sameCounty}, sameConst=${sameConst}, isProcessor=${isProcessor}, isAgentProcessed=${isAgentProcessed}`);
        }
        
        return matches;
    });

    const dealers = loadJSON(dealerFile);
    const dealer = (agent && Array.isArray(dealers)) ? dealers.find(d => normPhone(d.phoneNumber) === normPhone(agent.dealerPhone)) : null;

    const displayAgent = agent ? { ...agent, name: agent.name } : { phoneNumber: currentPhoneNumber, name: "Unknown Agent" }; // Ensure agent.name is used here

    res.render("agent/agent", { step: "dashboard", agent: displayAgent, groups: managedGroups, dealer: dealer, message: null, phoneNumber: currentPhoneNumber, user: (req.session && req.session.user) || { phoneNumber: currentPhoneNumber } });
  });
});

// POST /agent/login - Verify PIN
router.post("/login", async (req, res) => {
  try {
    // 1. Enforce Login
    if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
      return res.redirect("/login");
    }

    const { pin } = req.body;
    const phoneNumber = req.session.user.phoneNumber; // STRICTLY use session number
    
    const agents = loadJSON(agentFile);
    const agent = agents.find((a) => normPhone(a.phoneNumber) === normPhone(phoneNumber));

    if (!agent) {
      return res.render("agent/agent", {
        step: "enter-pin",
        phoneNumber: phoneNumber,
        agentName: "Unknown Agent", // Generic name if agent not found
        user: req.session.user,
        message: { type: "error", text: "Agent not found." },
        groups: [],
        dealer: null
      });
    }

    if (agent && agent.pin && await bcrypt.compare(pin, agent.pin)) {
      req.session.agentVerified = true;
      req.session.justLoggedIn = true;
      // Explicitly save session to ensure the 'agentVerified' flag is persisted before redirect
      req.session.save(() => {
        res.redirect("/agent");
      });
    } else {
      res.render("agent/agent", {
        step: "enter-pin",
        phoneNumber: phoneNumber,
        agentName: agent.name, // Use found agent's name
        agent: { name: agent.name, phoneNumber: agent.phoneNumber },
        user: req.session.user,
        message: { type: "error", text: "Invalid PIN" },
        groups: [],
        dealer: null
      });
    }
  } catch (err) {
    console.error("Error in agent login:", err);
    res.render("agent/agent", {
      step: "enter-pin",
      phoneNumber: req.session.user.phoneNumber,
      agentName: "Error",
      user: req.session.user,
      message: { type: "error", text: "An error occurred. Please try again." },
      groups: [],
      dealer: null
    });
  }
});

// POST /agent/set-pin - Create PIN
router.post("/set-pin", async (req, res) => {
  // 1. Enforce Login
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized: Please log in." });
  }

  const phoneNumber = req.session.user.phoneNumber; // STRICTLY use session number
  const { pin } = req.body;
  
  if (!pin) {
    return res.json({ success: false, message: "Missing data" });
  }

  const agents = loadJSON(agentFile);
  const index = agents.findIndex((a) => normPhone(a.phoneNumber) === normPhone(phoneNumber));

  if (index === -1) {
    return res.json({ success: false, message: "Agent not found" });
  }

  try {
    const hashedPin = await bcrypt.hash(pin, 10);
    agents[index].pin = hashedPin;
    fs.writeFileSync(agentFile, JSON.stringify(agents, null, 2));
    // Removed auto-login to force user to enter the new PIN immediately
    // if (req.session) req.session.agentVerified = true;
    req.session.save(() => {
      res.json({ success: true });
    });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: "Server error" });
  }
});

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

module.exports = router;