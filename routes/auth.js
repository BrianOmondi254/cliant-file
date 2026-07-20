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
  normalizePhone,
  getTbankSettings,
  findAgentByPhone,
  findDealerByPhone,
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
router.get("/login", async (req, res) => {
  // If already logged in, redirect to dashboard to 'hide' the login URL
  if (req.session && req.session.user) {
    return res.redirect("/personal");
  }

  // Reflect the HQ-selected auth option (Email / OTP / login)
  let authOption = "login";
  let suspended = false;
  try {
    if (await ensureMongoReady()) {
      const settings = await getTbankSettings();
      const opt =
        settings && settings.lastSelectedAuthOption && settings.lastSelectedAuthOption.option
          ? String(settings.lastSelectedAuthOption.option).toLowerCase()
          : "";
      if (opt === "suspend") {
        suspended = true;
      } else if (opt === "email" || opt === "otp") {
        authOption = opt;
      }
    }
  } catch (e) {
    console.error("Error reading auth option:", e.message);
  }

  res.render("login", buildLoginContext({ alert: null, authOption, suspended }));
});

/**
 * Builds the full set of variables the login.ejs template requires,
 * so every render path (GET and POST-failure) supplies firebaseConfig,
 * authOption and suspended consistently.
 */
function buildLoginContext(extra = {}) {
  return Object.assign({
    alert: null,
    authOption: "login",
    suspended: false,
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    }
  }, extra);
}

