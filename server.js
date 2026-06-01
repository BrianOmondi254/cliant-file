require('dotenv').config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { connectDB } = require("./mongoose");

/* ================= ROUTE IMPORTS ================= */
const authRoutes = require("./routes/auth");
const personalRoutes = require("./routes/personal");
const tbankRoutes = require("./routes/tbank");
const agentRoutes = require("./routes/agent");
const dealerRoutes = require("./routes/dealer");
const generalRoutes = require("./routes/general");
const proceedingsRoutes = require("./routes/proceedings");
const locationsRoutes = require("./routes/locations");
const mpesaRoutes = require("./routes/mpesa");
const memberRoutes = require("./routes/member");
const tranRoutes = require("./tran_account/tran");
const personalAccountRoutes = require("./p_account/personal.js");




/* ================= HQ ROUTES ================= */
const hqAccountRoutes = require("./route-hq/account"); 
const hqOperationsRoutes = require("./route-hq/operations"); 
const complianceRoutes = require("./route-hq/compliance");


/* ================= APP INIT ================= */
const app = express();
const PORT = process.env.PORT || 3000;

/* ================= STATIC FILES FOR MOBILE ================= */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ================= PWA HEADERS ================= */
// Service Worker caching
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Manifest caching
app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

/* ================= LOCALS ================= */
// app.locals.locationsData = locationsData; // Commented out to prevent injection into view locals


/* ================= GLOBAL MIDDLEWARE ================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* 🛡️ Disable Caching to ensure Logout prevents 'Back' button access */
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  
  // Block direct access to any URL containing '.ejs'
  if (req.url.toLowerCase().includes('.ejs')) {
    console.warn(`🛡️ Blocked direct access attempt to EJS template: ${req.url}`);
    return res.status(403).send('<h1>403 Forbidden</h1><p>Direct access to templates is strictly prohibited.</p>');
  }

  // Expose session to all templates
  res.locals.session = req.session;
  next();
});

/* 🛡️ Session middleware (required for login-protected routes) */
app.use(
  session({
    store: new FileStore({ path: "./sessions", ttl: 86400 }),
    secret: "generalAccountSecret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Session expires after 24 hours
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
app.use("/member", memberRoutes);
app.use("/api/locations", locationsRoutes);
app.use("/api/mpesa", mpesaRoutes);

// 3️⃣ Protected routes (require login)
const protect = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  next();
};

// ✅ Adjustment: personalRoutes must define router.get("/") so this mount works at /personal
app.use("/personal", protect, personalRoutes);
app.use("/agent", protect, agentRoutes);

app.use("/dealer", protect, dealerRoutes);
app.use("/proceedings", protect, proceedingsRoutes);
app.use("/tran", protect, tranRoutes);
app.use("/p_account", protect, personalAccountRoutes);

// 4️⃣ Default root redirect → login page or mobile app
app.get("/compliance", (req, res) => res.redirect("/hq/compliance"));

// Check if request is from Capacitor (mobile app)
const isCapacitor = (req) => {
  return req.get('x-capacitor') === 'true' || 
         req.get('user-agent')?.includes('Capacitor');
};

app.get("/", (req, res) => {
  // Serve mobile index for Capacitor app
  if (isCapacitor(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  // Redirect to login for browser users
  res.redirect("/login");
});

/* ================= START SERVER ================= */
// Connect to MongoDB before starting server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Failed to connect to MongoDB:", err);
  // Still start server even if MongoDB fails
  app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT} (MongoDB connection failed)`);
  });
});