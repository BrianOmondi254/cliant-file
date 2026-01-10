// routes/hq.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const officialFile = path.join(__dirname, "../official.json");

/* ===== HELPERS ===== */
const read = () => {
  try {
    if (fs.existsSync(officialFile)) {
      const data = fs.readFileSync(officialFile, "utf8");
      return JSON.parse(data);
    }
    return [];
  } catch (err) {
    console.error("Failed to read official.json:", err);
    return [];
  }
};

const write = data => {
  try {
    fs.writeFileSync(officialFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to write official.json:", err);
    throw err;
  }
};

/* ===== CHECK ADMIN BY PHONE ===== */
router.get("/check-admin/:phone", (req, res) => {
  const phone = (req.params.phone || "").trim();
  if (!phone) return res.status(400).json({ message: "Phone is required" });

  const admins = read();
  const admin = admins.find(a => a.phoneNumber === phone);

  if (!admin) return res.status(404).json({ message: "Admin not found" });

  // Return safe data only
  res.json({
    name: admin.name,
    phoneNumber: admin.phoneNumber,
    created: admin.created || new Date().toISOString(),
    docet: admin.docet || null,
    status: admin.status || "inactive"
  });
});

/* ===== REGISTER / ACTIVATE VERIFIED ADMIN ===== */
router.post("/register-verified-admin", (req, res) => {
  const { name, docet } = req.body;

  if (!name || !docet) {
    return res.status(400).json({ message: "Missing data" });
  }

  const allowedDocets = ["IT", "Operation", "Finance", "Human Resource", "Relation", "Compliance"];
  if (!allowedDocets.includes(docet)) {
    return res.status(400).json({ message: "Invalid docet" });
  }

  const admins = read();
  const index = admins.findIndex(a => a.name === name);

  if (index === -1) {
    // Admin not found, create new
    const newAdmin = {
      name,
      phoneNumber: "", // optional, or you can pass phone number from frontend
      docet,
      status: "active",
      created: new Date().toISOString()
    };
    admins.push(newAdmin);

    try {
      write(admins);
      return res.json({ message: "Admin registered and activated successfully" });
    } catch (err) {
      return res.status(500).json({ message: "Failed to save admin" });
    }
  }

  // Admin exists
  const admin = admins[index];
  if (admin.status === "active" && admin.docet === docet) {
    return res.status(400).json({ message: "Account has already been registered" });
  }

  // Update admin if inactive or docet missing
  admin.docet = docet;
  admin.status = "active";

  try {
    write(admins);
    return res.json({ message: "Admin registered and activated successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to update admin" });
  }
});



module.exports = router;
