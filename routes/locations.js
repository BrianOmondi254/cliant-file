const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const locationsFile = path.join(__dirname, '..', 'locations.json');

const readLocations = () => {
  if (!fs.existsSync(locationsFile)) return {};
  try { return JSON.parse(fs.readFileSync(locationsFile, 'utf8')) || {}; } catch (e) { return {}; }
};

// GET /api/locations/counties
router.get('/counties', (req, res) => {
  const data = readLocations();
  return res.json(Object.keys(data).sort());
});

// GET /api/locations/constituencies?county=Nairobi
router.get('/constituencies', (req, res) => {
  const data = readLocations();
  const county = req.query.county;
  if (!county || !data[county]) return res.status(404).json({ error: 'County not found' });
  return res.json(Object.keys(data[county]).sort());
});

// GET /api/locations/wards?county=Nairobi&constituency=Westlands
router.get('/wards', (req, res) => {
  const data = readLocations();
  const { county, constituency } = req.query;
  if (!county || !constituency || !data[county] || !data[county][constituency]) {
    return res.status(404).json({ error: 'Not found' });
  }
  const entry = data[county][constituency];
  if (Array.isArray(entry)) return res.json(entry.sort());
  if (entry && Array.isArray(entry.wards)) return res.json(entry.wards.sort());
  return res.json([]);
});

// Legacy path-based routes (kept for backward compatibility)
// GET /api/locations/:county/constituencies
router.get('/:county/constituencies', (req, res) => {
  const data = readLocations();
  const county = req.params.county;
  if (!data[county]) return res.status(404).json({ error: 'County not found' });
  return res.json(Object.keys(data[county]).sort());
});

// GET /api/locations/:county/:constituency/wards  (broken for names with '/' — use query route above)
router.get('/:county/:constituency/wards', (req, res) => {
  const data = readLocations();
  const county = req.params.county;
  const constituency = req.params.constituency;
  if (!data[county] || !data[county][constituency]) return res.status(404).json({ error: 'Not found' });
  const entry = data[county][constituency];
  if (Array.isArray(entry)) return res.json(entry.sort());
  if (entry && Array.isArray(entry.wards)) return res.json(entry.wards.sort());
  return res.json([]);
});


module.exports = router;