/* 🔑 Firebase Login Success Callback */
router.post("/firebase-login", async (req, res) => {
  let loginPhone = (req.body.phoneNumber || "").trim();

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.render("login", { alert: getMongoConfigHint() });
  }

  try {
    let user = await findUserByPhone(loginPhone);
    if (!user) {
      return res.render("register", {
        message: "Phone number not registered. Please create an account.",
        form: { phoneNumber: loginPhone },
      });
    }

    // Update last login
    await updateLastLogin(loginPhone);

    // Save session user
    req.session.user = { 
      phoneNumber: user.phoneNumber,
      firstName: user.FirstName,
      lastName: user.LastName,
      idNumber: user.idNumber
    };

    const tbankData = readJSON(tbankFile, {});
    req.session.loginSeason = tbankData.compliance?.periods?.season || "Annual";

    const normalizedUserPhone = normalizePhone(user.phoneNumber || loginPhone || "");
    const rawPhone = user.phoneNumber || loginPhone || "";
    const phoneVariants = [...new Set([
      rawPhone,
      normalizedUserPhone,
      "0" + normalizedUserPhone,
      "254" + normalizedUserPhone,
      "+254" + normalizedUserPhone
    ])];
    let mongoAgent = await Agent.findOne({ phoneNumber: { $in: phoneVariants } }).lean();
    let mongoDealer = await Dealer.findOne({ phoneNumber: { $in: phoneVariants } }).lean();

    req.session.isAgent = !!mongoAgent;
    req.session.isDealer = !!mongoDealer;
    req.session.agent = mongoAgent ? mongoAgent : (req.session.isAgent ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasAgentPin = req.session.agent ? !!req.session.agent.pin : false;
    
    req.session.dealer = mongoDealer ? mongoDealer : (req.session.isDealer ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasDealerPin = req.session.dealer ? !!req.session.dealer.pin : false;

    req.session.save((err) => {
      res.redirect("/personal");
    });
  } catch (err) {
    console.error("Firebase Login DB Error:", err);
    return res.render("login", { alert: "Database error during login." });
  }
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

  if (!valid) return res.render("login", loginRenderContext({ alert: "Wrong password! Check your password and try again." }));

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

  // Determine if user is agent or dealer and save to session (MongoDB only).
  // findAgentByPhone / findDealerByPhone tolerate any stored phone format.
  let mongoAgent = null;
  let mongoDealer = null;
  try {
    const dbReady = await ensureMongoReady();
    if (dbReady) {
      mongoAgent = await findAgentByPhone(loginPhone);
      mongoDealer = await findDealerByPhone(loginPhone);
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

/* 🔑 Forgot PIN (POST /forgot-pin) */
router.post("/forgot-pin", async (req, res) => {
  const phoneNumber = (req.body.phoneNumber || "").trim();

  if (!phoneNumber) {
    return res.json({ success: false, message: "Phone number is required" });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database not available. Please try again later." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "Phone number not registered." });
    }

    // TODO: Implement start key generation and SMS dispatch
    return res.json({ success: true, message: "Start key request received. Please contact support for assistance." });
  } catch (err) {
    console.error("Forgot PIN error:", err);
    return res.json({ success: false, message: "Server error. Please try again." });
  }
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

/* 📨 Send Email OTP Code */
const nodemailer = require("nodemailer");

router.post("/send-email-otp", async (req, res) => {
  let { phoneNumber, email } = req.body;
  phoneNumber = (phoneNumber || "").trim();
  email = (email || "").trim();

  if (!phoneNumber || !email) {
    return res.json({ success: false, message: "Phone number and email are required." });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database not available. Please try again later." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "Phone number is not registered. Please create an account first." });
    }

    // Generate a 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in session with 5 minutes expiration
    req.session.emailOtp = {
      code,
      phoneNumber: user.phoneNumber,
      email,
      expires: Date.now() + 5 * 60 * 1000
    };

    console.log(`\n📨 [DEV MODE] Email OTP generated for ${email}: ${code}\n`);

    // Attempt to send email
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const mailOptions = {
          from: `"Tbank Investment" <${process.env.SMTP_USER}>`,
          to: email,
          subject: "Your Tbank Verification Code",
          text: `Your verification code is: ${code}. It expires in 5 minutes.`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px; margin: 0 auto;">
              <h2 style="color: #0f9d58; margin-bottom: 8px;">Tbank Investment</h2>
              <p style="color: #475569; font-size: 14px;">You requested a one-time code to sign in to your Tbank account.</p>
              <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #1e293b; margin: 20px 0;">
                ${code}
              </div>
              <p style="font-size: 12px; color: #64748b; margin-top: 20px;">This code is valid for 5 minutes. If you did not request this code, please ignore this email.</p>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
        console.log(`[SMTP] Verification email sent successfully to ${email}`);
      } else {
        console.warn("[SMTP] Credentials not found in .env file. Running in dev-print mode only.");
      }
    } catch (mailErr) {
      console.error("[SMTP] Mail send error:", mailErr.message);
      // Fallback gracefully so local dev doesn't crash: still succeed and let them check node terminal console
    }

    return res.json({ 
      success: true, 
      message: process.env.SMTP_USER && process.env.SMTP_PASS 
        ? "Verification code sent to your email address." 
        : "Dev Mode: Verification code printed to Server Console log."
    });
  } catch (err) {
    console.error("Send Email OTP Error:", err);
    return res.json({ success: false, message: "Server error sending OTP." });
  }
});

/* 📨 Verify Email OTP Code */
router.post("/verify-email-otp", async (req, res) => {
  const { otp } = req.body;
  
  if (!req.session.emailOtp) {
    return res.json({ success: false, message: "No active verification session. Please request a new code." });
  }

  const { code, phoneNumber, expires } = req.session.emailOtp;

  if (Date.now() > expires) {
    delete req.session.emailOtp;
    return res.json({ success: false, message: "Verification code expired. Please request a new one." });
  }

  if (otp !== code) {
    return res.json({ success: false, message: "Invalid verification code." });
  }

  const dbReady = await ensureMongoReady();
  if (!dbReady) {
    return res.json({ success: false, message: "Database error during validation." });
  }

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "User account not found." });
    }

    // Clean up OTP session
    delete req.session.emailOtp;

    // Update last login
    await updateLastLogin(phoneNumber);

    // Save session user
    req.session.user = { 
      phoneNumber: user.phoneNumber,
      firstName: user.FirstName,
      lastName: user.LastName,
      idNumber: user.idNumber
    };

    const tbankData = readJSON(tbankFile, {});
    req.session.loginSeason = tbankData.compliance?.periods?.season || "Annual";

    const normalizedUserPhone = normalizePhone(user.phoneNumber || "");
    const rawPhone = user.phoneNumber || "";
    const phoneVariants = [...new Set([
      rawPhone,
      normalizedUserPhone,
      "0" + normalizedUserPhone,
      "254" + normalizedUserPhone,
      "+254" + normalizedUserPhone
    ])];
    let mongoAgent = await Agent.findOne({ phoneNumber: { $in: phoneVariants } }).lean();
    let mongoDealer = await Dealer.findOne({ phoneNumber: { $in: phoneVariants } }).lean();

    req.session.isAgent = !!mongoAgent;
    req.session.isDealer = !!mongoDealer;
    req.session.agent = mongoAgent ? mongoAgent : (req.session.isAgent ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasAgentPin = req.session.agent ? !!req.session.agent.pin : false;
    
    req.session.dealer = mongoDealer ? mongoDealer : (req.session.isDealer ? { phoneNumber: user.phoneNumber } : null);
    req.session.hasDealerPin = req.session.dealer ? !!req.session.dealer.pin : false;

    req.session.save((err) => {
      return res.json({ success: true, redirect: "/personal" });
    });
  } catch (err) {
    console.error("Verify Email OTP DB Error:", err);
    return res.json({ success: false, message: "Database validation error." });
  }
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
