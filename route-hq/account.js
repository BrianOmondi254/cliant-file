const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const router = express.Router();

/* ================= FILE PATHS ================= */
const dataFile = path.join(__dirname, "../data.json");
const officialFile = path.join(__dirname, "../official.json");
const statsFile = path.join(__dirname, "../personal_stats.json");

/* ================= HELPERS ================= */
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

const norm = (p) => (p ? String(p).trim() : "");

/* ================= GET HQ DASHBOARD ================= */
router.get("/", (req, res) => {
  res.render("hq/hq");
});

// Dynamic section route
router.get("/:section", (req, res) => {
  const section = req.params.section.toLowerCase();

  // Allowed sections
  const allowedSections = ['finance', 'relations', 'it', 'operations', 'compliance', 'hr'];
  if (!allowedSections.includes(section)) return res.status(404).send('Not found');

  // Render the corresponding EJS view
  res.render(`hq/${section}`, { sectionName: section.charAt(0).toUpperCase() + section.slice(1) });
});


/* ================= REGISTER: VERIFY PHONE ================= */
router.post("/register", (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const dataUsers = readJSON(dataFile);
  const officialUsers = readJSON(officialFile);

  const user = dataUsers.find(u => {
    return norm(u.phoneNumber) === norm(phone);
  });
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system."
    });
  }

  const already = officialUsers.find(u => norm(u.phoneNumber) === norm(phone));
  if (already) {
    return res.json({
      status: "ALREADY_REGISTERED",
      message: "Admin already registered."
    });
  }

  return res.json({
    status: "ALLOW_PIN",
    name: `${user.FirstName} ${user.MiddleName} ${user.LastName}`.toUpperCase()
  });
});

/* ================= REGISTER: CREATE PIN ================= */
router.post("/create-pin", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const dataUsers = readJSON(dataFile);
  const officialUsers = readJSON(officialFile);

  const user = dataUsers.find(u => norm(u.phoneNumber) === norm(phone));
  if (!user) {
    return res.json({ status: "ERROR", message: "User not found." });
  }

  if (officialUsers.find(u => norm(u.phoneNumber) === norm(phone))) {
    return res.json({ status: "ALREADY_REGISTERED" });
  }

  const hashedPin = await bcrypt.hash(pin, 10);

  officialUsers.push({
    phoneNumber: phone,
    name: `${user.FirstName} ${user.MiddleName} ${user.LastName}`.toUpperCase(),
    pin: hashedPin,
    createdAt: new Date().toISOString()
  });

  writeJSON(officialFile, officialUsers);

  return res.json({
    status: "SUCCESS",
    message: "Account created successfully."
  });
});

/* ================= LOGIN ================= */
router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const dataUsers = readJSON(dataFile);
  const officialUsers = readJSON(officialFile);

  const inData = dataUsers.find(u => norm(u.phoneNumber) === norm(phone));
  const inOfficial = officialUsers.find(u => norm(u.phoneNumber) === norm(phone));

  // ❌ Must exist in BOTH files
  if (!inData || !inOfficial) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Account not registered."
    });
  }

  const pinMatch = await bcrypt.compare(pin, inOfficial.pin);
  if (!pinMatch) {
    return res.json({
      status: "WRONG_PIN",
      message: "Wrong PIN."
    });
  }

  // ✅ Save session user
  req.session.hqUser = {
    phoneNumber: phone,
    name: inOfficial.name
  };

  return res.json({
    status: "SUCCESS",
    name: inOfficial.name
  });
});

module.exports = router;
