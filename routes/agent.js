const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const agentFile = path.join(__dirname, "../agent.json");
const generalFile = path.join(__dirname, "../general.json");

/* ================= HELPERS ================= */

const loadJSON = (file) => {
  try {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, "utf8").trim();
    return data ? JSON.parse(data) : [];
  } catch (err) {
    console.error("JSON read error:", err);
    return [];
  }
};

/* ================= AUTH MIDDLEWARE ================= */

router.use((req, res, next) => {
  // must be logged in via auth.js
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  next();
});

/* ================= GET /agent ================= */

router.get("/", (req, res) => {
  const phoneNumber = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile);

  const agent = agents.find(a => a.phoneNumber === phoneNumber);

  // ❌ Not an agent
  if (!agent) {
    return res.render("agent/agent", {
      step: "not-agent",
      message: { type: "error", text: "Your account is not registered as an agent." }
    });
  }

  // ✅ Agent exists, no PIN yet
  if (!agent.pin) {
    return res.render("agent/agent", {
      step: "create-pin",
      agentName: agent.name,
      message: null
    });
  }

  // ✅ Agent exists, PIN required
  return res.render("agent/agent", {
    step: "enter-pin",
    message: null
  });
});

/* ================= CREATE PIN ================= */

router.post("/set-pin", async (req, res) => {
  const { pin, confirmPin } = req.body;
  const phoneNumber = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile);

  if (pin !== confirmPin) {
    return res.render("agent/agent", {
      step: "create-pin",
      agentName: req.session.user.name,
      message: { type: "error", text: "PINs do not match." }
    });
  }

  const agent = agents.find(a => a.phoneNumber === phoneNumber);
  if (!agent) {
    return res.redirect("/agent");
  }

  agent.pin = await bcrypt.hash(pin, 10);
  fs.writeFileSync(agentFile, JSON.stringify(agents, null, 2));

  return res.render("agent/agent", {
    step: "enter-pin",
    message: { type: "success", text: "PIN created successfully. Please login." }
  });
});

/* ================= VERIFY PIN ================= */

router.post("/login", async (req, res) => {
  const { pin } = req.body;
  const phoneNumber = req.session.user.phoneNumber;

  const agents = loadJSON(agentFile);
  const agent = agents.find(a => a.phoneNumber === phoneNumber);

  if (!agent || !agent.pin) {
    return res.redirect("/agent");
  }

  const valid = await bcrypt.compare(pin, agent.pin);
  if (!valid) {
    return res.render("agent/agent", {
      step: "enter-pin",
      message: { type: "error", text: "Incorrect PIN." }
    });
  }

  // mark agent verified
  req.session.agentVerified = true;

  const groups = loadJSON(generalFile).map(g => g.groupName);

  return res.render("agent/agent", {
    step: "dashboard",
    groups,
    message: { type: "success", text: "Agent login successful." }
  });
});

/* ================= PROTECT DASHBOARD (OPTIONAL FUTURE ROUTES) ================= */

router.use((req, res, next) => {
  if (!req.session.agentVerified) {
    return res.redirect("/agent");
  }
  next();
});

module.exports = router;
