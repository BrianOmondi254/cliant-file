const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const tbankFile = path.join(__dirname, "../tbank.json");

router.get("/tbank-summary", (req, res) => {
  const data = fs.existsSync(tbankFile)
    ? JSON.parse(fs.readFileSync(tbankFile))
    : { totalRegistrations: 0, county: {} };

  res.json(data);
});

module.exports = router;   
