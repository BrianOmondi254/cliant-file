const express = require("express");
const fs = require("fs");
const path = require("path");
const { findUserInCounties, Dealer, Agent, Admin, SuperAdmin, normalizePhone, Message } = require('../mongoose');
const { processMessage } = require('../notification/notification');

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
router.get("/compliance", async (req, res) => {
  const db = readDB();
  const compliance = db.compliance || getDefaultStructure().compliance;

  // Destructure with fallbacks to empty objects to prevent EJS ReferenceErrors
  // This ensures properties like 'registration.newGroupFee' won't crash even if 'registration' is null/undefined
  const { registration = {}, membership = {}, periods = {} } = compliance;

  // Read dealer counts from MongoDB
  let dealerCounts = {};
  try {
     const allDealers = await Dealer.find({}).lean();
     allDealers.forEach(d => {
         const county = d.county || "Unknown";
         dealerCounts[county] = (dealerCounts[county] || 0) + 1;
     });
  } catch(e) {
     console.error("Error computing dealer counts:", e);
  }

  const hqUser = req.session.hqUser || null;
  let userCounty = null;
  let userConstituency = null;
  if (hqUser && hqUser.phoneNumber) {
    try {
      const user = await findUserInCounties(hqUser.phoneNumber);
      if (user) {
        userCounty = user.county;
        userConstituency = user.constituency;
      }
    } catch (e) {
      console.error("Error finding user in counties:", e);
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

// Regional Officer specific page
router.get("/compliance/regions", protectHq, async (req, res) => {
  const county = req.query.county || "";
  const hqUser = req.session.hqUser || null;
  
  if (hqUser) {
    const initials = (hqUser.name || "HQ").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    res.render("hq/regions", {
      county: county,
      name: hqUser.name,
      initials: initials,
      hqUser: hqUser
    });
  } else {
    res.redirect("/hq");
  }
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

const AGENT_JSON = path.join(__dirname, "..", "agent.json");
const HQ_JSON = path.join(__dirname, "..", "hq.json");
const OFFICIAL_JSON = path.join(__dirname, "..", "official.json");
const BLOCKED_JSON = path.join(__dirname, "..", "blocked.json");

// Helper: Cleanup Inactive Dealers (No PIN > 7 Days)
async function cleanupInactiveDealers() {
  try {
     const sevenDaysAgo = new Date();
     sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
     
     const result = await Dealer.deleteMany({
         createdAt: { $lt: sevenDaysAgo },
         $or: [ { pin: null }, { pin: "" }, { pin: { $exists: false } } ]
     });
     
     if (result.deletedCount > 0) {
         console.log(`[CLEANUP] Deleted ${result.deletedCount} inactive dealer accounts.`);
     }
  } catch (e) {
     console.error("Error in cleanupInactiveDealers:", e);
  }
}

// Verify relations between Agent and Dealer
router.post("/compliance/verify-relations", async (req, res) => {
  const { agentPhone, dealerPhone } = req.body;

  const agent = await findUserInCounties(agentPhone);
  const dealer = await findUserInCounties(dealerPhone);

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
router.post("/compliance/save-agent", async (req, res) => {
  const { agentPhone, dealerPhone, county, constituency, ward } = req.body;

  try {
    // 1. Update agent.json
    let agents = [];
    if (fs.existsSync(AGENT_JSON)) {
      const raw = fs.readFileSync(AGENT_JSON, "utf8");
      agents = raw.trim() ? JSON.parse(raw) : [];
    }

    const agentProfile = await findUserInCounties(agentPhone);
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

    // 3. Update dealer stats in MongoDB
    const normDealerPhone = normalizePhone(dealerPhone);
    await Dealer.updateOne(
        { phoneNumber: normDealerPhone },
        { 
            $inc: { "stats.agent_creation": 1 }
        }
    );

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
router.post("/compliance/verify-dealer-relations", async (req, res) => {
  const { dealerPhone, hqPhone } = req.body;

  const dealer = await findUserInCounties(dealerPhone);

  if (!dealer) {
    return res
      .status(444)
      .json({
        success: false,
        message: "Dealer phone number not registered in TBank system",
      });
  }

  const normDealerPhone = normalizePhone(dealerPhone);
  const existingDealer = await Dealer.findOne({ phoneNumber: normDealerPhone });
  if (existingDealer) {
      return res.status(400).json({ success: false, message: "User is already a registered Dealer." });
  }

  // REMOVED: Agent check. Dealer verification now solely relies on counties MongoDB collection.
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

  const hq = await findUserInCounties(hqPhone);

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

router.post("/compliance/save-dealer", async (req, res) => {
  const { dealerPhone, hqPhone, county, constituency, ward } = req.body;

  try {
    const dealerProfile = await findUserInCounties(dealerPhone);
    const hqProfile = await findUserInCounties(hqPhone);

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
          message: "Dealer phone number not verified in TBank system.",
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

    // Ensure regional data matches counties MongoDB collection (Prioritize profile data for consistency)
    const finalCounty = dealerProfile.county || county;
    const finalConstituency = dealerProfile.constituency || constituency;
    // Default to 'Unknown' if no ward provided or found (since field deleted)
    const finalWard = dealerProfile.ward || ward || "Unknown";

    // --- NEW MONGODB VALIDATIONS ---
    const normDealerPhone = normalizePhone(dealerPhone);
    const normHqPhone = normalizePhone(hqPhone);
    
    const existingDealer = await Dealer.findOne({ phoneNumber: normDealerPhone });
    if (existingDealer) {
       return res.status(400).json({ success: false, message: "User is already a registered Dealer." });
    }
    
    const existingAgent = await Agent.findOne({ phoneNumber: normDealerPhone });
    if (existingAgent) {
       return res.status(400).json({ success: false, message: "Phone number is registered as an Agent." });
    }
    
    const existingAdmin = await Admin.findOne({ phoneNumber: normDealerPhone });
    const existingSuperAdmin = await SuperAdmin.findOne({ $or: [{ phoneNumber: dealerPhone }, { phoneNumber: normDealerPhone }] });
    if (existingAdmin || existingSuperAdmin) {
       return res.status(400).json({ success: false, message: "Phone number is registered as an Admin or SuperAdmin." });
    }

// Check for existing pending dealer invitation (any invitation message to this number)
     const existingPending = await Message.findOne({ 
       to: normDealerPhone, 
       type: "dealer_invitation"
     });
     if (existingPending) {
       return res.status(400).json({ 
         success: false, 
         message: "A pending dealer invitation already exists for this number. Please wait for acceptance or cancel the existing invitation." 
       });
     }

     // 4. Send Dealer Invitation (do NOT create dealer yet — user must accept)
     const dealerPayload = {
       phoneNumber: normDealerPhone,
       hqPhone: normHqPhone,
       county: finalCounty,
       constituency: finalConstituency,
       ward: finalWard,
       name: dealerName,
       isBlocked: false,
       stats: {
         agent_creation: 0,
         personal_account_creation: 0,
         dealer_creation: 0
       }
     };

     processMessage("HQ Admin", {
       to: dealerPhone.trim(),
       type: "dealer_invitation",
       title: "Dealer Appointment Invitation",
       content: `You have been invited to become a dealer for ${finalCounty} county. Please accept to activate your dealer account.`,
       meta: dealerPayload
     });

     res.json({
       success: true,
       message: "Dealer invitation sent successfully. Awaiting user acceptance.",
       instructions: "The dealer will receive an invitation on their phone. They must accept the invitation to activate their dealer account. You can track pending invitations in the Messages section."
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
router.get("/compliance/get-events", async (req, res) => {
  try {
    // 0. Auto-Cleanup
    cleanupInactiveDealers();

    const allDealers = await Dealer.find({}).lean();

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
    const agents = await Agent.find({}).lean();
    
    // Helper map: DealerPhone -> HQPhone
    const dealerToHqMap = {};
    allDealers.forEach(d => {
        dealerToHqMap[d.phoneNumber] = d.hqPhone;
    });

    agents.forEach(a => {
        const parentHq = dealerToHqMap[a.dealerPhone];
        if (parentHq) {
            if (hqUser && hqUser.phoneNumber && parentHq === hqUser.phoneNumber) {
                filteredEvents.push({
                    ...a,
                    type: 'agent_creation',
                    hqPhone: parentHq // Add explicit HQ phone for consistency
                });
            }
        }
    });

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
router.post("/compliance/block-dealer", async (req, res) => {
    const { dealerPhone, reason } = req.body;
    
    try {
        const target = await Dealer.findOne({ phoneNumber: dealerPhone });
        if (!target) return res.status(404).json({ success: false, message: "Dealer not found" });

        target.isBlocked = !target.isBlocked;
        // Optionally store the reason if the schema is updated later
        // target.blockReason = target.isBlocked ? (reason || "Compliance Block") : null;

        await target.save();

        res.json({
            success: true,
            message: target.isBlocked ? "Account Blocked" : "Account Unblocked",
            isBlocked: target.isBlocked
        });
    } catch(e) {
        console.error("Block Dealer Error", e);
        res.status(500).json({ success: false, message: "Database error" });
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
router.get("/compliance/dealers", protectHq, async (req, res) => {
    let dealers = [];
    try {
        dealers = await Dealer.find({}).lean();
    } catch(e) {
        console.error("Error reading dealers from MongoDB:", e);
    }
    res.render("hq/dealers", { dealers, hqUser: req.session.hqUser });
});

module.exports = router;
