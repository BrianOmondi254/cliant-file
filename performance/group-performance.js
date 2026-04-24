const fs = require('fs');
const path = require('path');

const perfFile = path.join(__dirname, 'group-performance.json');

const readJSON = (file, fallback = {}) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error parsing ${file}:`, e);
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const getKeys = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  
  const firstDayOfYear = new Date(year, 0, 1);
  const pastDaysOfYear = (now - firstDayOfYear) / 86400000;
  const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
  
  return {
    hourly: `${year}-${month}-${day}-${hour}`,
    weekly: `${year}-W${weekNum}`,
    monthly: `${year}-${month}`
  };
};

const initStats = () => ({
  phase1: 0, phase2: 0, phase3: 0, phase4: 0, phase5: 0, totalMembers: 0
});

const updateStatsObj = (stats, phase, delta = 1, membersDelta = 0) => {
  if (!stats) stats = initStats();
  const p = `phase${phase}`;
  if (stats.hasOwnProperty(p)) stats[p] += delta;
  stats.totalMembers = (stats.totalMembers || 0) + membersDelta;
  return stats;
};

/**
 * Incrementally log a single activity
 */
const logActivity = (county, constituency, ward, phase, isGraduation = false, oldPhase = null, totalProposedMembers = 0) => {
  const data = readJSON(perfFile, { counties: {}, global: { hourly: {}, weekly: {}, monthly: {}, totals: initStats() } });
  const keys = getKeys();

  const updateAllLevelStats = (target, p, d, md) => {
    target.totals = updateStatsObj(target.totals, p, d, md);
    ['hourly', 'weekly', 'monthly'].forEach(period => {
      if (!target[period]) target[period] = {};
      const key = keys[period];
      target[period][key] = updateStatsObj(target[period][key], p, d, md);
    });
  };

  const processUpdate = (p, d, md) => {
    updateAllLevelStats(data.global, p, d, md);
    if (!data.counties[county]) data.counties[county] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, constituencies: {} };
    updateAllLevelStats(data.counties[county], p, d, md);
    
    const co = data.counties[county];
    if (!co.constituencies[constituency]) co.constituencies[constituency] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, wards: {} };
    updateAllLevelStats(co.constituencies[constituency], p, d, md);
    
    const cn = co.constituencies[constituency];
    if (!cn.wards[ward]) cn.wards[ward] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {} };
    updateAllLevelStats(cn.wards[ward], p, d, md);
  };

  if (isGraduation && oldPhase) {
    // Audit-trail style: subtract 1 from old phase, add 1 to new phase
    // This keeps 'total' (the sum of counts) unchanged: (-1 + 1 = 0)
    processUpdate(oldPhase, -1, 0); 
    processUpdate(phase, 1, totalProposedMembers);
  } else {
    processUpdate(phase, 1, totalProposedMembers);
  }

  writeJSON(perfFile, data);
};

/**
 * Full sync: Recalculate all totals from the entire general.json
 */
const syncAll = (generalData) => {
    const data = readJSON(perfFile, { counties: {}, global: { hourly: {}, weekly: {}, monthly: {}, totals: initStats() } });
    
    // Reset totals only (preserve time-bracket history as it's not in general.json)
    data.global.totals = initStats();
    
    for (const county in generalData) {
        if (county === 'performance') continue;
        if (!data.counties[county]) data.counties[county] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, constituencies: {} };
        const co = data.counties[county];
        co.totals = initStats();

        for (const constituency in generalData[county]) {
            if (constituency === 'performance') continue;
            if (!co.constituencies[constituency]) co.constituencies[constituency] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, wards: {} };
            const cn = co.constituencies[constituency];
            cn.totals = initStats();

            const list = generalData[county][constituency];
            if (Array.isArray(list)) {
                let currentWardName = "Unknown";
                list.forEach(item => {
                    if (typeof item === 'string') {
                        currentWardName = item;
                        if (!cn.wards[currentWardName]) cn.wards[currentWardName] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {} };
                        cn.wards[currentWardName].totals = initStats();
                    } else if (typeof item === 'object' && item !== null && !item.isPerformance) {
                        const phase = parseInt(item.phase) || 1;
                        const members = parseInt(item.totalProposedMembers) || 0;
                        
                        // Update Ward Totals
                        updateStatsObj(cn.wards[currentWardName].totals, phase, 1, members);
                        // Update Constituency Totals
                        updateStatsObj(cn.totals, phase, 1, members);
                        // Update County Totals
                        updateStatsObj(co.totals, phase, 1, members);
                        // Update Global Totals
                        updateStatsObj(data.global.totals, phase, 1, members);
                    }
                });
            }
        }
    }
    
    writeJSON(perfFile, data);
    return data;
};

module.exports = {
  logActivity,
  syncAll,
  readPerformance: () => readJSON(perfFile)
};
