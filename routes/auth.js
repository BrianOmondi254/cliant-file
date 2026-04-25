const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

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

  // Fallback to original behavior
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

  users.push(newUser);
  writeJSON(usersFile, users);

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
        phoneNumber: normPhone, // Save normalized phone or original? 
        // User saw "07..." in form, maybe save normalized to be safe.
        // Actually, let's save the original string if the user entered it, but 
        // the normalization logic above handles the comparison.
        // To be EXTREMELY consistent, let's save the normalized one.
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

    users.push(newUser);
    writeJSON(usersFile, users);

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
  res.render("login", { alert: null });
});

/* 🔑 Login (POST submission) */
router.post("/login", async (req, res) => {
  const users = readJSON(usersFile, []);
  let loginPhone = (req.body.phoneNumber || "").trim();
  const userIndex = users.findIndex(u => {
    return norm(u.phoneNumber) === norm(loginPhone);
  });

  if (userIndex === -1) {
    return res.render("register", {
      message: "Phone number not registered. Please create an account.",
      form: { phoneNumber: req.body.phoneNumber }
    });
  }

  const user = users[userIndex];
  const valid = await bcrypt.compare(req.body.password, user.password);
  if (!valid) return res.render("login", { alert: "Wrong password!" });

  // Update last login in data.json
  users[userIndex].lastLogin = new Date().toISOString();
  writeJSON(usersFile, users);

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

  req.session.isAgent = agents.some(a => norm(a.phoneNumber) === norm(user.phoneNumber));
  req.session.isDealer = dealers.some(d => norm(d.phoneNumber) === norm(user.phoneNumber));

  // If user is an agent, store the agent object and pin status in session
  if (req.session.isAgent) {
    const agent = agents.find(a => norm(a.phoneNumber) === norm(user.phoneNumber));
    req.session.agent = agent;
    req.session.hasAgentPin = agent ? (agent.pin && !(typeof agent.pin === 'object' && Object.keys(agent.pin).length === 0)) : false;
  } else {
    req.session.agent = null;
    req.session.hasAgentPin = false;
  }

  // If user is a dealer, store the dealer object and pin status in session
  if (req.session.isDealer) {
    const dealer = dealers.find(d => norm(d.phoneNumber) === norm(user.phoneNumber));
    req.session.dealer = dealer;
    req.session.hasDealerPin = dealer ? !!dealer.pin : false;
  } else {
    req.session.dealer = null;
    req.session.hasDealerPin = false;
  }

  // ✅ Redirect to personal page (handled by routes/personal.js)
  res.redirect("/personal");
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
