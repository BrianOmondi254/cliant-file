const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const {
  ensureMongoReady,
  getMongoConfigHint,
  saveUserToMongoDB,
  findUserByPhone,
  updateLastLogin,
  updateUserPassword,
  PersonalAccount,
  Agent,
  Dealer,
} = require("../mongoose");

const router = express.Router();
const tbankFile = path.join(__dirname, "../tbank.json");
const statsFile = path.join(__dirname, "../personal_stats.json");
const regPerfLogger = require("../performance/registration-performance");

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

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

/**
 * 🔄 Rotates the registration passkey after an account is created.
 * This ensures "variation" for each new user.
 */
const rotatePasskey = () => {
  const tbank = readJSON(tbankFile, {});
  if (tbank.compliance?.personal_account_registration) {
    const reg = tbank.compliance.personal_account_registration;
    if (reg.paymentMethod === 'mpesa') {
      reg.passkey = Math.floor(10000 + Math.random() * 90000).toString(); // 5 digits
    } else if (reg.paymentMethod === 'passkey') {
      reg.passkey = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
    }
    reg.updatedAt = new Date().toISOString();
    writeJSON(tbankFile, tbank);
  }
};

/* ================= ROUTES ================= */

/* 🏠 Home → redirect to login */
router.get("/", (req, res) => res.redirect("/login"));

/* 📝 Register (GET form) */
router.get("/register", (req, res) => {
  res.render("register", { message: null, form: {} });
});

