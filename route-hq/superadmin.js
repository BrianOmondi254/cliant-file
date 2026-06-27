const express = require("express");
const bcrypt = require("bcrypt");
const { ensureMongoReady, findUserInCounties, SuperAdmin } = require("../mongoose");

const router = express.Router();

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

router.post("/register", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const existing = await SuperAdmin.findOne({ phoneNumber: norm(phone) }).lean();
  if (existing) {
    return res.json({
      status: "ALREADY_REGISTERED",
      message: "Super Admin already registered for this phone number."
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
  const { phone, pin, passkey } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }

  const normalised = norm(phone);
  const existing = await SuperAdmin.findOne({ phoneNumber: normalised }).lean();
  if (existing) {
    return res.json({ status: "ALREADY_REGISTERED", message: "Super Admin already exists." });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({ status: "ERROR", message: "User not found in system." });
  }

  if (passkey) {
    if (!req.session.adminOTP || req.session.adminOTP.phone !== normalised || req.session.adminOTP.passkey !== passkey) {
      return res.json({ status: "WRONG_PASSKEY", message: "Invalid or expired passkey." });
    }
    if (Date.now() > req.session.adminOTP.expiresAt) {
      delete req.session.adminOTP;
      return res.json({ status: "EXPIRED", message: "Passkey has expired. Please try again." });
    }
    return res.json({ status: "SUCCESS", message: "Passkey verified." });
  }

  if (!pin) {
    return res.json({ status: "ERROR", message: "PIN is required." });
  }

  const fullName = `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`.trim().toUpperCase();
  const hashedPin = await bcrypt.hash(pin, 10);

  const superAdmin = new SuperAdmin({
    phoneNumber: normalised,
    name: fullName,
    pin: hashedPin,
    createdAt: new Date()
  });

  delete req.session.adminOTP;
  await superAdmin.save();

  return res.json({
    status: "SUCCESS",
    message: "Super Admin account created successfully."
  });
});

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const superAdmin = await SuperAdmin.findOne({ phoneNumber: norm(phone) }).lean();
  if (!superAdmin) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Super Admin account not found."
    });
  }

  const pinMatch = await bcrypt.compare(pin, superAdmin.pin);
  if (!pinMatch) {
    return res.json({
      status: "WRONG_PIN",
      message: "Wrong PIN."
    });
  }

  req.session.hqUser = {
    phoneNumber: superAdmin.phoneNumber,
    name: superAdmin.name,
    role: "superadmin"
  };

  return res.json({
    status: "SUCCESS",
    name: superAdmin.name
  });
});

module.exports = router;
