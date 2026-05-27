const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { saveUserToMongoDB, findUserByPhone } = require("../mongoose");

const router = express.Router();
const usersFile = path.join(__dirname, "../data.json");
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
    idNumber
  } = req.body;
  const users = readJSON(usersFile, []);

  // Normalize phone number (strip leading zero)
  phoneNumber = (phoneNumber || "").trim();
  // phoneNumber = (phoneNumber || "").trim();
  // if (phoneNumber.startsWith("0")) phoneNumber = phoneNumber.substring(1);

  if (!phoneNumber || !password) {
    return res.render("register", {
      message: "Phone number and password are required!",
      form: {}
    });
  }

  if (users.find(u => {
    return norm(u.phoneNumber) === norm(phoneNumber);
  })) {
    return res.render("register", {
      message: "Phone already registered!",
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
    idNumber: idNumber || null, // Make ID optional
    createdAt: new Date().toISOString()
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

    const users = readJSON(usersFile, []);

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
    // if (normPhone.startsWith("0")) normPhone = normPhone.substring(1);

    // Check for phone number again, just in case
    if (users.find(u => {
        return norm(u.phoneNumber) === norm(normPhone);
    })) {
        return res.render("register", {
            message: "Phone already registered!",
            form: userData
        });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

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
        lastLogin: new Date().toISOString()
    };

    if (passkey) {
        newUser.passkey = passkey;
    }
    if (startky) {
        newUser.startky = startky;
    }

    // Save to MongoDB (leave no trace in data.json)
    try {
      await saveUserToMongoDB(newUser);
    } catch (mongoErr) {
      console.error("Error: Failed to save to MongoDB during completion:", mongoErr.message);
      return res.render("register", {
          message: "Registration failed: Database connection issue. Please try again.",
          form: userData
      });
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
  let isFromJSON = false;
  let userIndexInJSON = -1;
  const usersFromJSON = readJSON(usersFile, []);

  // 1️⃣ Try to find the user in MongoDB first
  try {
    user = await findUserByPhone(loginPhone);
    if (user) {
      console.log("   ✅ User found in MongoDB:", user.FirstName, user.LastName);
    }
  } catch (dbErr) {
    console.error("❌ Database query error during login:", dbErr.message);
  }

  // 2️⃣ If not found in MongoDB, search in data.json (legacy fallback)
  if (!user) {
    userIndexInJSON = usersFromJSON.findIndex(u => norm(u.phoneNumber) === norm(loginPhone));
    if (userIndexInJSON !== -1) {
      user = usersFromJSON[userIndexInJSON];
      isFromJSON = true;
      console.log("   ✅ User found in data.json:", user.FirstName, user.LastName);
    }
  }

  // 3️⃣ If not found in either, redirect to registration
  if (!user) {
    console.log("   ❌ Phone not found in MongoDB or data.json");
    return res.render("register", {
      message: "Phone number not registered. Please create an account.",
      form: { phoneNumber: req.body.phoneNumber }
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

  // 5️⃣ JIT Export: If legacy user from JSON, migrate them to MongoDB and delete from data.json
  if (isFromJSON) {
    try {
      console.log(`🚚 Exporting legacy user ${user.phoneNumber} to MongoDB...`);
      // Update lastLogin time
      user.lastLogin = new Date().toISOString();
      
      // Save to MongoDB
      await saveUserToMongoDB(user);
      console.log(`✅ Successfully saved exported user ${user.phoneNumber} to MongoDB.`);

      // Remove from data.json (leave NO TRACE)
      usersFromJSON.splice(userIndexInJSON, 1);
      writeJSON(usersFile, usersFromJSON);
      console.log(`🗑️ Successfully removed user ${user.phoneNumber} from data.json.`);
    } catch (exportErr) {
      console.error(`❌ JIT Migration failed for ${user.phoneNumber}:`, exportErr.message);
      // Fallback: keep them in data.json for now so we don't lose the account!
      usersFromJSON[userIndexInJSON].lastLogin = new Date().toISOString();
      writeJSON(usersFile, usersFromJSON);
    }
  } else {
    // Already in MongoDB, just update last login
    const { updateLastLogin } = require("../mongoose");
    try {
      await updateLastLogin(user.phoneNumber);
    } catch (dbErr) {
      console.error("❌ Failed to update last login in MongoDB:", dbErr.message);
    }
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

  // Determine if user is agent or dealer and save to session
  const agentFile = path.join(__dirname, "../agent.json");
  const dealerFile = path.join(__dirname, "../dealer.json");
  const agents = readJSON(agentFile, []);
  const dealers = readJSON(dealerFile, []);

  const checkItem = (item, phone) => {
    if (!item) return false;
    let itemPhone = "";
    if (typeof item === 'string') itemPhone = item;
    else if (item.phoneNumber) itemPhone = item.phoneNumber;
    else if (item.phone) itemPhone = item.phone;
    return norm(itemPhone) === norm(phone);
  };

  const searchInFile = (data, phone) => {
    if (!data) return false;
    if (checkItem(data, phone)) return true;
    if (Array.isArray(data)) return data.some(item => searchInFile(item, phone));
    if (typeof data === 'object') {
      const keyMatch = Object.keys(data).some(k => norm(k) === norm(phone));
      if (keyMatch) return true;
      // Only recurse into objects/arrays to avoid matching relationship strings (like dealerPhone)
      return Object.values(data).some(val => (typeof val === 'object' || Array.isArray(val)) && searchInFile(val, phone));
    }
    return false;
  };

  req.session.isAgent = searchInFile(agents, user.phoneNumber);
  req.session.isDealer = searchInFile(dealers, user.phoneNumber);

  // If user is an agent, store the agent object and pin status in session
  if (req.session.isAgent) {
    let agent = null;
    if (Array.isArray(agents)) {
      agent = agents.find(a => norm(a.phoneNumber) === norm(user.phoneNumber));
    } else {
      agent = { phoneNumber: user.phoneNumber };
    }
    req.session.agent = agent;
    req.session.hasAgentPin = agent ? (agent.pin && !(typeof agent.pin === 'object' && Object.keys(agent.pin).length === 0)) : false;
  } else {
    req.session.agent = null;
    req.session.hasAgentPin = false;
  }

  // If user is a dealer, store the dealer object and pin status in session
  if (req.session.isDealer) {
    let dealer = null;
    if (Array.isArray(dealers)) {
      dealer = dealers.find(d => norm(d.phoneNumber) === norm(user.phoneNumber));
    } else {
      dealer = { phoneNumber: user.phoneNumber }; 
    }
    req.session.dealer = dealer;
    req.session.hasDealerPin = dealer ? !!dealer.pin : false;
  } else {
    req.session.dealer = null;
    req.session.hasDealerPin = false;
  }

  // ✅ Redirect to personal page (handled by routes/personal.js)
  res.redirect("/personal");
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
      mongoUser.password = hashed;
      await mongoUser.save();
      console.log("🛠️ Password reset in MongoDB for:", phoneNumber);
      return res.json({ success: true, message: "Password updated in MongoDB for " + phoneNumber });
    }
  } catch (dbErr) {
    console.error("❌ Database error during admin password reset:", dbErr.message);
  }

  // 2️⃣ If not in MongoDB, check in data.json (reset and JIT migrate to MongoDB)
  const users = readJSON(usersFile, []);
  const idx = users.findIndex(u => norm(u.phoneNumber) === norm(phoneNumber));

  if (idx !== -1) {
    const userToMigrate = users[idx];
    userToMigrate.password = hashed;

    try {
      await saveUserToMongoDB(userToMigrate);
      console.log(`🚚 Exported user ${phoneNumber} to MongoDB during password reset.`);

      // Remove from data.json (leave NO TRACE)
      users.splice(idx, 1);
      writeJSON(usersFile, users);
      console.log(`🗑️ Removed user ${phoneNumber} from data.json.`);

      return res.json({ success: true, message: "Password updated and account migrated to MongoDB for " + phoneNumber });
    } catch (migErr) {
      console.error("❌ Failed to migrate user during password reset:", migErr.message);
      // Fallback: update in data.json if MongoDB fails
      users[idx].password = hashed;
      writeJSON(usersFile, users);
      return res.json({ success: true, message: "Password updated in data.json (migration failed) for " + phoneNumber });
    }
  }

  return res.status(404).json({ error: "User not found" });
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
