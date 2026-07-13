const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { Dealer, Agent, normalizePhone, findUserByPhone, saveMessageToMongo, findAgentByPhone, findDealerByPhone } = require("../mongoose");
const regPerfLogger = require("../performance/registration-performance");

// Helper functions
const readJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error parsing JSON from ${file}:`, e.message);
    return fallback;
  }
};

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

// Resolve a registered member from the MongoDB counties collection.
// Returns null if not found or if MongoDB is unavailable.
const lookupUser = async (phoneNumber) => {
  try {
    return await findUserByPhone(phoneNumber);
  } catch (dbErr) {
    console.error("[DEALER] MongoDB user lookup error:", dbErr.message);
    return null;
  }
};

// GET /dealer - Main Entry Point (Flow Control)
router.get("/", async (req, res) => {
  // 1. Enforce Login
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const phoneNumber = normalizePhone(req.session.user.phoneNumber || "");

  let dealer = null;
  try {
    dealer = await findDealerByPhone(req.session.user.phoneNumber);
  } catch (dbErr) {
    console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
  }

  if (!dealer) {
    return res.render("dealer/dealer", {
      step: "not-dealer",
      user: req.session.user,
      message: { type: "error", text: "Access Denied: You are not a registered dealer." },
      preview: null, error: null, success: null
    });
  }

  // Step 2: Create PIN (First time setup)
  if (!dealer.pin) {
    return res.render("dealer/dealer", {
      step: "create-pin",
      user: req.session.user,
      dealer: dealer,
      message: null,
      preview: null, error: null, success: null
    });
  }

  // Step 3: Enter PIN (Login verification)
  if (!req.session.dealerVerified) {
    return res.render("dealer/dealer", {
      step: "enter-pin",
      user: req.session.user,
      dealer: dealer,
      message: null,
      preview: null, error: null, success: null
    });
  }

  // Step 4: Dashboard (Authorized)
  const agents = await Agent.find({ dealerPhone: phoneNumber }).lean();
  const dealerAgents = agents.filter((a) => norm(a.dealerPhone) === norm(phoneNumber));

  const locationsFile = path.join(__dirname, "../locations.json");
  const locationsData = readJSON(locationsFile, {});
  
  // Find wards already occupied by an agent in this constituency
  const occupiedWards = agents
    .filter(a => a.constituency === dealer.constituency && a.ward)
    .map(a => a.ward);

  let localWards = [];
  if (dealer.county && dealer.constituency && locationsData[dealer.county] && locationsData[dealer.county][dealer.constituency]) {
      const wardsObj = locationsData[dealer.county][dealer.constituency];
      if (wardsObj && Array.isArray(wardsObj.wards)) {
          localWards = wardsObj.wards.filter(wardName => !occupiedWards.includes(wardName)); // Hide occupied wards
      }
  }

  res.render("dealer/dealer", {
    step: "dashboard",
    user: req.session.user,
    dealer: dealer,
    agents: dealerAgents,
    localWards: localWards,
    message: null,
    preview: null, error: null, success: null
  });
});

// POST preview agent
 router.post("/preview", async (req, res) => {
   const { phoneNumber } = req.body;
   
   // Reload Dashboard Data
   const sessionPhone = normalizePhone(req.session.user.phoneNumber || "");
   let dealer = null;
   try {
     dealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }
   let dealerAgents = [];
   try {
     dealerAgents = await Agent.find({ dealerPhone: sessionPhone }).lean();
   } catch (dbErr) {
     console.error("[DEALER] MongoDB agent lookup error:", dbErr.message);
   }

  const user = await lookupUser(phoneNumber);

  if (!user) {
    return res.render("dealer/dealer", {
      step: "dashboard", user: req.session.user, dealer, agents: dealerAgents, message: null,
      preview: null,
      error: "User not found in the system.",
      success: null,
    });
  }


  // Construct full name from available fields
  const nameParts = [
    user.FirstName?.trim(),
    user.MiddleName?.trim(),
    user.LastName?.trim(),
  ].filter(Boolean); // filter out undefined, null, empty strings

  const fullName = nameParts.join(" ") || "Name not provided";

  res.render("dealer/dealer", {
    step: "dashboard", user: req.session.user, dealer, agents: dealerAgents, message: null,
    preview: {
      name: fullName,
      county: user.county || "Not provided",
      constituency: user.constituency || "Not provided",
      ward: user.ward || "Not provided",
      phoneNumber: user.phoneNumber,
    },
    error: null,
    success: null,
  });
});

// JSON ENDPOINT: Fetch candidate details for agent creation
 router.post("/create-agent", async (req, res) => {
   const { phoneNumber } = req.body;
   if (!phoneNumber) return res.status(400).json({ success: false, error: "Phone number is required" });

   const sessionPhone = normalizePhone(req.session.user.phoneNumber || "");
   let currentDealer = null;
   try {
     currentDealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }

  if (!currentDealer) {
    return res.status(403).json({ success: false, error: "Unauthorized: Dealer profile not found." });
  }

  const user = await lookupUser(phoneNumber);

  // 1. Verify if registered in TBank system
  if (!user) {
    return res.status(403).json({ success: false, error: "Unauthorized: This phone number is not registered in the system." });
  }

  // 2. Verify if already an agent or dealer
  let existingAgent = null;
  try {
    existingAgent = await findAgentByPhone(phoneNumber);
  } catch (dbErr) {
    console.error("[DEALER] MongoDB agent lookup error:", dbErr.message);
  }
  if (existingAgent) {
    return res.status(400).json({ success: false, error: "Denied: This user is already registered as an Agent." });
  }
  let existingDealer = null;
  try {
    existingDealer = await findDealerByPhone(phoneNumber);
  } catch (dbErr) {
    console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
  }
  if (existingDealer) {
    return res.status(400).json({ success: false, error: "Denied: This user is a registered Dealer." });
  }

  // 3. Verify Constituency Match
  const dealerConst = (currentDealer.constituency || "").trim().toLowerCase();
  const userConst = (user.constituency || "").trim().toLowerCase();

  if (dealerConst !== userConst) {
    return res.status(403).json({ 
      success: false, 
      error: `Unauthorized: You can only register agents from your constituency (${currentDealer.constituency || 'Unknown'}).` 
    });
  }

  res.json({
    success: true,
    agent: {
      name: `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.replace(/\s+/g, ' ').trim(),
      phoneNumber: user.phoneNumber,
      constituency: user.constituency || "N/A",
      ward: user.ward || "N/A"
    }
  });
});

