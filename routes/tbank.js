const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const tbankFile = path.join(__dirname, "../tbank.json");
const { getTbankSettings, saveTbankSettings, ensureMongoReady } = require("../mongoose");

router.get("/tbank-summary", async (req, res) => {
  try {
    const ready = await ensureMongoReady();
    if (ready) {
      const data = await getTbankSettings();
      if (data) {
        return res.json(data);
      }
    }
    // Fallback to JSON file
    const data = fs.existsSync(tbankFile)
      ? JSON.parse(fs.readFileSync(tbankFile))
      : { totalRegistrations: 0, county: {} };
    res.json(data);
  } catch (e) {
    console.error('[tbank-summary] error:', e.message);
    res.status(500).json({ error: 'Failed to fetch tbank settings' });
  }
});

router.post("/tbank-settings", async (req, res) => {
  if (!req.body || !req.body.compliance) {
    return res.status(400).json({ success: false, message: "Invalid data" });
  }

  const saved = await saveTbankSettings(req.body);
  if (saved) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, message: "Failed to save" });
  }
});

module.exports = router;   
