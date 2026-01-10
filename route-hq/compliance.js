const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// Path to JSON database
const DB_PATH = path.join(__dirname, "..", "tbank.json");

// Middleware
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Database helpers
const getDefaultStructure = () => ({
  compliance: {
    registration: null,
    membership: null,
    periods: null,
    completed: false
  }
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
  const { 
    registration = {}, 
    membership = {}, 
    periods = {} 
  } = compliance;
  
  res.render("hq/compliance", {
    registration: registration || {},
    membership: membership || {},
    periods: periods || {},
    hqUser: req.session.hqUser || null
  });
});

// Save Registration Standards
router.post("/compliance/registration", (req, res) => {
  const { nf, rf } = req.body;
  if (!nf || !rf) {
    return res.status(400).json({ success: false, message: "Missing fee values" });
  }

  const db = readDB();
  // Ensure we don't null-ref if compliance got wiped
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  db.compliance.registration = {
    newGroupFee: nf,
    renewalFee: rf,
    updatedAt: new Date().toISOString()
  };
  
  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({ success: true, message: "Registration standards saved" });
});

// Save Membership Standards
router.post("/compliance/membership", (req, res) => {
  const { trustees, officials, members, maxMembers } = req.body;
  if (!trustees || !officials || !members) {
    return res.status(400).json({ success: false, message: "Missing membership values" });
  }

  const db = readDB();
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  db.compliance.membership = {
    trustees,
    officials,
    members,
    maxMembers: maxMembers || members, // Default to members if not provided
    updatedAt: new Date().toISOString()
  };
  
  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({ success: true, message: "Membership rules saved" });
});

// Save Periods Configuration
router.post("/compliance/periods", (req, res) => {
  const { interval, season } = req.body;
  if (!interval || !season) {
    return res.status(400).json({ success: false, message: "Missing period values" });
  }

  const db = readDB();
  if (!db.compliance) db.compliance = getDefaultStructure().compliance;

  db.compliance.periods = {
    interval,
    season,
    updatedAt: new Date().toISOString()
  };
  
  db.compliance.completed = checkCompletion(db.compliance);
  writeDB(db);

  res.json({ success: true, message: "Period configuration saved" });
});

// Return compliance data as JSON for client-side sync
router.get('/compliance/data', (req, res) => {
  try {
    const db = readDB();
    const compliance = db.compliance || getDefaultStructure().compliance;
    res.json({ success: true, data: {
      registration: compliance.registration || {},
      membership: compliance.membership || {},
      periods: compliance.periods || {}
    }});
  } catch (err) {
    console.error('Error fetching compliance data', err);
    res.status(500).json({ success: false, message: 'Error fetching compliance data' });
  }
});

// ======================
// AGENT MANAGEMENT
// ======================

const DATA_JSON = path.join(__dirname, "..", "data.json");
const AGENT_JSON = path.join(__dirname, "..", "agent.json");
const DEALER_JSON = path.join(__dirname, "..", "dealer.json");
const HQ_JSON = path.join(__dirname, "..", "hq.json");