// JSON ENDPOINT: Finalize agent account creation
 router.post("/approve-agent", async (req, res) => {
   const { phoneNumber, ward, idNumber } = req.body;
   
   if (!phoneNumber || !idNumber) {
     return res.status(400).json({ success: false, error: "Phone number and ID number are required" });
   }

   const sessionPhone = normalizePhone(req.session.user.phoneNumber || "");
   let currentDealer = null;
   try {
     currentDealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }

  if (!currentDealer) {
    return res.status(403).json({ success: false, error: "Dealer not found" });
  }

  const user = await lookupUser(phoneNumber);

  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  // 🆔 ID Verification Check
  if (norm(user.idNumber) !== norm(idNumber)) {
    return res.status(401).json({ success: false, error: "Identity verification failed: ID number does not match registered owner." });
  }

  // Final constituency check for security
  if (norm(currentDealer.constituency) !== norm(user.constituency)) {
      return res.status(403).json({ success: false, error: "Constituency mismatch" });
  }

  let existingAgent = null;
  try {
    existingAgent = await findAgentByPhone(phoneNumber);
  } catch (dbErr) {
    console.error("[DEALER] MongoDB agent lookup error:", dbErr.message);
  }
  if (existingAgent) {
    return res.status(400).json({ success: false, error: "Already an agent" });
  }

  const newAgent = {
    name: `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.replace(/\s+/g, ' ').trim(),
    phoneNumber: norm(user.phoneNumber),
    county: user.county || "",
    constituency: user.constituency || "",
    ward: ward || user.ward || "",
    dealerPhone: sessionPhone,
    accepted: false,
    createdAt: new Date().toISOString()
  };

  try {
    await Agent.create(newAgent);
  } catch (dbErr) {
    console.error("[DEALER] Failed to save agent to MongoDB:", dbErr.message);
  }

  // Notify both the processor (dealer) and the processed (candidate)
  try {
    const candidateName = newAgent.name || "Agent";
    const candidatePhone = user.phoneNumber || "";
    const dealerName = currentDealer.name || "Dealer";
    const dealerPhone = currentDealer.phoneNumber || sessionPhone;

    // Processor message
    await saveMessageToMongo({
      to: req.session.user.phoneNumber || sessionPhone,
      type: "agent_processed",
      title: "Agent Account Processed",
      content: `You have processed agent account of ${candidateName} (${candidatePhone}). Ask him/her to click approve request to be tbank agent.`,
      createdAt: new Date().toISOString()
    });

    // Processed (candidate) message — carries the in-app Accept/Approve request button
    await saveMessageToMongo({
      to: candidatePhone,
      type: "agent_invitation",
      title: "Agent Appointment",
      content: `You have been processed to be agent by ${dealerName} (${dealerPhone}). Click approve request to be tbank agent.`,
      meta: { agentPhone: candidatePhone },
      createdAt: new Date().toISOString()
    });
  } catch (msgErr) {
    console.error("[DEALER] Failed to send agent messages:", msgErr.message);
  }

  // Log Performance
  try {
      regPerfLogger.logRegistration(newAgent.county, newAgent.constituency, newAgent.ward, 'agents');
  } catch (e) {
      console.error("Agent registration performance log error:", e);
  }

  res.json({ success: true });
});

// POST create agent
 router.post("/", async (req, res) => {
   const { phoneNumber } = req.body;
   
   // Reload Dashboard Data
   const sessionPhone = normalizePhone(req.session.user.phoneNumber || "");
   let dealer = null;
   try {
     dealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }
  

  const user = await lookupUser(phoneNumber);

  if (!user) {
    return res.render("dealer/dealer", {
      step: "dashboard", user: req.session.user, dealer, agents: [], message: null,
      preview: null,
      error: "User not found",
      success: null,
    });
  }

  const nameParts = [
    user.FirstName?.trim(),
    user.MiddleName?.trim(),
    user.LastName?.trim(),
  ].filter(Boolean);

  const fullName = nameParts.join(" ") || "Name not provided";

   // Create agent in MongoDB
   const newAgentDoc = {
     name: fullName,
     phoneNumber: normalizePhone(phoneNumber),
     county: user.county || "",
     constituency: user.constituency || "",
     ward: user.ward || "",
     dealerPhone: normalizePhone(sessionPhone), // Link agent to the dealer who created them
     createdAt: new Date().toISOString(),
   };

   try {
     await Agent.create(newAgentDoc);
   } catch (dbErr) {
     console.error("[DEALER] Failed to save agent to MongoDB:", dbErr.message);
   }

   // Log Performance
   try {
       regPerfLogger.logRegistration(user.county, user.constituency, user.ward, 'agents');
   } catch (e) {
       console.error("Agent registration performance log error:", e);
   }

   // Reload agents for the view
   const dealerAgents = await Agent.find({ dealerPhone: sessionPhone }).lean();

  res.render("dealer/dealer", {
    step: "dashboard", user: req.session.user, dealer, agents: dealerAgents, message: null,
    preview: null,
    error: null,
    success: "✅ Agent account created successfully",
  });
});


// POST create PIN for dealer
router.post("/create-pin", async (req, res) => {
  console.log("[dealer-create-pin] Received request body:", req.body);
  console.log("[dealer-create-pin] Session user:", req.session.user);

  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    console.log("[dealer-create-pin] Session invalid or user not logged in");
    return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
  }

  const { pin } = req.body;
  const targetPhoneNumber = normalizePhone(req.session.user.phoneNumber || "");

  console.log(`[dealer-create-pin] Extracted - targetPhoneNumber: ${targetPhoneNumber}`);

  if (!targetPhoneNumber || !pin) {
    return res.status(400).json({ success: false, error: "Phone number and PIN are required" });
  }

  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ success: false, error: "PIN must be exactly 4 digits" });
  }

  try {
    let currentDealer = await findDealerByPhone(req.session.user.phoneNumber);

    if (!currentDealer) {
      console.log(`[dealer-create-pin] Dealer not found in MongoDB, creating new entry`);
      const newDealer = {
        phoneNumber: targetPhoneNumber,
        hqPhone: targetPhoneNumber,
        county: "",
        constituency: "",
        ward: "",
        name: `${req.session.user.firstName || ''} ${req.session.user.lastName || ''}`.trim() || "Unknown Dealer",
        createdAt: new Date().toISOString(),
        isBlocked: false,
        stats: {
          agent_creation: 0,
          personal_account_creation: 0,
          dealer_creation: 0
        }
      };

      const user = await lookupUser(targetPhoneNumber);
      if (user) {
        newDealer.county = user.county || "";
        newDealer.constituency = user.constituency || "";
        newDealer.ward = user.ward || "";
        newDealer.name = `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.trim() || newDealer.name;
      }

      currentDealer = await Dealer.create(newDealer);

      try {
          regPerfLogger.logRegistration(newDealer.county, newDealer.constituency, newDealer.ward, 'dealers');
      } catch (e) {
          console.error("Dealer registration performance log error:", e);
      }
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    const passkey = Math.floor(1000 + Math.random() * 9000).toString();

    await Dealer.updateOne(
      { phoneNumber: targetPhoneNumber },
      { $set: { pin: hashedPin, passkey: passkey } }
    );

    console.log(`[dealer-create-pin] PIN and passkey set successfully for ${targetPhoneNumber}`);

    req.session.hasDealerPin = true;
    req.session.dealerVerified = true;

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true });
    }
    return res.redirect('/dealer');
  } catch (error) {
    console.error("Error creating dealer PIN:", error);
    res.status(500).json({ success: false, error: `Internal server error: ${error.message}` });
  }
});


