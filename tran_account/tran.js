const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const tranAccountDir = path.join(__dirname, "tran_account");
const groupFile = path.join(tranAccountDir, "group.json");
const memberFile = path.join(tranAccountDir, "member.json");

const readJSON = (file, fallback = {}) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : fallback;
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const normPhone = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

const normStr = (s) => (s ? String(s).trim().toLowerCase() : "");

const loadGeneralData = () => {
  const generalPath = path.join(__dirname, "../general.json");
  return readJSON(generalPath, {});
};

/* ================= TRANSACTION ACCOUNT ROUTES ================= */

/* GET /tran - Transaction account dashboard */
router.get("/", (req, res) => {
  const groupData = readJSON(groupFile, { groupData: {} });
  const memberData = readJSON(memberFile, { group: {}, members: {} });

  res.render("tran/index", {
    groupData: groupData.groupData || {},
    memberData: memberData,
    user: req.session?.user || null,
  });
});

/* GET /tran/groups - List all transaction groups */
router.get("/groups", (req, res) => {
  const groupData = readJSON(groupFile, { groupData: {} });
  const groups = Object.values(groupData.groupData || {});
  res.json({ success: true, groups });
});

/* GET /tran/group/:groupName - Get specific group details */
router.get("/group/:groupName", (req, res) => {
  const { groupName } = req.params;
  const groupData = readJSON(groupFile, { groupData: {} });
  const memberData = readJSON(memberFile, { group: {}, members: {} });

  const groupKey = Object.keys(groupData.groupData || {}).find(key =>
    normStr(groupData.groupData[key].groupName) === normStr(groupName)
  );

  if (!groupKey) {
    return res.status(404).json({ success: false, message: "Group not found" });
  }

  const group = groupData.groupData[groupKey];

  // Find matching members
  let groupMembers = {};
  if (memberData.group && Object.keys(memberData.group).length > 0) {
    const matched = Object.values(memberData.group).find(g =>
      normStr(g.groupName) === normStr(groupName)
    );
    if (matched) {
      groupMembers = matched.members || {};
    }
  } else if (memberData.members) {
    groupMembers = memberData.members;
  }

  res.json({
    success: true,
    group,
    members: groupMembers,
    memberData: memberData,
  });
});

/* POST /tran/group/financials - Update group financials */
router.post("/group/financials", (req, res) => {
  const { groupName, financials } = req.body;

  if (!groupName || !financials) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const groupData = readJSON(groupFile, { groupData: {} });

  const groupKey = Object.keys(groupData.groupData || {}).find(key =>
    normStr(groupData.groupData[key].groupName) === normStr(groupName)
  );

  if (!groupKey) {
    return res.status(404).json({ success: false, message: "Group not found" });
  }

  // Update financials
  if (!groupData.groupData[groupKey].groupFinancials) {
    groupData.groupData[groupKey].groupFinancials = {};
  }

  groupData.groupData[groupKey].groupFinancials = {
    ...groupData.groupData[groupKey].groupFinancials,
    ...financials,
    updatedAt: new Date().toISOString(),
  };

  writeJSON(groupFile, groupData);

  res.json({
    success: true,
    message: "Financials updated successfully",
    group: groupData.groupData[groupKey],
  });
});

/* POST /tran/group/principles - Update group principles */
router.post("/group/principles", (req, res) => {
  const { groupName, principles } = req.body;

  if (!groupName || !principles) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const groupData = readJSON(groupFile, { groupData: {} });

  const groupKey = Object.keys(groupData.groupData || {}).find(key =>
    normStr(groupData.groupData[key].groupName) === normStr(groupName)
  );

  if (!groupKey) {
    return res.status(404).json({ success: false, message: "Group not found" });
  }

  groupData.groupData[groupKey].principles = {
    ...groupData.groupData[groupKey].principles,
    ...principles,
    updatedAt: new Date().toISOString(),
  };

  writeJSON(groupFile, groupData);

  res.json({
    success: true,
    message: "Principles updated successfully",
    group: groupData.groupData[groupKey],
  });
});