/* 📝 Register (POST submission) */
router.post("/register", async (req, res) => {
  let {
    FirstName,
    MiddleName,
    LastName,
    email,
    phoneNumber,
    password,
    gender,
    county,
    constituency,
    ward,
    ageBracket,
    idNumber,
    name
  } = req.body;
  phoneNumber = (phoneNumber || "").trim();

  if (!phoneNumber || !password) {
    return res.render("register", {
      message: "Phone number and password are required!",
      form: {}
    });
  }

  // Derive first/middle/last from a single name field if provided
  if (!FirstName && !MiddleName && !LastName && name) {
    const nameParts = String(name).trim().split(/\s+/);
    FirstName = nameParts[0] || "";
    MiddleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : (nameParts.length === 2 ? "" : nameParts[1] || "");
    LastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
  }

  let existingUser = null;
  try {
    if (await ensureMongoReady()) {
      existingUser = await findUserByPhone(phoneNumber);
    }
  } catch (dbErr) {
    console.error("MongoDB check during registration:", dbErr.message);
  }

  if (existingUser) {
    return res.render("register", {
      message: "Phone already registered! Please login instead.",
      form: { phoneNumber }
    });
  }

  const tbankData = readJSON(tbankFile, {});
  const personalReg = tbankData.compliance?.personal_account_registration;

  const registrationData = req.body;

  if (personalReg && personalReg.amount) {
    if (personalReg.paymentMethod === 'passkey' && personalReg.passkey) {
      return res.render('payment', {
        paymentMethod: 'passkey',
        passkey: personalReg.passkey,
        amount: personalReg.amount,
        registrationData: JSON.stringify(registrationData),
        hasPasskey: false
      });
    } else if (personalReg.paymentMethod === 'mpesa') {
      return res.render('payment', {
        paymentMethod: 'mpesa',
        passkey: personalReg.passkey,
        amount: personalReg.amount,
        registrationData: JSON.stringify(registrationData),
        hasPasskey: !!personalReg.passkey
      });
    }
  }

// Save registration ONLY to MongoDB
    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash personalPin if present and plaintext
    let hashedPersonalPin = null;
    if (req.body.personalPin) {
      hashedPersonalPin = req.body.personalPin.startsWith('$2') 
        ? req.body.personalPin 
        : await bcrypt.hash(req.body.personalPin, 10);
    }

    const newUser = {
      FirstName,
      MiddleName,
      LastName,
      email,
      phoneNumber,
      password: hashedPassword,
      gender,
      county,
      constituency,
      ward,
      ageBracket,
      idNumber: idNumber || null,
      createdAt: new Date().toISOString(),
      ...(hashedPersonalPin && { personalPin: hashedPersonalPin })
    };

  try {
    await saveUserToMongoDB(newUser);
  } catch (mongoErr) {
    console.error("Error: Failed to save to MongoDB during registration:", mongoErr.message);
    return res.render("register", {
      message: "Registration failed: Database connection issue. Please try again.",
      form: req.body
    });
  }

  try {
    const personalFile = path.join(__dirname, "../p_account/personal.json");
    const personalData = readJSON(personalFile, { personalAccounts: {} });
    const accountKey = `acct_${Object.keys(personalData.personalAccounts || {}).length + 1}`;
    personalData.personalAccounts[accountKey] = {
      phone: phoneNumber,
      transactions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    personalData.metadata = { ...personalData.metadata, lastUpdated: new Date().toISOString() };
    writeJSON(personalFile, personalData);
    console.log(`[REGISTER] Created personal account ${accountKey} for ${phoneNumber}`);

    // Also save to MongoDB PersonalAccount collection
    try {
      const newPersonalAccount = new PersonalAccount({
        phone: phoneNumber,
        transactions: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });
      await newPersonalAccount.save();
      console.log(`[REGISTER] Saved personal account to MongoDB for ${phoneNumber}`);
    } catch (mongoPersonalErr) {
      console.error("Error saving personal account to MongoDB during registration:", mongoPersonalErr.message);
    }
  } catch (personalErr) {
    console.error("Error creating personal account during registration:", personalErr.message);
  }

  // Log Performance
  try {
      regPerfLogger.logRegistration(newUser.county, newUser.constituency, newUser.ward, 'members');
  } catch (e) {
      console.error("Member registration performance log error:", e);
  }

  // 🔄 Rotate passkey for the next user
  rotatePasskey();

  res.render("login", { alert: "Registration successful. Login now." });
});

router.post("/complete-registration", async (req, res) => {
    const { registrationData, startky, passkey } = req.body;
    const userData = JSON.parse(registrationData);

    const {
        FirstName,
        MiddleName,
        LastName,
        email,
        phoneNumber,
        password,
        gender,
        county,
        constituency,
        ward,
        ageBracket,
        idNumber
    } = userData;

    // 🛡️ Security Check: Verify Passkey against HQ Compliance
    const tbankData = readJSON(tbankFile, {});
    const personalReg = tbankData.compliance?.personal_account_registration;

    // If a passkey is required by HQ, ensure the user provided the matching one
    if (personalReg && (personalReg.paymentMethod === 'passkey' || personalReg.paymentMethod === 'mpesa') && personalReg.passkey) {
        if (passkey !== personalReg.passkey) {
            return res.render("register", {
                message: "Registration failed: Invalid Passkey.",
                form: userData
            });
        }
    }

    // Normalize phone number
    let normPhone = (phoneNumber || "").trim();

    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash personalPin if present and plaintext
    let hashedPersonalPin = null;
    if (userData.personalPin) {
      hashedPersonalPin = userData.personalPin.startsWith('$2') 
        ? userData.personalPin 
        : await bcrypt.hash(userData.personalPin, 10);
    }

    const newUser = {
        FirstName,
        MiddleName,
        LastName,
        email,
        phoneNumber: normPhone,
        password: hashedPassword,
        gender,
        county,
        constituency,
        ward,
        ageBracket,
        idNumber: idNumber || null,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        ...(hashedPersonalPin && { personalPin: hashedPersonalPin })
    };

    if (passkey) {
        newUser.passkey = passkey;
    }
    if (startky) {
        newUser.startky = startky;
    }

    // Save to MongoDB
    try {
      await saveUserToMongoDB(newUser);
    } catch (mongoErr) {
      console.error("Error: Failed to save to MongoDB during completion:", mongoErr.message);
      return res.render("register", {
          message: "Registration failed: Database connection issue. Please try again.",
          form: userData
      });
    }

    try {
      const personalFile = path.join(__dirname, "../p_account/personal.json");
      const personalData = readJSON(personalFile, { personalAccounts: {} });
      const accountKey = `acct_${Object.keys(personalData.personalAccounts || {}).length + 1}`;
      personalData.personalAccounts[accountKey] = {
        phone: normPhone,
        transactions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      personalData.metadata = { ...personalData.metadata, lastUpdated: new Date().toISOString() };
      writeJSON(personalFile, personalData);
      console.log(`[REGISTER] Created personal account ${accountKey} for ${normPhone}`);

      // Also save to MongoDB PersonalAccount collection
      try {
        const newPersonalAccount = new PersonalAccount({
          phone: normPhone,
          transactions: [],
          createdAt: new Date(),
          updatedAt: new Date()
        });
        await newPersonalAccount.save();
        console.log(`[REGISTER] Saved personal account to MongoDB for ${normPhone}`);
      } catch (mongoPersonalErr) {
        console.error("Error saving personal account to MongoDB during registration:", mongoPersonalErr.message);
      }
    } catch (personalErr) {
      console.error("Error creating personal account during completion:", personalErr.message);
    }

    // Log Performance
    try {
        regPerfLogger.logRegistration(newUser.county, newUser.constituency, newUser.ward, 'members');
    } catch (e) {
        console.error("Member registration performance log error:", e);
    }

    // Update statistics
    const stats = readJSON(statsFile, { totalRegistrations: 0, mpesaPayments: 0, passkeyPayments: 0 });
    stats.totalRegistrations++;
    if (personalReg && personalReg.paymentMethod === 'mpesa') {
        stats.mpesaPayments++;
    } else if (personalReg && personalReg.paymentMethod === 'passkey') {
        stats.passkeyPayments++;
    }
    writeJSON(statsFile, stats);

    // 🔄 Rotate passkey for the next user
    rotatePasskey();

    res.render("login", { alert: "Registration successful. Login now." });
});

/* 🔑 Login (GET form) */
router.get("/login", (req, res) => {
  // If already logged in, redirect to dashboard to 'hide' the login URL
  if (req.session && req.session.user) {
    return res.redirect("/personal");
  }
  res.render("login", { alert: null });
});

/* 🔑 Login (POST submission) */
router.post("/login", async (req, res) => {
  let loginPhone = (req.body.phoneNumber || "").trim();
  let loginPassword = req.body.password || "";

  console.log("\n🔐 LOGIN ATTEMPT:");
  console.log("   Phone entered :", loginPhone, "-> norm:", norm(loginPhone));
  console.log("   Password length:", loginPassword.length);

  let user = null;

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    console.log("   ❌ MongoDB not connected during login");
    return res.render("login", {
      alert: getMongoConfigHint(),
    });
  }

  // 1️⃣ Find user in MongoDB counties collection (primary registry)
  try {
    user = await findUserByPhone(loginPhone);
    if (user) {
      console.log("   ✅ User found in MongoDB:", user.FirstName, user.LastName);
    }
  } catch (dbErr) {
    console.error("❌ Database query error during login:", dbErr.message);
    return res.render("login", {
      alert: "Could not verify your account. Please try again shortly.",
    });
  }

  // 3️⃣ Not registered anywhere
  if (!user) {
    console.log("   ❌ Phone not found in MongoDB counties registry");
    return res.render("register", {
      message: "Phone number not registered. Please create an account.",
      form: { phoneNumber: req.body.phoneNumber },
    });
  }

  // 4️⃣ Verify password
  if (!user.password) {
    console.log("   ❌ No password hash in user record!");
    return res.render("login", { alert: "Account error: No password set. Contact admin." });
  }

  const valid = await bcrypt.compare(loginPassword, user.password);
  console.log("   bcrypt result :", valid ? "✅ MATCH" : "❌ NO MATCH");

  if (!valid) return res.render("login", { alert: "Wrong password! Check your password and try again." });

  // Update last login in MongoDB
  try {
    await updateLastLogin(loginPhone);
  } catch (dbErr) {
    console.error("❌ Failed to update last login in MongoDB:", dbErr.message);
  }

  // ✅ Save session user
  req.session.user = { 
    phoneNumber: user.phoneNumber,
    firstName: user.FirstName,
    lastName: user.LastName,
    idNumber: user.idNumber
  };

  // Set season in session
  const tbankData = readJSON(tbankFile, {});
  const currentSeason = tbankData.compliance?.periods?.season || "Annual";
  req.session.loginSeason = currentSeason;

  // Determine if user is agent or dealer and save to session (MongoDB only)
  let mongoAgent = null;
  let mongoDealer = null;
  try {
    const dbReady = await ensureMongoReady();
    if (dbReady) {
      mongoAgent = await Agent.findOne({ phoneNumber: user.phoneNumber }).lean();
      mongoDealer = await Dealer.findOne({ phoneNumber: user.phoneNumber }).lean();
    }
  } catch (dbErr) {
    console.error("MongoDB agent/dealer lookup error during login:", dbErr.message);
  }

  req.session.isAgent = !!mongoAgent;
  req.session.isDealer = !!mongoDealer;

  if (req.session.isAgent) {
    req.session.agent = mongoAgent || { phoneNumber: user.phoneNumber };
    req.session.hasAgentPin = !!req.session.agent.pin;
  } else {
    req.session.agent = null;
    req.session.hasAgentPin = false;
  }

  if (req.session.isDealer) {
    req.session.dealer = mongoDealer || { phoneNumber: user.phoneNumber };
    req.session.hasDealerPin = !!req.session.dealer.pin;
  } else {
    req.session.dealer = null;
    req.session.hasDealerPin = false;
  }

  // ✅ Save session before redirecting to prevent session write race conditions
  req.session.save((err) => {
    if (err) {
      console.error("❌ Session save error during login redirect:", err);
    }
    res.redirect("/personal");
  });
});

/* 🛠️ Admin: Reset a user's password (POST /admin/reset-password) */
/* Usage: POST with { adminCode, phoneNumber, newPassword } */
router.post("/admin/reset-password", async (req, res) => {
  const { adminCode, phoneNumber, newPassword } = req.body;

  // Protect with the admin code from the login page
  if (adminCode !== "35951444") {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (!phoneNumber || !newPassword) {
    return res.status(400).json({ error: "Phone and new password required" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);

  // 1️⃣ Try to reset password in MongoDB
  try {
    const mongoUser = await findUserByPhone(phoneNumber);
    if (mongoUser) {
      await updateUserPassword(phoneNumber, hashed);
      console.log("🛠️ Password reset in MongoDB for:", phoneNumber);
      return res.json({ success: true, message: "Password updated in MongoDB for " + phoneNumber });
    }
  } catch (dbErr) {
    console.error("❌ Database error during admin password reset:", dbErr.message);
  }

  return res.status(404).json({ error: "User not found" });
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