// POST login for dealer (PIN verification)
 router.post("/login", async (req, res) => {
   if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
     if (req.headers.accept && req.headers.accept.includes('application/json')) {
       return res.status(401).json({ success: false, error: "Session expired" });
     }
     return res.redirect("/login");
   }

   const { pin } = req.body;
   const phoneNumber = normalizePhone(req.session.user.phoneNumber || "");
   const isApi = req.headers.accept && req.headers.accept.includes('application/json');

   if (!pin) {
     if (isApi) return res.json({ success: false, error: "PIN is required" });
     return res.render("dealer/dealer", {
       step: "enter-pin",
       user: req.session.user,
       dealer: { name: "Dealer" },
       message: { type: "error", text: "PIN is required." },
       preview: null, error: null, success: null
     });
   }

   let dealer = null;
   try {
     dealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }

   if (!dealer || !dealer.pin) {
    if (isApi) return res.json({ success: false, error: "Dealer account not found or PIN not set" });
    return res.redirect("/dealer");
  }

  try {
    const isMatch = await bcrypt.compare(pin, dealer.pin);
    if (isMatch) {
      req.session.dealerVerified = true;
      req.session.save(() => {
        if (isApi) return res.json({ success: true });
        res.redirect("/dealer");
      });
    } else {
      if (isApi) return res.json({ success: false, error: "Invalid PIN" });
      res.render("dealer/dealer", {
        step: "enter-pin",
        user: req.session.user,
        dealer: dealer,
        message: { type: "error", text: "Invalid PIN" },
        preview: null, error: null, success: null
      });
    }
  } catch (error) {
    console.error("Error verifying dealer PIN:", error);
    if (isApi) return res.status(500).json({ success: false, error: "Server Error" });
    res.render("dealer/dealer", {
      step: "enter-pin",
      user: req.session.user,
      dealer: dealer,
      message: { type: "error", text: "Server Error" },
      preview: null, error: null, success: null
    });
  }
});

// GET dealer dashboard data
 router.get("/dashboard-data", async (req, res) => {
   const phoneNumber = normalizePhone(req.session.user.phoneNumber || "");

   if (!phoneNumber) {
     return res.status(401).json({ success: false, error: "Unauthorized" });
   }

   let dealer = null;
   try {
     dealer = await findDealerByPhone(req.session.user.phoneNumber);
   } catch (dbErr) {
     console.error("[DEALER] MongoDB dealer lookup error:", dbErr.message);
   }

   if (!dealer) {
     return res.status(404).json({ success: false, error: "Dealer not found" });
   }

   let dealerAgents = [];
   try {
     dealerAgents = await Agent.find({ dealerPhone: phoneNumber }).lean();
   } catch (dbErr) {
     console.error("[DEALER] MongoDB agent lookup error:", dbErr.message);
   }

  res.json({
    success: true,
    dealer: dealer,
    agents: dealerAgents
  });
});


module.exports = router;
