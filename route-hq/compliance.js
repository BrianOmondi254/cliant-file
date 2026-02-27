const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// Path to JSON database
const DB_PATH = path.join(__dirname, "..", "tbank.json");


const protectHq = (req, res, next) => {
  if (!req.session.hqUser) {
    return res.status(403).send("Access Forbidden. Please <a href='/hq'>log in</a> as an HQ user.");
  }
  next();
};

// Middleware
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Database helpers
const getDefaultStructure = () => ({
  compliance: {
    registration: null,
    membership: null,
    periods: null,
    completed: false,
  },
});

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    return getDefaultStructure();
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    if (!raw.trim()) return getDefaultStructure();

    let data = JSON.parse(raw);

    // CRITICAL FIX: Ensure root is an object, not an array
    if (Array.isArray(data)) {
      // If we find an array, we must preserve any data if possible or reset
      // For safety in this app context where it expects an object:
      data = {};
    }

    // Ensure compliance section exists
    if (!data.compliance) {
      data.compliance = getDefaultStructure().compliance;
    }
    return data;
  } catch (e) {
    console.error("Error reading DB:", e);
    return getDefaultStructure();
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    console.log(`[DB SAVED] ${DB_PATH}`);
    return true;
  } catch (e) {
    console.error("Error writing DB:", e);
    return false;
  }
}

function checkCompletion(compliance) {
  // Returns true if all subsections are present (truthy)
  return Boolean(
    compliance &&
      compliance.registration &&
      compliance.membership &&
      compliance.periods
  );
}

// ======================
// ROUTES
// ======================

// Render compliance dashboard with current data
router.get("/compliance", (req, res) => {
  const db = readDB();
  const compliance = db.compliance || getDefaultStructure().compliance;

  // Destructure with fallbacks to empty objects to prevent EJS ReferenceErrors
  // This ensures properties like 'registration.newGroupFee' won't crash even if 'registration' is null/undefined
  const { registration = {}, membership = {}, periods = {} } = compliance;

  // Read dealer counts
  let dealerCounts = {};
  if (fs.existsSync(DEALER_JSON)) {
    try {
      const raw = fs.readFileSync(DEALER_JSON, "utf8").trim();
      if (raw) {
        const dealers = JSON.parse(raw);
        dealerCounts = dealers._dealerCounts || {};
      }
    } catch (e) {
      console.error("Error reading dealer counts:", e);
    }
  }

  const hqUser = req.session.hqUser || null;
  let userCounty = null;
  let userConstituency = null;
  if (hqUser && hqUser.phoneNumber) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8").trim();
      if (raw) {
        const data = JSON.parse(raw);
        const user = data.find((u) => u.phoneNumber === hqUser.phoneNumber);
        if (user) {
          userCounty = user.county;
          userConstituency = user.constituency;
        }
      }
    } catch (e) {
      console.error("Error reading data.json:", e);
    }
  }

  res.render("hq/compliance", {
    registration: registration || {},
    membership: membership || {},
    periods: periods || {},
    hqUser: hqUser,
    dealerCounts: dealerCounts,
    userCounty: userCounty,
    userConstituency: userConstituency,
  });
});

// Save Registration Standards
router.post("/compliance/registration", (req, res) => {
  const { nf, rf, paymentMethod } = req.body;
  if (!nf || !rf) {
    return res
      .status(400)
      .json({ success: false, message: "Missing fee values" });
  }

  const db = readDB();
  // Ensure we don't null-ref if compliance got wiped
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  let generatedPasskey = null;
  if (paymentMethod === "passkey") {
    generatedPasskey = Math.floor(1000 + Math.random() * 9000).toString();
  }

  db.compliance.registration = {
    newGroupFee: nf,
    renewalFee: rf,
    paymentMethod: paymentMethod || "mpesa",
    passkey: generatedPasskey,
    updatedAt: new Date().toISOString(),
  };

  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({
    success: true,
    message: "Registration standards saved",
    passkey: generatedPasskey,
  });
});

// Save Membership Standards
router.post("/compliance/membership", (req, res) => {
  const { trustees, officials, members, maxMembers } = req.body;
  if (!trustees || !officials || !members) {
    return res
      .status(400)
      .json({ success: false, message: "Missing membership values" });
  }

  const db = readDB();
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  db.compliance.membership = {
    trustees,
    officials,
    members,
    maxMembers: maxMembers || members, // Default to members if not provided
    updatedAt: new Date().toISOString(),
  };

  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({ success: true, message: "Membership rules saved" });
});

