const fs = require('fs');
const path = require('path');

const perfFile = path.join(__dirname, 'registration-performance.json');

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
  agents: 0,
  dealers: 0,
  members: {
    total: 0,
    gender: { male: 0, female: 0, unknown: 0 },
    ageBracket: { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56+': 0, 'unknown': 0 }
  },
  groups: 0
});

const updateStatsObj = (stats, type, delta = 1, gender = 'unknown', ageBracket = 'unknown') => {
  if (!stats) stats = initStats();

  // Backward compatibility: Convert member number to object
  if (typeof stats.members === 'number') {
    stats.members = {
      total: stats.members,
      gender: { male: 0, female: 0, unknown: stats.members },
      ageBracket: { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56+': 0, 'unknown': stats.members }
    };
  }

  if (type === 'members') {
    stats.members.total += delta;
    
    const g = gender ? gender.toLowerCase() : 'unknown';
    if (!stats.members.gender[g]) stats.members.gender[g] = 0;
    stats.members.gender[g] += delta;

    const a = ageBracket || 'unknown';
    if (!stats.members.ageBracket[a]) stats.members.ageBracket[a] = 0;
    stats.members.ageBracket[a] += delta;
  } else {
    if (stats.hasOwnProperty(type)) {
      stats[type] += delta;
    } else {
      stats[type] = delta;
    }
  }
  return stats;
};

/**
 * Incrementally log a single registration activity
 * type: 'agents', 'dealers', 'members', 'groups'
 */
const logRegistration = (county, constituency, ward, type, delta = 1, gender = 'unknown', ageBracket = 'unknown') => {
  const data = readJSON(perfFile, { counties: {}, global: { hourly: {}, weekly: {}, monthly: {}, totals: initStats() } });
  const keys = getKeys();

  const updateAllLevelStats = (target, t, d, g, a) => {
    target.totals = updateStatsObj(target.totals, t, d, g, a);
    ['hourly', 'weekly', 'monthly'].forEach(period => {
      if (!target[period]) target[period] = {};
      const key = keys[period];
      target[period][key] = updateStatsObj(target[period][key], t, d, g, a);
    });
  };

  const processUpdate = (t, d, g, a) => {
    updateAllLevelStats(data.global, t, d, g, a);
    
    if (!county) return; // Global only if no location provided
    
    if (!data.counties[county]) {
      data.counties[county] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, constituencies: {} };
    }
    updateAllLevelStats(data.counties[county], t, d, g, a);
    
    if (!constituency) return;
    const co = data.counties[county];
    if (!co.constituencies[constituency]) {
      co.constituencies[constituency] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, wards: {} };
    }
    updateAllLevelStats(co.constituencies[constituency], t, d, g, a);
    
    if (!ward) return;
    const cn = co.constituencies[constituency];
    if (!cn.wards[ward]) {
      cn.wards[ward] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {} };
    }
    updateAllLevelStats(cn.wards[ward], t, d, g, a);
  };

  processUpdate(type, delta, gender, ageBracket);
  writeJSON(perfFile, data);
};

/**
 * Full sync: Recalculate all totals from source files
 */
