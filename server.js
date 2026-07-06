require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const {
  connectDB,
  Dealer,
  Agent,
  Admin,
  SuperAdmin,
  Message,
  normalizePhone,
  deletePendingOfficerMessage,
} = require("./mongoose");

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
const businessAccountRoutes = require("./p_account/business.js");

/* ================= HQ ROUTES ================= */
const hqAccountRoutes = require("./route-hq/account");
const hqAdminRoutes = require("./route-hq/admin");
const hqSuperAdminRoutes = require("./route-hq/superadmin");
const hqOperationsRoutes = require("./route-hq/operations");
const complianceRoutes = require("./route-hq/compliance");

/* ================= APP INIT ================= */
const app = express();
const PORT = process.env.PORT || 3000;

/* ================= STATIC FILES FOR MOBILE ================= */
app.use(express.static(path.join(__dirname, "public"), { index: false }));

/* ================= PWA HEADERS ================= */
// Service Worker caching
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.set("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

// Manifest caching
app.get("/manifest.json", (req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.set("Content-Type", "application/json");
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

/* ================= LOCALS ================= */
// app.locals.locationsData = locationsData; // Commented out to prevent injection into view locals
app.locals.pendingAdminPasskeys = new Map();

/* ================= GLOBAL MIDDLEWARE ================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* 🛡️ Disable Caching to ensure Logout prevents 'Back' button access */
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  // Block direct access to any URL containing '.ejs'
  if (req.url.toLowerCase().includes(".ejs")) {
    console.warn(
      `🛡️ Blocked direct access attempt to EJS template: ${req.url}`,
    );
    return res
      .status(403)
      .send(
        "<h1>403 Forbidden</h1><p>Direct access to templates is strictly prohibited.</p>",
      );
  }

  // Expose session to all templates
  res.locals.session = req.session;
  next();
});

/* 🛡️ Session middleware (required for login-protected routes) */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "generalAccountSecret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  }),
);

/* ================= VIEW ENGINE ================= */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ================= ROUTE MOUNTING ================= */

// 1️⃣ Public HQ routes (must be before generic :section route to avoid conflicts)
app.use("/hq/admin", hqAdminRoutes);
app.use("/hq/superadmin", hqSuperAdminRoutes);
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

// Inbox message delete
app.post("/api/inbox/delete", (req, res) => {
  const { id, index } = req.body;
  if (!req.session.user) return res.json({ success: false });
  if (!req.session.user.inbox) return res.json({ success: true });
  if (id) {
    req.session.user.inbox = req.session.user.inbox.filter((m) => m.id !== id);
  } else if (
    typeof index === "number" &&
    index >= 0 &&
    index < req.session.user.inbox.length
  ) {
    req.session.user.inbox.splice(index, 1);
  }
  req.session.save((err) => {
    if (err) {
      console.error("Session save error on inbox delete:", err);
      return res.json({ success: false });
    }
    res.json({ success: true });
  });
});

// Delete Pending Officer Message
app.post("/api/officer-message/delete", async (req, res) => {
  if (!req.session.user) return res.json({ success: false });
  try {
    const phone = req.session.user.phoneNumber;
    await deletePendingOfficerMessage(phone);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting pending officer message:", err);
    res.json({ success: false });
  }
});

// Accept Dealer Invitation
app.post("/api/accept-dealer-invite", async (req, res) => {
  try {
    if (!req.session.user) {
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated." });
    }

    const { msgId } = req.body;
    if (!msgId) {
      return res
        .status(400)
        .json({ success: false, message: "Message ID is required." });
    }

    // Lookup the message by ID
    const msg = await Message.findById(msgId);
    if (!msg) {
      return res
        .status(404)
        .json({ success: false, message: "Invitation not found." });
    }

    // Verify the message belongs to the current user
    const userPhone = req.session.user.phoneNumber;
    if (normalizePhone(msg.to) !== normalizePhone(userPhone)) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied." });
    }

    // Verify it's a dealer invitation
    if (msg.type !== "dealer_invitation") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid invitation type." });
    }

    if (!msg.meta) {
      return res
        .status(400)
        .json({ success: false, message: "Invitation payload missing." });
    }

    const payload = msg.meta;
    const normDealerPhone = normalizePhone(payload.phoneNumber);

    // Additional safety: ensure not already registered as agent/admin/superadmin
    const existingAgent = await Agent.findOne({ phoneNumber: normDealerPhone });
    if (existingAgent) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Phone number is registered as an Agent.",
        });
    }
    const existingAdmin = await Admin.findOne({ phoneNumber: normDealerPhone });
    const existingSuperAdmin = await SuperAdmin.findOne({
      $or: [
        { phoneNumber: payload.phoneNumber },
        { phoneNumber: normDealerPhone },
      ],
    });
    if (existingAdmin || existingSuperAdmin) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Phone number is registered as an Admin or SuperAdmin.",
        });
    }

    // Upsert the dealer
    const existingDealer = await Dealer.findOne({
      phoneNumber: normDealerPhone,
    });
    if (existingDealer) {
      // Update existing
      await Dealer.updateOne(
        { phoneNumber: normDealerPhone },
        {
          $set: {
            hqPhone: payload.hqPhone,
            county: payload.county,
            constituency: payload.constituency,
            ward: payload.ward,
            name: payload.name,
            isBlocked: payload.isBlocked || false,
            updatedAt: new Date(),
          },
        },
      );
    } else {
      // Create new
      await Dealer.create({
        phoneNumber: normDealerPhone,
        hqPhone: payload.hqPhone,
        county: payload.county,
        constituency: payload.constituency,
        ward: payload.ward,
        name: payload.name,
        createdAt: new Date(),
        isBlocked: payload.isBlocked || false,
        stats: payload.stats || {
          agent_creation: 0,
          personal_account_creation: 0,
          dealer_creation: 0,
        },
      });
    }

    // Update the message status to accepted
    await Message.findByIdAndUpdate(msgId, { status: "accepted" });

    res.json({
      success: true,
      message: "Dealer appointment accepted successfully.",
    });
  } catch (err) {
    console.error("Accept Dealer Invite Error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error processing invitation." });
  }
});

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
app.use("/b_account", protect, businessAccountRoutes);

// 4️⃣ Default root redirect → login page or mobile app
app.get("/compliance", (req, res) => res.redirect("/hq/compliance"));

// Check if request is from Capacitor (mobile app)
const isCapacitor = (req) => {
  return (
    req.get("x-capacitor") === "true" ||
    req.get("user-agent")?.includes("Capacitor")
  );
};

app.get("/", (req, res) => {
  // Serve mobile index for Capacitor app
  if (isCapacitor(req)) {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  // Redirect to login for browser users
  res.redirect("/login");
});

/* ================= START SERVER ================= */
const isProduction =
  process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

connectDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      const base =
        process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      console.log(`✅ Server running at ${base}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    if (isProduction) {
      console.error(
        "Deploy fix: In Render Dashboard → Environment, set MONGODB_URI to your Atlas connection string. In Atlas → Network Access, allow 0.0.0.0/0.",
      );
      process.exit(1);
    }
    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `✅ Server running at http://localhost:${PORT} (MongoDB connection failed — local only)`,
      );
    });
  });
