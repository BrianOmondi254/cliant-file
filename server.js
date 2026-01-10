const express = require("express");
const path = require("path");
const session = require("express-session");

/* ================= ROUTE IMPORTS ================= */
const authRoutes = require("./routes/auth");
const personalRoutes = require("./routes/personal");
const tbankRoutes = require("./routes/tbank");
const agentRoutes = require("./routes/agent");
const dealerRoutes = require("./routes/dealer");
const generalRoutes = require("./routes/general");
const locationsRoutes = require("./routes/locations");



/* ================= HQ ROUTES ================= */
const hqAccountRoutes = require("./route-hq/account"); 
const hqOperationsRoutes = require("./route-hq/operations"); 
const complianceRoutes = require("./route-hq/compliance");


/* ================= APP INIT ================= */
const app = express();
const PORT = 3000;

/* ================= LOCALS ================= */
// app.locals.locationsData = locationsData; // Commented out to prevent injection into view locals


/* ================= GLOBAL MIDDLEWARE ================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* 🛡️ Session middleware (required for login-protected routes) */
app.use(
  session({
    secret: "generalAccountSecret",
    resave: false,
    saveUninitialized: false
  })
);

/* ================= VIEW ENGINE ================= */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ================= ROUTE MOUNTING ================= */

// 1️⃣ Public HQ route (accessible without login)
app.use("/hq", complianceRoutes);
app.use("/hq", hqAccountRoutes);
app.use("/hq", hqOperationsRoutes);


// 2️⃣ Public routes (auth + tbank + general)
app.use("/", authRoutes);
app.use("/", tbankRoutes);
app.use("/general", generalRoutes);
app.use("/api/locations", locationsRoutes);

// 3️⃣ Protected routes (require login)
const protect = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  next();
};

// ✅ Adjustment: personalRoutes must define router.get("/") so this mount works at /personal
app.use("/personal", protect, personalRoutes);
app.use("/agent", protect, agentRoutes);
app.use("/dealer", protect, dealerRoutes);

// 4️⃣ Default root redirect → login page
app.get("/compliance", (req, res) => res.redirect("/hq/compliance"));
app.get("/", (req, res) => res.redirect("/login"));

/* ================= START SERVER ================= */
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});