// Verify relations between Agent and Dealer
router.post("/compliance/verify-relations", (req, res) => {
  const { agentPhone, dealerPhone } = req.body;

  if (!fs.existsSync(DATA_JSON)) {
    return res.status(500).json({ success: false, message: "Database not found" });
  }

  const users = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
  const agent = users.find(u => u.phoneNumber === agentPhone);
  const dealer = users.find(u => u.phoneNumber === dealerPhone);

  if (!agent) {
    return res.status(444).json({ success: false, message: "Agent phone number not registered" });
  }
  if (!dealer) {
    return res.status(444).json({ success: false, message: "Dealer phone number not registered" });
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
        agentName: `${agent.FirstName} ${agent.MiddleName} ${agent.LastName}`.trim(),
        dealerName: `${dealer.FirstName} ${dealer.MiddleName} ${dealer.LastName}`.trim()
      } 
    });
  } else {
    return res.status(400).json({ 
      success: false, 
      message: "Agent and Dealer do not have close relations (Mismatched regions)" 
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
    const users = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
    const agentProfile = users.find(u => u.phoneNumber === agentPhone);
    const agentName = agentProfile ? `${agentProfile.FirstName} ${agentProfile.MiddleName} ${agentProfile.LastName}`.trim() : "Unknown Agent";

    agents.push({
      phoneNumber: agentPhone,
      dealerPhone: dealerPhone,
      name: agentName,
      county,
      constituency,
      ward,
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(AGENT_JSON, JSON.stringify(agents, null, 2));

    // 2. Update dealer.json
    let dealers = [];
    if (fs.existsSync(DEALER_JSON)) {
      const raw = fs.readFileSync(DEALER_JSON, "utf8");
      dealers = raw.trim() ? JSON.parse(raw) : [];
    }
    
    let dealerIndex = dealers.findIndex(d => d.phoneNumber === dealerPhone);
    if (dealerIndex === -1) {
      dealers.push({
        phoneNumber: dealerPhone,
        agents: [agentPhone],
        updatedAt: new Date().toISOString()
      });
    } else {
      if (!dealers[dealerIndex].agents) dealers[dealerIndex].agents = [];
      if (!dealers[dealerIndex].agents.includes(agentPhone)) {
        dealers[dealerIndex].agents.push(agentPhone);
      }
      dealers[dealerIndex].updatedAt = new Date().toISOString();
    }
    fs.writeFileSync(DEALER_JSON, JSON.stringify(dealers, null, 2));

    // 3. Update hq.json (registry of phone numbers)
    let hqData = [];
    if (fs.existsSync(HQ_JSON)) {
      const raw = fs.readFileSync(HQ_JSON, "utf8");
      hqData = raw.trim() ? JSON.parse(raw) : [];
    }
    hqData.push({
      agentPhone,
      dealerPhone,
      county,
      constituency,
      ward,
      type: "agent_creation",
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(HQ_JSON, JSON.stringify(hqData, null, 2));

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
    return res.status(500).json({ success: false, message: "Database not found" });
  }

  const users = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
  const dealer = users.find(u => u.phoneNumber === dealerPhone);
  const hq = users.find(u => u.phoneNumber === hqPhone);

  if (!dealer) {
    return res.status(444).json({ success: false, message: "Dealer phone number not registered" });
  }
  if (!hq) {
    return res.status(444).json({ success: false, message: "HQ phone number not registered" });
  }

  // Check regional consistency
  const dealerCounty = dealer.county?.trim();
  const dealerConst = dealer.constituency?.trim();
  const hqCounty = hq.county?.trim();
  const hqConst = hq.constituency?.trim();

  if (dealerCounty === hqCounty && dealerConst === hqConst) {
    return res.json({ 
      success: true, 
      data: { 
        county: dealerCounty, 
        constituency: dealerConst,
        ward: dealer.ward?.trim() || "",
        dealerName: `${dealer.FirstName} ${dealer.MiddleName} ${dealer.LastName}`.trim(),
        hqName: `${hq.FirstName} ${hq.MiddleName} ${hq.LastName}`.trim()
      } 
    });
  } else {
    return res.status(400).json({ 
      success: false, 
      message: "Dealer and HQ do not have close relations (Mismatched regions)" 
    });
  }
});

router.post("/compliance/save-dealer", (req, res) => {
  const { dealerPhone, hqPhone, county, constituency, ward } = req.body;

  try {
    // 1. Update dealer.json
    let dealers = [];
    if (fs.existsSync(DEALER_JSON)) {
      const raw = fs.readFileSync(DEALER_JSON, "utf8");
      dealers = raw.trim() ? JSON.parse(raw) : [];
    }

    const users = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
    const dealerProfile = users.find(u => u.phoneNumber === dealerPhone);
    const dealerName = dealerProfile ? `${dealerProfile.FirstName} ${dealerProfile.MiddleName} ${dealerProfile.LastName}`.trim() : "Unknown Dealer";

    // Update or add dealer record
    let dIdx = dealers.findIndex(d => d.phoneNumber === dealerPhone);
    const dealerData = {
      phoneNumber: dealerPhone,
      hqPhone: hqPhone,
      name: dealerName,
      county,
      constituency,
      ward,
      updatedAt: new Date().toISOString()
    };

    if (dIdx === -1) {
      dealerData.createdAt = new Date().toISOString();
      dealers.push(dealerData);
    } else {
      dealers[dIdx] = { ...dealers[dIdx], ...dealerData };
    }
    fs.writeFileSync(DEALER_JSON, JSON.stringify(dealers, null, 2));

    // 2. Update hq.json (registry)
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
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(HQ_JSON, JSON.stringify(hqData, null, 2));

    res.json({ success: true, message: "Dealer account and HQ relation saved" });

  } catch (err) {
    console.error("Save Dealer Error:", err);
    res.status(500).json({ success: false, message: "Error saving dealer data" });
  }
});

// Event Registry & Blocking
router.get("/compliance/get-events", (req, res) => {
  try {
    if (!fs.existsSync(HQ_JSON)) return res.json({ events: [] });
    const events = JSON.parse(fs.readFileSync(HQ_JSON, "utf8"));
    // Return last 20 events, reversed
    res.json({ events: events.slice(-20).reverse() });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching events" });
  }
});

router.post("/compliance/block-number", (req, res) => {
  const { phoneNumber, reason } = req.body;
  try {
    const BLOCKED_JSON = path.join(__dirname, "..", "blocked.json");
    let blocked = [];
    if (fs.existsSync(BLOCKED_JSON)) {
      blocked = JSON.parse(fs.readFileSync(BLOCKED_JSON, "utf8"));
    }

    if (!blocked.find(b => b.phoneNumber === phoneNumber)) {
      blocked.push({
        phoneNumber,
        reason: reason || "Compliance Block",
        blockedAt: new Date().toISOString()
      });
      fs.writeFileSync(BLOCKED_JSON, JSON.stringify(blocked, null, 2));
    }

    res.json({ success: true, message: `Phone number ${phoneNumber} has been blocked` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error blocking number" });
  }
});

module.exports = router;
