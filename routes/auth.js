const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const router = express.Router();
const usersFile = path.join(__dirname, "../data.json");

/* ================= HELPERS ================= */
const readJSON = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  const data = fs.readFileSync(file, "utf8");
  return data ? JSON.parse(data) : fallback;
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
  } = req.body;
  const users = readJSON(usersFile, []);

  if (!phoneNumber || !password) {
    return res.render("register", {
      message: "Phone number and password are required!",
      form: {}
    });
  }

  if (users.find(u => u.phoneNumber === phoneNumber)) {
    return res.render("register", {
      message: "Phone already registered!",
      form: { phoneNumber }
    });
  }

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

  res.render("login", { alert: "Registration successful. Login now." });
});

/* 🔑 Login (GET form) */
router.get("/login", (req, res) => {
  res.render("login", { alert: null });
});

/* 🔑 Login (POST submission) */
router.post("/login", async (req, res) => {
  const users = readJSON(usersFile, []);
  const user = users.find(u => u.phoneNumber === req.body.phoneNumber);

  if (!user) {
    return res.render("register", {
      message: "Phone number not registered. Please create an account.",
      form: { phoneNumber: req.body.phoneNumber }
    });
  }

  const valid = await bcrypt.compare(req.body.password, user.password);
  if (!valid) return res.render("login", { alert: "Wrong password!" });

  // ✅ Save session user
  req.session.user = { phoneNumber: user.phoneNumber };

  // ✅ Redirect to personal page (handled by routes/personal.js)
  res.redirect("/personal");
});

/* 🚪 Logout */
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;