// Save Periods Configuration
router.post("/compliance/periods", (req, res) => {
  const { interval, season } = req.body;
  if (!interval || !season) {
    return res
      .status(400)
      .json({ success: false, message: "Missing period values" });
  }

  const db = readDB();
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  db.compliance.periods = {
    interval,
    season,
    updatedAt: new Date().toISOString(),
  };

  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({ success: true, message: "Period configuration saved" });
});

// Save Personal Account Registration Adjustment
router.post("/compliance/adjust-registration", (req, res) => {
  const { amount, paymentMethod, passkey } = req.body;

  if (!amount || !paymentMethod) {
    return res
      .status(400)
      .json({ success: false, message: "Missing amount or payment method" });
  }

  const db = readDB();
  if (!db.compliance) {
    db.compliance = getDefaultStructure().compliance;
  }

  let finalPasskey = passkey;

  if (paymentMethod === "mpesa") {
    // This method is to automate a Mpesa API to prompt the amount selected above
    // that will be deducted from Mpesa account, after prompt enter pin and related field.
    finalPasskey = Math.floor(10000 + Math.random() * 90000).toString();
  } else if (paymentMethod === "passkey" && !finalPasskey) {
    finalPasskey = Math.floor(1000 + Math.random() * 9000).toString();
  }

  db.compliance.personal_account_registration = {
    amount,
    paymentMethod,
    passkey: finalPasskey || null,
    updatedAt: new Date().toISOString(),
  };

  writeDB(db);

  res.json({
    success: true,
    message: "Personal account registration adjusted",
    passkey: finalPasskey,
  });
});

