const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const pAccountDir = path.join(__dirname, "p_account");
const personalFile = path.join(pAccountDir, "personal.json");

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

/* ================= PERSONAL ACCOUNT ROUTES ================= */

/* GET /p_account - Personal account dashboard */
router.get("/", (req, res) => {
  const personalData = readJSON(personalFile, { personalAccounts: {} });
  res.json({
    success: true,
    data: personalData,
    user: req.session?.user || null,
  });
});

/* GET /p_account/accounts - List all personal accounts */
router.get("/accounts", (req, res) => {
  const personalData = readJSON(personalFile, { personalAccounts: {} });
  const accounts = Object.values(personalData.personalAccounts || {});
  res.json({ success: true, accounts });
});

/* GET /p_account/account/:phone - Get specific personal account */
router.get("/account/:phone", (req, res) => {
  const { phone } = req.params;
  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  res.json({
    success: true,
    account: personalData.personalAccounts[accountKey],
  });
});

/* POST /p_account/account/create - Create personal account */
router.post("/account/create", (req, res) => {
  const { phone, name, accounts } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, message: "Phone and name are required" });
  }

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = `acct_${Object.keys(personalData.personalAccounts || {}).length + 1}`;
  
  personalData.personalAccounts[accountKey] = {
    phone,
    name,
    accounts: accounts || {},
    accountTypes: {
      "001": { accountId: "001", accountName: "Savings", expectedAmount: "100" },
      "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
      "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
      "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
    },
    financials: {
      openingBalance: 0,
      amountIn: 0,
      amountOut: 0,
      closingBalance: 0
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Personal account created successfully",
    account: personalData.personalAccounts[accountKey],
  });
});

/* POST /p_account/account/:phone/financials - Update financials */
router.post("/account/:phone/financials", (req, res) => {
  const { phone } = req.params;
  const { financials } = req.body;

  if (!financials) {
    return res.status(400).json({ success: false, message: "Financials data required" });
  }

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  if (!personalData.personalAccounts[accountKey].financials) {
    personalData.personalAccounts[accountKey].financials = {};
  }

  personalData.personalAccounts[accountKey].financials = {
    ...personalData.personalAccounts[accountKey].financials,
    ...financials,
    updatedAt: new Date().toISOString()
  };

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Financials updated successfully",
    account: personalData.personalAccounts[accountKey],
  });
});

/* POST /p_account/account/:phone/accounts/update - Update account details */
router.post("/account/:phone/accounts/update", (req, res) => {
  const { phone } = req.params;
  const { accounts } = req.body;

  if (!accounts) {
    return res.status(400).json({ success: false, message: "Accounts data required" });
  }

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(400).json({ success: false, message: "Account not found" });
  }

  personalData.personalAccounts[accountKey].accounts = {
    ...personalData.personalAccounts[accountKey].accounts,
    ...accounts,
    updatedAt: new Date().toISOString()
  };

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Account details updated successfully",
    account: personalData.personalAccounts[accountKey],
  });
});

/* DELETE /p_account/account/:phone - Delete personal account */
router.delete("/account/:phone", (req, res) => {
  const { phone } = req.params;

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  delete personalData.personalAccounts[accountKey];

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Account deleted successfully",
  });
});

/* GET /p_account/summary - Get summary of all personal accounts */
router.get("/summary", (req, res) => {
  const personalData = readJSON(personalFile, { personalAccounts: {} });
  const accounts = Object.values(personalData.personalAccounts || {});

  const totalAccounts = accounts.length;
  let totalOpeningBalance = 0;
  let totalAmountIn = 0;
  let totalAmountOut = 0;
  let totalClosingBalance = 0;

  accounts.forEach(account => {
    if (account.financials) {
      totalOpeningBalance += parseFloat(account.financials.openingBalance) || 0;
      totalAmountIn += parseFloat(account.financials.amountIn) || 0;
      totalAmountOut += parseFloat(account.financials.amountOut) || 0;
      totalClosingBalance += parseFloat(account.financials.closingBalance) || 0;
    }
  });

  res.json({
    success: true,
    summary: {
      totalAccounts,
      totalOpeningBalance,
      totalAmountIn,
      totalAmountOut,
      totalClosingBalance,
    },
  });
});

/* POST /p_account/sync/general - Sync personal data from general.json */
router.post("/sync/general", (req, res) => {
  const generalPath = path.join(__dirname, "../general.json");
  const generalData = readJSON(generalPath, {});
  const personalData = readJSON(personalFile, { personalAccounts: {} });

  let syncedCount = 0;

  // Flatten general.json data and extract member info
  for (const county in generalData) {
    if (county === "performance") continue;
    const constituencies = generalData[county];
    for (const constituency in constituencies) {
      const wardsOrGroups = constituencies[constituency];
      if (Array.isArray(wardsOrGroups)) {
        const wardName = typeof wardsOrGroups[0] === "string" ? wardsOrGroups[0] : "";
        wardsOrGroups.forEach((g) => {
          if (typeof g === "object" && g !== null && !Array.isArray(g)) {
            // Extract member info
            for (const key in g) {
              if (key.startsWith("trustee_") || key.startsWith("official_") || key.startsWith("member_")) {
                const member = g[key];
                if (member && member.phone) {
                  const accountKey = `acct_${Object.keys(personalData.personalAccounts || {}).length + 1}`;
                  if (!Object.values(personalData.personalAccounts || {}).some(acc => normPhone(acc.phone) === normPhone(member.phone))) {
                    personalData.personalAccounts[accountKey] = {
                      phone: member.phone,
                      name: member.name || `${member.firstName || ''} ${member.lastName || ''}`.trim() || "Unknown",
                      groupName: g.groupName,
                      county: g.county || county,
                      constituency: g.constituency || constituency,
                      ward: g.ward || wardName,
                      role: member.type || "member",
                      accounts: {},
                      accountTypes: {
                        "001": { accountId: "001", accountName: "Savings", expectedAmount: "100" },
                        "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
                        "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
                        "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
                      },
                      financials: {
                        openingBalance: 0,
                        amountIn: 0,
                        amountOut: 0,
                        closingBalance: 0
                      },
                      synced: true,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString()
                    };
                    syncedCount++;
                  }
                }
              }
            }
          }
        });
      }
    }
  }

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: `Synced ${syncedCount} personal accounts from general.json`,
    synced: syncedCount,
  });
});

module.exports = router;