const syncAll = (agentsData, dealersData, generalData, membersData) => {
    const data = readJSON(perfFile, { counties: {}, global: { hourly: {}, weekly: {}, monthly: {}, totals: initStats() } });
    
    // Reset totals only
    const resetTotals = (obj) => {
        if (obj.totals) obj.totals = initStats();
        if (obj.counties) {
            for (const c in obj.counties) resetTotals(obj.counties[c]);
        }
        if (obj.constituencies) {
            for (const c in obj.constituencies) resetTotals(obj.constituencies[c]);
        }
        if (obj.wards) {
            for (const w in obj.wards) resetTotals(obj.wards[w]);
        }
    };

    // Helper to ensure path exists and return ward totals
    const getWardTotals = (county, constituency, ward) => {
        if (!data.counties[county]) data.counties[county] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, constituencies: {} };
        const co = data.counties[county];
        
        if (!co.constituencies[constituency]) co.constituencies[constituency] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {}, wards: {} };
        const cn = co.constituencies[constituency];
        
        if (!cn.wards[ward]) cn.wards[ward] = { totals: initStats(), hourly: {}, weekly: {}, monthly: {} };
        return {
            global: data.global.totals,
            county: co.totals,
            constituency: cn.totals,
            ward: cn.wards[ward].totals
        };
    };

    // Reset global totals
    data.global.totals = initStats();
    // We should probably clear all totals before resyncing
    data.counties = {};

    // Sync Agents
    if (Array.isArray(agentsData)) {
        agentsData.forEach(agent => {
            if (agent.county && agent.constituency && agent.ward) {
                const t = getWardTotals(agent.county, agent.constituency, agent.ward);
                [t.global, t.county, t.constituency, t.ward].forEach(stats => updateStatsObj(stats, 'agents', 1));
            }
        });
    }

    // Sync Dealers
    if (Array.isArray(dealersData)) {
        dealersData.forEach(dealer => {
            if (dealer.county && dealer.constituency && dealer.ward) {
                const t = getWardTotals(dealer.county, dealer.constituency, dealer.ward);
                [t.global, t.county, t.constituency, t.ward].forEach(stats => updateStatsObj(stats, 'dealers', 1));
            }
        });
    }

    // Sync Groups and possibly aggregate members from groups
    if (generalData) {
        for (const county in generalData) {
            for (const constituency in generalData[county]) {
                const list = generalData[county][constituency];
                if (Array.isArray(list)) {
                    let currentWard = "Unknown";
                    list.forEach(item => {
                        if (typeof item === 'string') {
                            currentWard = item;
                        } else if (typeof item === 'object' && item !== null) {
                            const t = getWardTotals(county, constituency, currentWard);
                            [t.global, t.county, t.constituency, t.ward].forEach(stats => updateStatsObj(stats, 'groups', 1));
                            
                            // If group has members, count them? 
                            // Actually member.json might be better for individual members
                        }
                    });
                }
            }
        }
    }

    // Sync Members from member.json if provided
    if (membersData && membersData.group) {
        // Members are organized by group ID. We need location info for them.
        // This is tricky because member.json doesn't have location directly, 
        // but we can infer it from general.json mapping if needed.
        // For now, let's assume we mainly track groups/agents/dealers here 
        // or aggregate members from general.json totalProposedMembers if member.json is too complex to map back.
    }

    writeJSON(perfFile, data);
    return data;
};

/**
 * Migration Utility: Converts legacy integer fields (e.g. members: X) 
 * into detailed demographic objects across the entire JSON tree.
 */
const migrateDataFormat = () => {
    const data = readJSON(perfFile, { counties: {}, global: { hourly: {}, weekly: {}, monthly: {}, totals: initStats() } });

    const updateMembers = (obj) => {
        if (!obj) return;
        if (typeof obj.members === 'number') {
            obj.members = {
                total: obj.members,
                gender: { male: 0, female: 0, unknown: obj.members },
                ageBracket: { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56+': 0, unknown: obj.members }
            };
        }
        
        // Traverse hourly, weekly, monthly
        ['hourly', 'weekly', 'monthly'].forEach(period => {
            if (obj[period]) {
                for (const key in obj[period]) {
                    updateMembers(obj[period][key]);
                }
            }
        });
    };

    if (data.global) {
        updateMembers(data.global.totals);
        updateMembers(data.global);
    }

    if (data.counties) {
        for (const c in data.counties) {
            const county = data.counties[c];
            updateMembers(county.totals);
            updateMembers(county);

            if (county.constituencies) {
                for (const cn in county.constituencies) {
                    const constituency = county.constituencies[cn];
                    updateMembers(constituency.totals);
                    updateMembers(constituency);

                    if (constituency.wards) {
                        for (const w in constituency.wards) {
                            const ward = constituency.wards[w];
                            updateMembers(ward.totals);
                            updateMembers(ward);
                        }
                    }
                }
            }
        }
    }

    writeJSON(perfFile, data);
    return data;
};

module.exports = {
  logRegistration,
  syncAll,
  migrateDataFormat,
  readPerformance: () => readJSON(perfFile)
};