// Return compliance data as JSON for client-side sync
router.get("/compliance/data", (req, res) => {
  try {
    const db = readDB();
    const compliance = db.compliance || getDefaultStructure().compliance;
    res.json({
      success: true,
      data: {
        registration: compliance.registration || {},
        membership: compliance.membership || {},
        periods: compliance.periods || {},
        personal_account_registration:
          compliance.personal_account_registration || {},
      },
    });
  } catch (err) {
    console.error("Error fetching compliance data", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching compliance data" });
  }
});

// ======================
// AGENT MANAGEMENT
// ======================

const DATA_JSON = path.join(__dirname, "..", "data.json");
const AGENT_JSON = path.join(__dirname, "..", "agent.json");
const DEALER_JSON = path.join(__dirname, "..", "dealer.json");
const HQ_JSON = path.join(__dirname, "..", "hq.json");
const OFFICIAL_JSON = path.join(__dirname, "..", "official.json");
const BLOCKED_JSON = path.join(__dirname, "..", "blocked.json");

// Helper: Cleanup Inactive Dealers (No PIN > 7 Days)
function cleanupInactiveDealers() {
  if (!fs.existsSync(DEALER_JSON)) return;
  
  try {
    const rawDealers = fs.readFileSync(DEALER_JSON, "utf8");
    let dealerData = rawDealers.trim() ? JSON.parse(rawDealers) : [];
    if (!Array.isArray(dealerData)) return; // Don't crash if still old format

    let officialUsers = [];
    if (fs.existsSync(OFFICIAL_JSON)) {
      try {
        const rawOff = fs.readFileSync(OFFICIAL_JSON, "utf8").trim();
        officialUsers = rawOff ? JSON.parse(rawOff) : [];
      } catch (err) {
        console.error("Error reading official users for cleanup:", err);
      }
    }
    const now = new Date();
    const initialCount = dealerData.length;

    // Filter out inactive dealers
    dealerData = dealerData.filter(val => {
        if (!val.phoneNumber || !val.createdAt) return true; // Keep malformed?

        const hasPin = officialUsers.find(u => u.phoneNumber === val.phoneNumber);
        if (hasPin) return true; // Keep

        const createdDate = new Date(val.createdAt);
        const diffTime = Math.abs(now - createdDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        return diffDays <= 7; // Keep if younger than 7 days
    });

    const deletedCount = initialCount - dealerData.length;

    if (deletedCount > 0) {
        fs.writeFileSync(DEALER_JSON, JSON.stringify(dealerData, null, 2));
        console.log(`[CLEANUP] Deleted ${deletedCount} inactive dealer accounts.`);
    }

  } catch (e) {
    console.error("Error in cleanupInactiveDealers:", e);
  }
}

// Verify relations between Agent and Dealer
router.post("/compliance/verify-relations", (req, res) => {
  const { agentPhone, dealerPhone } = req.body;

  if (!fs.existsSync(DATA_JSON)) {
    return res
      .status(500)
      .json({ success: false, message: "Database not found" });
  }

  const rawD = fs.readFileSync(DATA_JSON, "utf8").trim();
  const users = rawD ? JSON.parse(rawD) : [];
  const agent = users.find((u) => u.phoneNumber === agentPhone);
  const dealer = users.find((u) => u.phoneNumber === dealerPhone);

  if (!agent) {
    return res
      .status(444)
      .json({ success: false, message: "Agent phone number not registered" });
  }
  if (!dealer) {
    return res
      .status(444)
      .json({ success: false, message: "Dealer phone number not registered" });
  }

  // Check if they are in the same region (County & Constituency)
  const agentCounty = agent.county?.trim();
  const agentConst = agent.constituency?.trim();
  const dealerCounty = dealer.county?.trim();
  const dealerConst = dealer.constituency?.trim();

  if (agentCounty === dealerCounty && agentConst === dealerConst) {
    return res.json({
      success: true,
      data: {
        county: agentCounty,
        constituency: agentConst,
        ward: agent.ward?.trim() || "",
        agentName:
          `${agent.FirstName} ${agent.MiddleName} ${agent.LastName}`.trim(),
        dealerName:
          `${dealer.FirstName} ${dealer.MiddleName} ${dealer.LastName}`.trim(),
      },
    });
  } else {
    return res.status(400).json({
      success: false,
      message:
        "Agent and Dealer do not have close relations (Mismatched regions)",
    });
  }
});

// Save Agent Account and update registries
router.post("/compliance/save-agent", (req, res) => {
  const { agentPhone, dealerPhone, county, constituency, ward } = req.body;

  try {
    // 1. Update agent.json
    let agents = [];
    if (fs.existsSync(AGENT_JSON)) {
      const raw = fs.readFileSync(AGENT_JSON, "utf8");
      agents = raw.trim() ? JSON.parse(raw) : [];
    }

    // Get agent name from data.json
    const rawData = fs.readFileSync(DATA_JSON, "utf8").trim();
    const users = rawData ? JSON.parse(rawData) : [];
    const agentProfile = users.find((u) => u.phoneNumber === agentPhone);
    const agentName = agentProfile
      ? `${agentProfile.FirstName} ${agentProfile.MiddleName} ${agentProfile.LastName}`.trim()
      : "Unknown Agent";

    agents.push({
      phoneNumber: agentPhone,
      dealerPhone: dealerPhone,
      name: agentName,
      county,
      constituency,
      ward,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(AGENT_JSON, JSON.stringify(agents, null, 2));

    // 3. Update dealer.json Hierarchically
    if (fs.existsSync(DEALER_JSON)) {
      const dealers = JSON.parse(fs.readFileSync(DEALER_JSON, "utf8") || "{}");
      
      // We need to find the dealer in the hierarchy: Region -> HQ -> Dealer
      // Optimization: We know the county from the request.
      const region = dealers[county] || {};
      let dealerFound = false;

      // Search through HQs in this region to find the dealer
      for (const hqPh in region) {
         if (region[hqPh][dealerPhone]) {
             // Found the dealer! Update their stats.
             const d = region[hqPh][dealerPhone];
             if (!d.stats) d.stats = { agent_creation: 0, personal_account_creation: 0, dealer_creation: 0 };
             d.stats.agent_creation++;
             d.agents = d.agents || [];
             d.agents.push({
                 phone: agentPhone,
                 createdAt: new Date().toISOString()
             });
             
             dealerFound = true;
             break;
         }
      }
      
      if (dealerFound) {
          fs.writeFileSync(DEALER_JSON, JSON.stringify(dealers, null, 2));
      }
    }

    // 4. Update hq.json (Registry of plain events for backup/other uses?)
    // Actually user wants structure in dealer.json, maybe we don't need to bloat hq.json anymore?
    // We will keep hq.json as a simple log for now to be safe.
    let hqData = [];
    if (fs.existsSync(HQ_JSON)) {
      const raw = fs.readFileSync(HQ_JSON, "utf8");
      hqData = raw.trim() ? JSON.parse(raw) : [];
    }
    const hqUser = req.session.hqUser;
    hqData.push({
      agentPhone,
      dealerPhone,
      hqPhone: hqUser ? hqUser.phoneNumber : null, 
      county,
      constituency,
      ward,
      type: "agent_creation",
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(HQ_JSON, JSON.stringify(hqData, null, 2));

    // 5. Update personal_stats.json
    const PERSONAL_STATS_PATH = path.join(__dirname, "..", "personal_stats.json");
    // ... existing logic ...
    let personalStats = { regional_agent_stats: {} };
    if (fs.existsSync(PERSONAL_STATS_PATH)) {
       personalStats = JSON.parse(fs.readFileSync(PERSONAL_STATS_PATH, "utf8") || "{}");
    }
    if (!personalStats.regional_agent_stats) personalStats.regional_agent_stats = {};
    if (!personalStats.regional_agent_stats[county]) personalStats.regional_agent_stats[county] = {};
    if (!personalStats.regional_agent_stats[county][constituency]) personalStats.regional_agent_stats[county][constituency] = {};
    if (!personalStats.regional_agent_stats[county][constituency][ward]) personalStats.regional_agent_stats[county][constituency][ward] = 0;
    personalStats.regional_agent_stats[county][constituency][ward]++;
    
    fs.writeFileSync(PERSONAL_STATS_PATH, JSON.stringify(personalStats, null, 2));

    res.json({ success: true, message: "Agent account and relations saved" });
  } catch (err) {
    console.error("Save Agent Error:", err);
    res.status(500).json({ success: false, message: "Error saving agent data" });
  }
});

// Dealer Management Endpoints
router.post("/compliance/verify-dealer-relations", (req, res) => {
  const { dealerPhone, hqPhone } = req.body;

  if (!fs.existsSync(DATA_JSON)) {
    return res
      .status(500)
      .json({ success: false, message: "Database not found" });
  }

  const rawData = fs.readFileSync(DATA_JSON, "utf8").trim();
  const users = rawData ? JSON.parse(rawData) : [];

  const dealer = users.find((u) => u.phoneNumber === dealerPhone);

  if (!dealer) {
    return res
      .status(444)
      .json({
        success: false,
        message: "Dealer phone number not registered in data.json",
      });
  }

  if (fs.existsSync(DEALER_JSON)) {
    const dealers = JSON.parse(fs.readFileSync(DEALER_JSON, "utf8") || "{}");
    
    // Check if user is already a registered Dealer in ANY region/HQ tree
    // Structure: dealers[County][HQ][Dealer]
    const findDealer = (obj) => {
        for (const k in obj) {
            if (typeof obj[k] === 'object' && obj[k] !== null) {
                if (obj[k].phoneNumber === dealerPhone) return true; // Found leaf node with phone
                if (findDealer(obj[k])) return true; // Recurse
            }
        }
        return false;
    };

    if (dealers[dealer.county] && findDealer(dealers[dealer.county])) {
       return res.status(400).json({ success: false, message: "User is already a registered Dealer." });
    }
    // Also do a global check just in case they moved counties? (Optional, stick to county for now)
  }

  // REMOVED: Agent check. Dealer verification now solely relies on data.json existence.
  /*
  if (!fs.existsSync(AGENT_JSON)) {
    return res.status(500).json({ success: false, message: "Agent database not found" });
  }

  const agents = JSON.parse(fs.readFileSync(AGENT_JSON, "utf8"));
  const agentAsDealer = agents.find(a => a.phoneNumber === dealerPhone);

  if (!agentAsDealer) {
    return res.status(444).json({ success: false, message: "The number is not a registered agent" });
  }
  */

  const hq = users.find((u) => u.phoneNumber === hqPhone);

  if (!hq) {
    return res
      .status(444)
      .json({ success: false, message: "HQ phone number not registered" });
  }

  // Prevent self-verification
  if (dealerPhone === hqPhone) {
     return res.status(400).json({ success: false, message: "You cannot verify/create a dealer account for yourself." });
  }

  // Check regional consistency
  const dealerCounty = dealer.county?.trim();
  const dealerConst = dealer.constituency?.trim();

  return res.json({
    success: true,
    data: {
      county: dealerCounty,
      constituency: dealerConst,
      ward: dealer.ward?.trim() || "",
      dealerName:
        `${dealer.FirstName} ${dealer.MiddleName} ${dealer.LastName}`.trim(),
      hqName: `${hq.FirstName} ${hq.MiddleName} ${hq.LastName}`.trim(),
    },
  });
});

router.post("/compliance/save-dealer", (req, res) => {
  const { dealerPhone, hqPhone, county, constituency, ward } = req.body;

  try {
    // 1. Update dealer.json
    const rawData = fs.readFileSync(DATA_JSON, "utf8").trim();
    const users = rawData ? JSON.parse(rawData) : [];
    const dealerProfile = users.find((u) => u.phoneNumber === dealerPhone);
    const hqProfile = users.find((u) => u.phoneNumber === hqPhone);

    if (!hqProfile) {
      return res
        .status(400)
        .json({ success: false, message: "HQ user not found in registry." });
    }

    // County validation between HQ user and new dealer
    const hqCounty = (hqProfile.county || "").trim().toLowerCase();
    const dealerCounty = (county || "").trim().toLowerCase();

    if (hqCounty !== dealerCounty) {
      return res
        .status(400)
        .json({
          success: false,
          message: `HQ user's county (${hqProfile.county}) does not match new dealer's county (${county}).`,
        });
    }

    if (!dealerProfile) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Dealer phone number not verified in registry (data.json).",
        });
    }

    const dealerName =
      `${dealerProfile.FirstName} ${dealerProfile.MiddleName} ${dealerProfile.LastName}`.trim();

    // Prevent Self-Creation
    if (dealerPhone === hqPhone) {
        return res.status(400).json({ success: false, message: "You cannot create a dealer account for yourself." });
    }

    // Strict Region Verification
    // Use trim() and case-insensitive check for robustness
    const normalize = (str) => (str || "").trim().toLowerCase();

    const regCounty = normalize(dealerProfile.county);
    const formCounty = normalize(county);

    if (regCounty && regCounty !== formCounty) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Region mismatch: User is registered in ${dealerProfile.county}, not ${county}.`,
        });
    }

    const regConst = normalize(dealerProfile.constituency);
    const formConst = normalize(constituency);

    if (regConst && regConst !== formConst) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Constituency mismatch: User is registered in ${dealerProfile.constituency}, not ${constituency}.`,
        });
    }

    // Ward check removed as per requirement
    // const regWard = normalize(dealerProfile.ward);
    // const formWard = normalize(ward);
    // if (regWard && regWard !== formWard) { ... }

    // Ensure regional data matches data.json structure (Prioritize profile data for consistency)
    const finalCounty = dealerProfile.county || county;
    const finalConstituency = dealerProfile.constituency || constituency;
    // Default to 'Unknown' if no ward provided or found (since field deleted)
    const finalWard = dealerProfile.ward || ward || "Unknown";

    // 4. Update dealer.json (FLATTENED STRUCTURE)
    let dealers = [];
    if (fs.existsSync(DEALER_JSON)) {
      try {
        const raw = fs.readFileSync(DEALER_JSON, "utf8").trim();
        dealers = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(dealers)) dealers = []; // Reset if still an object
      } catch (e) {
        dealers = [];
      }
    }

    // Check if dealer already exists in flat array
    const existingIndex = dealers.findIndex(d => d.phoneNumber === dealerPhone);
    const dealerData = {
        phoneNumber: dealerPhone,
        hqPhone: hqPhone,
        county: finalCounty,
        constituency: finalConstituency,
        ward: finalWard,
        name: dealerName,
        createdAt: new Date().toISOString(),
        isBlocked: false,
        stats: {
           agent_creation: 0,
           personal_account_creation: 0,
           dealer_creation: 0
        }
    };

    if (existingIndex > -1) {
        dealers[existingIndex] = dealerData; // Update
    } else {
        dealers.push(dealerData); // Add new
    }

    fs.writeFileSync(DEALER_JSON, JSON.stringify(dealers, null, 2));

    // 5. Update hq.json (Log event for backup)
    let hqData = [];
    if (fs.existsSync(HQ_JSON)) {
      const raw = fs.readFileSync(HQ_JSON, "utf8");
      hqData = raw.trim() ? JSON.parse(raw) : [];
    }
    hqData.push({
      dealerPhone,
      hqPhone,
      county,
      constituency,
      ward,
      type: "dealer_creation",
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(HQ_JSON, JSON.stringify(hqData, null, 2));

    // 3. Update personal_stats.json
    const PERSONAL_STATS_PATH = path.join(
      __dirname,
      "..",
      "personal_stats.json"
    );
    let personalStats = {
      totalRegistrations: 0,
      mpesaPayments: 0,
      passkeyPayments: 0,
      totalDealerCreated: 0,
    };
    if (fs.existsSync(PERSONAL_STATS_PATH)) {
      const raw = fs.readFileSync(PERSONAL_STATS_PATH, "utf8");
      personalStats = raw.trim() ? JSON.parse(raw) : personalStats;
    }
    personalStats.totalDealerCreated =
      (personalStats.totalDealerCreated || 0) + 1;
    fs.writeFileSync(
      PERSONAL_STATS_PATH,
      JSON.stringify(personalStats, null, 2)
    );

    res.json({
      success: true,
      message: "Dealer account and HQ relation saved",
    });
  } catch (err) {
    console.error("Save Dealer Error:", err);
    res
      .status(500)
      .json({ success: false, message: "Error saving dealer data" });
  }
});

// GET EVENTS FROM DEALER.JSON (Flattened)
// This allows the status (Active/Blocked) to be live.
router.get("/compliance/get-events", (req, res) => {
  try {
    // 0. Auto-Cleanup
    cleanupInactiveDealers();

    if (!fs.existsSync(DEALER_JSON)) return res.json({ events: [], myDealerCount: 0, totalSystemDealers: 0 });
    const dealers = JSON.parse(fs.readFileSync(DEALER_JSON, "utf8") || "{}");
    
    // Recursive flattener to find all dealer objects in any structure
    let allDealers = [];
    const extractDealers = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        
        // If it looks like a dealer object (has phoneNumber and not an array)
        if (obj.phoneNumber && !Array.isArray(obj)) {
            allDealers.push(obj);
            return;
        }

        for (const key in obj) {
            if (key === '_dealerCounts') continue; // Skip metadata
            const val = obj[key];
            if (Array.isArray(val)) {
                // Handle old structure: [ { phoneNumber, ... }, ... ]
                val.forEach(item => {
                    if (item && item.phoneNumber) allDealers.push(item);
                });
            } else if (typeof val === 'object') {
                extractDealers(val);
            }
        }
    };

    extractDealers(dealers);

    const hqUser = req.session.hqUser;
    
    // 1. My Dealer Count
    let myDealerCount = 0;
    if (hqUser && hqUser.phoneNumber) {
        myDealerCount = allDealers.filter(d => d.hqPhone === hqUser.phoneNumber).length;
    }

    // 2. Total System Dealers
    const totalSystemDealers = allDealers.length;

    // Filter for list display
    let filteredEvents = [];
    if (hqUser && hqUser.phoneNumber) {
        filteredEvents = allDealers.filter(d => d.hqPhone === hqUser.phoneNumber);
    } 

    // 3. MERGE AGENT EVENTS
    // Agent structure in new agent.json: [{ phoneNumber, dealerPhone, name, county, createdAt }]
    // We need to link Agent -> Dealer -> HQ to filter correctly.
    const AGENT_JSON_PATH = path.join(__dirname, "..", "agent.json");
    if (fs.existsSync(AGENT_JSON_PATH)) {
        const rawAgents = fs.readFileSync(AGENT_JSON_PATH, "utf8");
        const agents = rawAgents.trim() ? JSON.parse(rawAgents) : [];
        
        // Helper map: DealerPhone -> HQPhone
        const dealerToHqMap = {};
        allDealers.forEach(d => {
            dealerToHqMap[d.phoneNumber] = d.hqPhone;
        });

        agents.forEach(a => {
            const parentHq = dealerToHqMap[a.dealerPhone];
            if (parentHq) {
                // If this agent belongs to a dealer created by THIS HQ (or if we want to show all?)
                // Requirement: "display number of dealer account created by each logger account"
                // Usually dashboard shows events related to the logged in user.
                
                if (hqUser && hqUser.phoneNumber && parentHq === hqUser.phoneNumber) {
                    filteredEvents.push({
                        ...a,
                        type: 'agent_creation',
                        hqPhone: parentHq // Add explicit HQ phone for consistency
                    });
                }
            }
        });
    }

    // Return last 20 created (Combined), reversed
    const events = filteredEvents
        .map(d => ({
            ...d,
            type: d.type || 'dealer_creation', // Default if missing, agents have it set above
        }))
        .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-20)
        .reverse();

    res.json({ 
        events: events,
        myDealerCount,
        totalSystemDealers
    });
  } catch (err) {
    console.error("Get Events Error", err);
    res.status(500).json({ success: false, message: "Error fetching events" });
  }
});

