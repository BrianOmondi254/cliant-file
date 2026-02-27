const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const usersFile = path.join(__dirname, "../data.json");
const agentFile = path.join(__dirname, "../agent.json");
const dealerFile = path.join(__dirname, "../dealer.json");

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

// GET /dealer - Main Entry Point (Flow Control)
router.get("/", (req, res) => {
  // 1. Enforce Login
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const phoneNumber = req.session.user.phoneNumber;
  const dealers = readJSON(dealerFile, []);
  
  // Find the dealer account associated with the logged-in user
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(phoneNumber));

  // Step 1: Not a Dealer
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
  const agents = readJSON(agentFile, []);
  const dealerAgents = agents.filter((a) => norm(a.dealerPhone) === norm(phoneNumber));

  res.render("dealer/dealer", {
    step: "dashboard",
    user: req.session.user,
    dealer: dealer,
    agents: dealerAgents,
    message: null,
    preview: null, error: null, success: null
  });
});

// POST preview agent
router.post("/preview", (req, res) => {
  const { phoneNumber } = req.body;
  
  // Reload Dashboard Data
  const sessionPhone = req.session.user.phoneNumber;
  const dealers = readJSON(dealerFile, []);
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(sessionPhone));
  const agents = readJSON(agentFile, []);
  const dealerAgents = agents.filter((a) => norm(a.dealerPhone) === norm(sessionPhone));

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      step: "dashboard", user: req.session.user, dealer, agents: dealerAgents, message: null,
      preview: null,
      error: "System Error: User database missing.",
      success: null,
    });
  }

  const users = JSON.parse(fs.readFileSync(usersFile, "utf8") || "[]");

  const user = users.find((u) => u.phoneNumber === phoneNumber);


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
router.post("/create-agent", (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ success: false, error: "Phone number is required" });

  const sessionPhone = req.session.user.phoneNumber;
  const dealers = readJSON(dealerFile, []);
  const currentDealer = dealers.find(d => norm(d.phoneNumber) === norm(sessionPhone));

  if (!currentDealer) {
    return res.status(403).json({ success: false, error: "Unauthorized: Dealer profile not found." });
  }

  const users = readJSON(usersFile, []);
  const user = users.find(u => norm(u.phoneNumber) === norm(phoneNumber));

  // 1. Verify if registered in TBank system
  if (!user) {
    return res.status(403).json({ success: false, error: "Unauthorized: This phone number is not registered in the system." });
  }

  // 2. Verify if already an agent or dealer
  const agents = readJSON(agentFile, []);
  if (agents.find(a => norm(a.phoneNumber) === norm(phoneNumber))) {
    return res.status(400).json({ success: false, error: "Denied: This user is already registered as an Agent." });
  }
  if (dealers.find(d => norm(d.phoneNumber) === norm(phoneNumber))) {
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
router.post("/approve-agent", (req, res) => {
  const { phoneNumber, ward, idNumber } = req.body;
  
  if (!phoneNumber || !idNumber) {
    return res.status(400).json({ success: false, error: "Phone number and ID number are required" });
  }

  const sessionPhone = req.session.user.phoneNumber;
  const dealers = readJSON(dealerFile, []);
  const currentDealer = dealers.find(d => norm(d.phoneNumber) === norm(sessionPhone));

  if (!currentDealer) {
    return res.status(403).json({ success: false, error: "Dealer not found" });
  }

  const users = readJSON(usersFile, []);
  const user = users.find(u => norm(u.phoneNumber) === norm(phoneNumber));

  if (!user) return res.status(404).json({ success: false, error: "User not found" });

  // 🆔 ID Verification Check
  if (norm(user.idNumber) !== norm(idNumber)) {
    return res.status(401).json({ success: false, error: "Identity verification failed: ID number does not match registered owner." });
  }

  // Final constituency check for security
  if (norm(currentDealer.constituency) !== norm(user.constituency)) {
      return res.status(403).json({ success: false, error: "Constituency mismatch" });
  }

  const agents = readJSON(agentFile, []);
  if (agents.find(a => norm(a.phoneNumber) === norm(phoneNumber))) {
    return res.status(400).json({ success: false, error: "Already an agent" });
  }

  const newAgent = {
    name: `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.replace(/\s+/g, ' ').trim(),
    phoneNumber: user.phoneNumber,
    county: user.county || "",
    constituency: user.constituency || "",
    ward: ward || user.ward || "",
    dealerPhone: sessionPhone,
    createdAt: new Date().toISOString()
  };

  agents.push(newAgent);
  writeJSON(agentFile, agents);

  res.json({ success: true });
});

// POST create agent
router.post("/", (req, res) => {
  const { phoneNumber } = req.body;
  
  // Reload Dashboard Data
  const sessionPhone = req.session.user.phoneNumber;
  const dealers = readJSON(dealerFile, []);
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(sessionPhone));
  

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      step: "dashboard", user: req.session.user, dealer, agents: [], message: null,
      preview: null,
      error: "System Error: User database missing.",
      success: null,
    });
  }

  const users = JSON.parse(fs.readFileSync(usersFile, "utf8") || "[]");
  const user = users.find((u) => u.phoneNumber === phoneNumber);

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

  // Reload agents for the list
  let agents = [];
  if (fs.existsSync(agentFile)) {
    agents = JSON.parse(fs.readFileSync(agentFile, "utf8") || "[]");
  }

  agents.push({
    name: fullName,
    county: user.county || "",
    constituency: user.constituency || "",
    ward: user.ward || "",
    phoneNumber,
    dealerPhone: sessionPhone, // Link agent to the dealer who created them
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(agentFile, JSON.stringify(agents, null, 2));

  // Filter agents again for the view
  const dealerAgents = agents.filter((a) => norm(a.dealerPhone) === norm(sessionPhone));

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

  // Ensure session is valid
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    console.log("[dealer-create-pin] Session invalid or user not logged in");
    return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
  }

  const { pin } = req.body;
  const targetPhoneNumber = req.session.user.phoneNumber;

  console.log(`[dealer-create-pin] Extracted - targetPhoneNumber: ${targetPhoneNumber}`);

  if (!targetPhoneNumber || !pin) {
    return res.status(400).json({ success: false, error: "Phone number and PIN are required" });
  }

  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ success: false, error: "PIN must be exactly 4 digits" });
  }

  try {
    console.log("[dealer-create-pin] Dealer file path:", dealerFile);
    const dealers = readJSON(dealerFile, []);
    console.log("[dealer-create-pin] Dealers loaded:", dealers.length, "entries");

    if (!Array.isArray(dealers)) {
      console.log("[dealer-create-pin] dealer.json is not an array, resetting to []");
      dealers = [];
    }

    const dealerIndex = dealers.findIndex((d) => {
      if (!d || !d.phoneNumber) return false;
      const dNorm = norm(d.phoneNumber);
      const pNorm = norm(targetPhoneNumber);
      console.log(`[dealer-create-pin] Comparing dealer phone: ${dNorm} with session phone: ${pNorm}`);
      return dNorm === pNorm;
    });

    if (dealerIndex === -1) {
      console.log(`[dealer-create-pin] Dealer not found for phone: ${targetPhoneNumber}, adding from data.json`);
      // Add the dealer from data.json if not in dealer.json
      const users = readJSON(usersFile, []);
      const user = users.find((u) => norm(u.phoneNumber) === norm(targetPhoneNumber));
      if (!user) {
        console.log(`[dealer-create-pin] User not found in data.json for phone: ${targetPhoneNumber}`);
        return res.status(404).json({ success: false, error: "User trying to create PIN not found in main user registry." });
      }
      const newDealer = {
        phoneNumber: user.phoneNumber,
        hqPhone: user.phoneNumber, // Assuming self for now
        county: user.county || "",
        constituency: user.constituency || "",
        ward: user.ward || "",
        name: `${user.FirstName} ${user.MiddleName} ${user.LastName}`.trim(),
        createdAt: new Date().toISOString(),
        isBlocked: false,
        stats: {
          agent_creation: 0,
          personal_account_creation: 0,
          dealer_creation: 0
        }
      };
      dealers.push(newDealer);
      writeJSON(dealerFile, dealers);
      console.log(`[dealer-create-pin] Added new dealer:`, newDealer);
      dealerIndex = dealers.length - 1; // Set to the new index
    }

    console.log(`[dealer-create-pin] Dealer found at index ${dealerIndex}. Before PIN set:`, dealers[dealerIndex]);

    // Verify dealer structure has required fields, add defaults if missing
    const dealer = dealers[dealerIndex];
    if (!dealer.phoneNumber) dealer.phoneNumber = targetPhoneNumber;
    if (!dealer.name) dealer.name = "Unknown Dealer";

    console.log(`[dealer-create-pin] Dealer structure verified:`, dealer);

    // Hash the PIN
    let hashedPin;
    try {
      hashedPin = await bcrypt.hash(pin, 10);
    } catch (hashError) {
      console.error("Error hashing PIN:", hashError);
      return res.status(500).json({ success: false, error: `Error processing PIN: ${hashError.message}` });
    }

    dealers[dealerIndex].pin = hashedPin;
    // Generate and set a random 4-digit passkey
    dealers[dealerIndex].passkey = Math.floor(1000 + Math.random() * 9000).toString();

    console.log(`[dealer-create-pin] Dealer after PIN and passkey set:`, dealers[dealerIndex]);

    // Write to file
    try {
      writeJSON(dealerFile, dealers);
      console.log(`[dealer-create-pin] dealer.json written successfully`);
    } catch (writeError) {
      console.error("Error writing to dealer.json:", writeError);
      return res.status(500).json({ success: false, error: `Error saving PIN: ${writeError.message}` });
    }

    console.log(`[dealer-create-pin] dealer.json content after write:`, readJSON(dealerFile));

    // After creating the PIN, mark the dealer as verified
    req.session.hasDealerPin = true; // Update session flag
    req.session.dealerVerified = true; // Allow immediate access to dashboard
    
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
  const phoneNumber = req.session.user.phoneNumber;
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

  const dealers = readJSON(dealerFile, []);
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(phoneNumber));

  if (!dealer || !dealer.pin) {
    if (isApi) return res.json({ success: false, error: "Dealer account not found or PIN not set" });
    return res.redirect("/dealer");
  }

  try {
    const isMatch = await bcrypt.compare(pin, dealer.pin);
    if (isMatch) {
      req.session.dealerVerified = true; // Set session flag for successful dealer PIN verification
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
router.get("/dashboard-data", (req, res) => {
  const phoneNumber = req.session.user.phoneNumber;

  if (!phoneNumber) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const dealers = readJSON(dealerFile, []);
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(phoneNumber));

  if (!dealer) {
    return res.status(404).json({ success: false, error: "Dealer not found" });
  }

  const agents = readJSON(agentFile, []);
  const dealerAgents = agents.filter((a) => norm(a.dealerPhone) === norm(phoneNumber));

  res.json({
    success: true,
    dealer: dealer,
    agents: dealerAgents
  });
});


module.exports = router;
