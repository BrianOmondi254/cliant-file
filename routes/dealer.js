const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const usersFile = path.join(__dirname, "../data.json");
const agentFile = path.join(__dirname, "../agent.json");

// GET dealer page
router.get("/", (req, res) => {
  res.render("dealer/dealer", { preview: null, error: null, success: null });
});

// POST preview agent
router.post("/preview", (req, res) => {
  const { phoneNumber } = req.body;

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "No users found",
      success: null,
    });
  }

  const users = JSON.parse(fs.readFileSync(usersFile, "utf8") || "[]");

  const user = users.find((u) => u.phoneNumber === phoneNumber);

  if (!user) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "Phone number not found",
      success: null,
    });
  }

  // Construct full name from available fields
  const nameParts = [
    user.FirstName?.trim(),
    user.MiddleName?.trim(),
    user.LastName?.trim(),
  ].filter(Boolean); // filter out undefined, null, empty strings

  const fullName = nameParts.join(" ") || "Name not provided";

  res.render("dealer/dealer", {
    preview: {
      name: fullName,
      county: user.county || "Not provided",
      constituency: user.constituency || "Not provided",
      ward: user.ward || "Not provided",
      phoneNumber: user.phoneNumber,
    },
    error: null,
    success: null,
  });
});

// POST create agent
router.post("/", (req, res) => {
  const { phoneNumber } = req.body;

  if (!fs.existsSync(usersFile)) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "No users found",
      success: null,
    });
  }

  const users = JSON.parse(fs.readFileSync(usersFile, "utf8") || "[]");

  const user = users.find((u) => u.phoneNumber === phoneNumber);

  if (!user) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "User not found",
      success: null,
    });
  }

  // Construct full name again
  const nameParts = [
    user.FirstName?.trim(),
    user.MiddleName?.trim(),
    user.LastName?.trim(),
  ].filter(Boolean);

  const fullName = nameParts.join(" ") || "Name not provided";

  let agents = [];
  if (fs.existsSync(agentFile)) {
    agents = JSON.parse(fs.readFileSync(agentFile, "utf8") || "[]");
  }

  // Prevent duplicate agent creation
  if (agents.find((a) => a.phoneNumber === phoneNumber)) {
    return res.render("dealer/dealer", {
      preview: null,
      error: "Agent already exists",
      success: null,
    });
  }

  agents.push({
    name: fullName,
    county: user.county || "",
    constituency: user.constituency || "",
    ward: user.ward || "",
    phoneNumber,
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(agentFile, JSON.stringify(agents, null, 2));

  res.render("dealer/dealer", {
    preview: null,
    error: null,
    success: "✅ Agent account created successfully",
  });
});

module.exports = router;
