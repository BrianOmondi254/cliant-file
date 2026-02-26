const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const usersFile = path.join(__dirname, "../data.json");
const agentFile = path.join(__dirname, "../agent.json");

// GET dealer page
router.get("/", (req, res) => {
  res.render("dealer/dealer", { preview: null, error: null, success: null });
});

// POST preview agent
router.post("/preview", (req, res) => {
  const { phoneNumber } = req.body;

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "No users found",
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

// POST create agent
router.post("/", (req, res) => {
  const { phoneNumber } = req.body;

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "No users found",
      success: null,
    });
  }

  const users = JSON.parse(fs.readFileSync(usersFile, "utf8") || "[]");

  const user = users.find((u) => u.phoneNumber === phoneNumber);

  if (!user) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "User not found",
      success: null,
    });
  }



  const fullName = nameParts.join(" ") || "Name not provided";

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
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(agentFile, JSON.stringify(agents, null, 2));

  res.render("dealer/dealer", {
    preview: null,
    error: null,
    success: "✅ Agent account created successfully",
  });
});



// Helper functions (re-defined for self-containment, similar to auth.js)
const dealerFile = path.join(__dirname, "../dealer.json");

const readJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error parsing JSON from ${file}:`, e.message); // Log error message
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const norm = (p) => (p ? String(p).trim().replace(/^0+/, '') : "");


// POST create PIN for dealer
router.post("/create-pin", async (req, res) => {
  console.log("[dealer-create-pin] Received request body:", req.body);
  console.log("[dealer-create-pin] Session user:", req.session.user);

  // Ensure session is valid
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    console.log("[dealer-create-pin] Session invalid or user not logged in");
    return res.status(401).json({ success: false, error: "Session expired. Please log in again." });
  }

  const { phoneNumber: bodyPhoneNumber, pin } = req.body;
  
  // Determine the target phoneNumber for PIN creation
  // Prioritize bodyPhoneNumber if provided and matches session, otherwise use session's phoneNumber
  let targetPhoneNumber = req.session.user.phoneNumber;

  if (bodyPhoneNumber) {
    if (bodyPhoneNumber !== req.session.user.phoneNumber) {
      console.log(`[dealer-create-pin] Authorization failed: Session user ${req.session.user.phoneNumber} tried to create PIN for different phone number ${bodyPhoneNumber}`);
      return res.status(403).json({ success: false, error: "Unauthorized to create PIN for this phone number." });
    }
    targetPhoneNumber = bodyPhoneNumber;
  }

  console.log(`[dealer-create-pin] Extracted - targetPhoneNumber: ${targetPhoneNumber}, pin: ${pin}`);

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
      console.log(`[dealer-create-pin] Dealer not found for phone: ${phoneNumber}, adding from data.json`);
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

    req.session.hasDealerPin = true; // Update session flag
    req.session.dealerVerified = true; // Allow immediate access to dashboard
    res.json({ success: true, message: "Dealer PIN created successfully." });
  } catch (error) {
    console.error("Error creating dealer PIN:", error);
    res.status(500).json({ success: false, error: `Internal server error: ${error.message}` });
  }
});


// POST login for dealer (PIN verification)
router.post("/login", async (req, res) => {
  const { phoneNumber, pin } = req.body;

  if (!phoneNumber || !pin) {
    return res.status(400).json({ success: false, error: "Phone number and PIN are required." });
  }

  const dealers = readJSON(dealerFile, []);
  const dealer = dealers.find((d) => norm(d.phoneNumber) === norm(phoneNumber));

  if (!dealer || !dealer.pin) {
    return res.status(401).json({ success: false, error: "Dealer not found or PIN not set." });
  }

  try {
    const isMatch = await bcrypt.compare(pin, dealer.pin);
    if (isMatch) {
      req.session.dealerVerified = true; // Set session flag for successful dealer PIN verification
      res.json({ success: true, message: "Dealer login successful." });
    } else {
      res.status(401).json({ success: false, error: "Invalid PIN." });
    }
  } catch (error) {
    console.error("Error verifying dealer PIN:", error);
    res.status(500).json({ success: false, error: "Internal server error." });
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