// BLOCK Dealer Endpoint
router.post("/compliance/block-dealer", (req, res) => {
    const { dealerPhone, reason } = req.body;
    
    if (!fs.existsSync(DEALER_JSON)) return res.status(500).json({ success: false, message: "Database error" });
    const dealers = JSON.parse(fs.readFileSync(DEALER_JSON, "utf8") || "{}");

    // Deep recursive search to find dealer in ANY structure (object or array)
    let target = null;
    const findAndUpdate = (obj) => {
        if (target) return;
        for (const key in obj) {
            const val = obj[key];
            if (val && typeof val === 'object') {
                // If it's a dealer object (has phoneNumber field)
                if (val.phoneNumber === dealerPhone) {
                    target = val;
                    return;
                }
                // If it's an array of dealers (old structure)
                if (Array.isArray(val)) {
                    const match = val.find(d => d.phoneNumber === dealerPhone);
                    if (match) { 
                        target = match; 
                        return; 
                    }
                } else {
                    // Recurse into sub-objects (Regions, HQs, Wards, etc.)
                    findAndUpdate(val);
                }
            }
            if (target) return;
        }
    };

    findAndUpdate(dealers);

    if (!target) return res.status(404).json({ success: false, message: "Dealer not found" });

    // Toggle Block Status
    target.isBlocked = !target.isBlocked;
    if (target.isBlocked) target.blockReason = reason || "Compliance Block";
    else target.blockReason = null;

    // Save
    fs.writeFileSync(DEALER_JSON, JSON.stringify(dealers, null, 2));

    res.json({
        success: true,
        message: target.isBlocked ? "Account Blocked" : "Account Unblocked",
        isBlocked: target.isBlocked
    });
});

