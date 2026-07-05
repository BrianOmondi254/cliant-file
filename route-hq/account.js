const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { findUserInCounties, Admin, normalizePhone } = require("../mongoose");

const router = express.Router();

const protectDepartment = async (req, res, next) => {
  if (!req.session || !req.session.hqUser) {
    return res.redirect("/hq");
  }

  const section = req.params.section.toLowerCase();
  const deptMap = {
    finance: "Finance",
    relations: "Relations",
    it: "IT Department",
    operations: "Operations",
    hr: "Human Resources",
    compliance: "Compliance",
    regions: "Regions"
  };

  const requiredDept = deptMap[section];
  if (requiredDept) {
    const admin = await Admin.findOne({ phoneNumber: normalizePhone(req.session.hqUser.phoneNumber) }).lean();
    if (!admin || admin.department !== requiredDept) {
      return res.status(403).send("Forbidden. You do not have access to this department.");
    }
  }
  next();
};

/* ================= FILE PATHS ================= */
const officialFile = path.join(__dirname, "../official.json");

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
router.get("/:section", protectDepartment, async (req, res) => {
  let section = req.params.section.toLowerCase();

  // Map dashed URLs to view names
  const sectionMap = {
    'it-department': 'it',
    'human-resources': 'hr'
  };
  
  if (sectionMap[section]) {
    section = sectionMap[section];
  }

  // Allowed sections (mapped keys)
  const allowedSections = ['finance', 'relations', 'it', 'operations', 'compliance', 'hr', 'regions'];
  if (!allowedSections.includes(section)) return res.status(404).send('Not found');

  // Render the corresponding EJS view - regions needs county info
  if (section === 'regions') {
    const admin = await Admin.findOne({ phoneNumber: normalizePhone(req.session.hqUser.phoneNumber) }).lean();
    const county = admin?.county || "";
    const initials = (req.session.hqUser.name || "HQ").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    return res.render("hq/regions", {
      county: county,
      name: req.session.hqUser.name,
      initials: initials,
      hqUser: req.session.hqUser
    });
  }

  // For hr, show the hr view; for others just show section name
  const viewMap = { hr: 'Human Resources' };
  const sectionName = viewMap[section] || section.charAt(0).toUpperCase() + section.slice(1);
  res.render(`hq/${section}`, { sectionName });
});


/* ================= REGISTER: VERIFY PHONE ================= */
router.post("/register", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const officialUsers = readJSON(officialFile);

  const user = await findUserInCounties(phone);

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
    name: `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.toUpperCase()
  });
});

/* ================= REGISTER: CREATE PIN ================= */
router.post("/create-pin", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const officialUsers = readJSON(officialFile);

  const user = await findUserInCounties(phone);

  if (!user) {
    return res.json({ status: "ERROR", message: "User not found." });
  }

  if (officialUsers.find(u => norm(u.phoneNumber) === norm(phone))) {
    return res.json({ status: "ALREADY_REGISTERED" });
  }

  const hashedPin = await bcrypt.hash(pin, 10);

  officialUsers.push({
    phoneNumber: phone,
    name: `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.toUpperCase(),
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

  const officialUsers = readJSON(officialFile);

  const userExists = await findUserInCounties(phone);

  const inOfficial = officialUsers.find(u => norm(u.phoneNumber) === norm(phone));

  if (!userExists || !inOfficial) {
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