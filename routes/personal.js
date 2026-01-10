const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const groupsFile = path.join(__dirname, "../general.json");

/* 🔒 Auth middleware */
router.use((req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }
  next();
});

/* 👤 Personal dashboard */
router.get("/", (req, res) => {
  try {
    const phone = req.session.user && req.session.user.phoneNumber;

    const agentFile = path.join(__dirname, '../agent.json');
    const dealerFile = path.join(__dirname, '../dealer.json');
    const generalFile = path.join(__dirname, '../general.json');

    const readList = file => {
      if (!fs.existsSync(file)) return [];
      try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch (e) { return []; }
    };

    const agents = readList(agentFile);
    const dealers = readList(dealerFile);
    const generals = readList(generalFile);

    const phoneIn = (list) => {
      if (!phone) return false;
      if (Array.isArray(list)) {
        return list.some(item => {
          if (!item) return false;
          if (typeof item === 'string') return item === phone;
          if (item.phoneNumber) return item.phoneNumber === phone;
          if (item.phone) return item.phone === phone;
          return false;
        });
      }
      return false;
    };

    const showAgent = phoneIn(agents);
    const showDealer = phoneIn(dealers);
    const generalExists = phoneIn(generals);

    res.render('cliant', {
      user: req.session.user,
      showAgent,
      showDealer,
      generalExists
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error rendering the page");
  }
});

/* 📂 My Groups */
router.get("/myaccount", (req, res) => {
  res.render("myaccount", { user: req.session.user });
});

/* 👥 Create / Manage General Group */
router.get("/general", (req, res) => {
  const isCreation = req.query.mode === 'create';
  
  // We pass an empty groups array because if isCreation is true, the view won't use it.
  // If we wanted to support verification here too, we'd need to read the file, 
  // but the user wants to bypass verification for this flow.
  res.render("general", { 
    user: req.session.user,
    isCreation: isCreation,
    groups: [], 
    debugMsg: "" 
  });
});

/* 📝 Save General Group */
router.post("/general", (req, res) => {
  let groups = [];
  if (fs.existsSync(groupsFile)) {
    groups = JSON.parse(fs.readFileSync(groupsFile, "utf8"));
  }

  groups.push({
    ...req.body,
    processorPhone: req.session.user.phoneNumber,
    createdAt: new Date().toISOString()
  });

  fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 2));

  res.redirect("/personal/myaccount");
});

module.exports = router;