router.post("/compliance/block-number", (req, res) => {
  const { phoneNumber, reason } = req.body;
  try {
    const BLOCKED_JSON = path.join(__dirname, "..", "blocked.json");
    let blocked = [];
    if (fs.existsSync(BLOCKED_JSON)) {
      blocked = JSON.parse(fs.readFileSync(BLOCKED_JSON, "utf8"));
    }

    if (!blocked.find((b) => b.phoneNumber === phoneNumber)) {
      blocked.push({
        phoneNumber,
        reason: reason || "Compliance Block",
        blockedAt: new Date().toISOString(),
      });
      fs.writeFileSync(BLOCKED_JSON, JSON.stringify(blocked, null, 2));
    }

    res.json({
      success: true,
      message: `Phone number ${phoneNumber} has been blocked`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error blocking number" });
  }
});


// Render a list of all dealers for impersonation
router.get("/compliance/dealers", protectHq, (req, res) => {
    let dealers = [];
    try {
        if (fs.existsSync(DEALER_JSON)) {
            const raw = fs.readFileSync(DEALER_JSON, "utf8").trim();
            if(raw) {
                const parsedDealers = JSON.parse(raw);
                // Ensure it's an array, as the structure might have been an object previously
                if (Array.isArray(parsedDealers)) {
                    dealers = parsedDealers;
                }
            }
        }
    } catch(e) {
        console.error("Error reading or parsing dealer.json:", e);
        // On error, proceed with an empty dealers array
    }
    res.render("hq/dealers", { dealers, hqUser: req.session.hqUser });
});

module.exports = router;