/* POST /tran/members/update - Update member data for a group */
router.post("/members/update", (req, res) => {
  const { groupName, members } = req.body;

  if (!groupName) {
    return res.status(400).json({ success: false, message: "Missing group name" });
  }

  const memberData = readJSON(memberFile, { group: {}, members: {} });

  // Check if using old structure (memberData.group) or flat structure (memberData.members)
  if (Object.keys(memberData.group || {}).length > 0) {
    // Old structure with group key
    const groupKey = Object.keys(memberData.group).find(key =>
      normStr(memberData.group[key].groupName) === normStr(groupName)
    );

    if (groupKey) {
      if (!memberData.group[groupKey].members) {
        memberData.group[groupKey].members = {};
      }
      Object.assign(memberData.group[groupKey].members, members);
    } else {
      return res.status(404).json({ success: false, message: "Group not found in member data" });
    }
  } else {
    // Flat structure
    if (!memberData.members) {
      memberData.members = {};
    }
    Object.assign(memberData.members, members);
  }

  writeJSON(memberFile, memberData);

  res.json({
    success: true,
    message: "Members updated successfully",
    memberData,
  });
});

/* GET /tran/sync/general - Sync transaction data from general.json */
router.get("/sync/general", (req, res) => {
  const generalData = loadGeneralData();
  const flatGroups = [];

  // Flatten general.json data
  for (const county in generalData) {
    if (county === "performance") continue;
    const constituencies = generalData[county];
    for (const constituency in constituencies) {
      const wardsOrGroups = constituencies[constituency];
      if (Array.isArray(wardsOrGroups)) {
        const wardName = typeof wardsOrGroups[0] === "string" ? wardsOrGroups[0] : "";
        wardsOrGroups.forEach((g) => {
          if (typeof g === "object" && g !== null && !Array.isArray(g)) {
            g.county = g.county || county;
            g.constituency = g.constituency || constituency;
            if (wardName) g.ward = g.ward || wardName;
            flatGroups.push(g);
          }
        });
      } else if (typeof wardsOrGroups === "object") {
        for (const ward in wardsOrGroups) {
          const groups = wardsOrGroups[ward];
          if (Array.isArray(groups)) {
            const wardName = typeof groups[0] === "string" ? groups[0] : ward;
            groups.forEach((g) => {
              if (typeof g === "object" && g !== null && !Array.isArray(g)) {
                g.county = g.county || county;
                g.constituency = g.constituency || constituency;
                g.ward = g.ward || wardName;
                flatGroups.push(g);
              }
            });
          }
        }
      }
    }
  }

  // Update group.json with synced data
  const groupData = readJSON(groupFile, { groupData: {} });
  flatGroups.forEach((group) => {
    if (group.groupName) {
      const groupKey = `group_${Object.keys(groupData.groupData || {}).length + 1}`;
      // Check if group already exists
      const existingKey = Object.keys(groupData.groupData || {}).find(key =>
        normStr(groupData.groupData[key].groupName) === normStr(group.groupName)
      );
      if (!existingKey) {
        groupData.groupData[groupKey] = {
          ...group,
          syncedAt: new Date().toISOString(),
        };
      }
    }
  });

  writeJSON(groupFile, groupData);

  res.json({
    success: true,
    message: `Synced ${flatGroups.length} groups from general.json`,
    syncedGroups: flatGroups.length,
  });
});

/* GET /tran/summary - Get transaction summary */
router.get("/summary", (req, res) => {
  const groupData = readJSON(groupFile, { groupData: {} });
  const memberData = readJSON(memberFile, { group: {}, members: {} });

  const groups = Object.values(groupData.groupData || {});
  const totalGroups = groups.length;

  let totalMembers = 0;
  let totalOpeningBalance = 0;
  let totalAmountIn = 0;
  let totalAmountOut = 0;
  let totalClosingBalance = 0;

  groups.forEach((group) => {
    if (group.groupFinancials) {
      totalOpeningBalance += parseFloat(group.groupFinancials.totalOpeningBalance) || 0;
      totalAmountIn += parseFloat(group.groupFinancials.totalAmountIn) || 0;
      totalAmountOut += parseFloat(group.groupFinancials.totalAmountOut) || 0;
      totalClosingBalance += parseFloat(group.groupFinancials.totalClosingBalance) || 0;
    }
  });

  if (Object.keys(memberData.group || {}).length > 0) {
    Object.values(memberData.group).forEach((g) => {
      totalMembers += Object.keys(g.members || {}).length;
    });
  } else if (memberData.members) {
    totalMembers = Object.keys(memberData.members).length;
  }

  res.json({
    success: true,
    summary: {
      totalGroups,
      totalMembers,
      totalOpeningBalance,
      totalAmountIn,
      totalAmountOut,
      totalClosingBalance,
    },
  });
});

module.exports = router;