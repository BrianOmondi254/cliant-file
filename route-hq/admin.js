const express = require("express");
const bcrypt = require("bcrypt");
const { ensureMongoReady, findUserInCounties, Admin, SuperAdmin } = require("../mongoose");
const { processMessage } = require("../notification/notification");

const router = express.Router();

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

router.get("/check-superadmin", async (req, res) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      return res.json({ status: "ERROR", message: "Database not available" });
    }
    const count = await SuperAdmin.countDocuments();
    return res.json({ status: "OK", exists: count > 0 });
  } catch (err) {
    console.error("Error checking superadmin:", err);
    return res.json({ status: "ERROR", message: err.message });
  }
});

router.post("/verify-phone", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system."
    });
  }

  return res.json({
    status: "FOUND",
    name: `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.trim().toUpperCase()
  });
});

router.post("/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }

  const passkey = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.adminOTP = {
    phone: phone.trim(),
    passkey,
    expiresAt: Date.now() + 180000
  };

  processMessage("HQ Admin", {
    to: phone.trim(),
    type: "security_alert",
    title: "Admin Passkey",
    content: `Your one-time admin passkey is: ${passkey}\nThis passkey expires in 3 minutes.`,
    key: passkey
  });

  if (!req.session.user) {
    req.session.user = { phoneNumber: phone.trim() };
  }
  if (!req.session.user.inbox) {
    req.session.user.inbox = [];
  }
  req.session.user.inbox.push({
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: "security_alert",
    title: "Admin Passkey",
    content: `Your one-time admin passkey is: ${passkey}\nThis passkey expires in 3 minutes.`,
    date: new Date().toISOString(),
    unread: true,
    redirect: "/hq"
  });

  return res.json({
    status: "SENT",
    message: "Passkey sent. Check your inbox — expires in 3 minutes."
  });
});

router.post("/register", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const existing = await Admin.findOne({ phoneNumber: norm(phone) }).lean();
  if (existing) {
    return res.json({
      status: "ALREADY_REGISTERED",
      message: "Admin already registered for this phone number."
    });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system."
    });
  }

  const fullName = `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.trim().toUpperCase();

  return res.json({
    status: "ALLOW_PIN",
    name: fullName
  });
});

router.post("/create-pin", async (req, res) => {
  const { phone, pin, department } = req.body;
  if (!phone || !pin || !department) {
    return res.json({ status: "ERROR", message: "Phone, PIN and department are required." });
  }

  const normalised = norm(phone);

  const existing = await Admin.findOne({ phoneNumber: normalised }).lean();
  if (existing) {
    return res.json({ status: "ALREADY_REGISTERED", message: "Admin already exists." });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({ status: "ERROR", message: "User not found in system." });
  }

  const fullName = `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.trim().toUpperCase();
  const hashedPin = await bcrypt.hash(pin, 10);

  const admin = new Admin({
    phoneNumber: normalised,
    name: fullName,
    department,
    pin: hashedPin,
    createdAt: new Date()
  });

  await admin.save();

  return res.json({
    status: "SUCCESS",
    message: "Admin account created successfully."
  });
});

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const admin = await Admin.findOne({ phoneNumber: norm(phone) }).lean();
  if (!admin) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Admin account not found."
    });
  }

  const pinMatch = await bcrypt.compare(pin, admin.pin);
  if (!pinMatch) {
    return res.json({
      status: "WRONG_PIN",
      message: "Wrong PIN."
    });
  }

  req.session.hqUser = {
    phoneNumber: admin.phoneNumber,
    name: admin.name,
    department: admin.department
  };

  return res.json({
    status: "SUCCESS",
    name: admin.name,
    department: admin.department
  });
});

module.exports = router;
