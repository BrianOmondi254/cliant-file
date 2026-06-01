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

/* POST /p_account/account/:phone/financials - Create a transaction record from financial data */
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

  const account = personalData.personalAccounts[accountKey];

  // Build a transaction record with flat structure
  const txnType = parseFloat(financials.amountIn || 0) > 0 ? "received" : "sent";
  const amount = Math.abs(parseFloat(financials.amountIn || financials.amountOut || 0)) || 0;
  const existingTxns = account.transactions || [];
  const openingBalance = existingTxns.reduce((sum, t) => {
    return sum + (parseFloat(t.amount) || 0) * (t.type === "received" ? 1 : -1);
  }, 0);
  const closingBalance = openingBalance + (txnType === "received" ? amount : -amount);
  const transaction = {
    cord: "txn_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
    reference: financials.reference || ("REF-" + Date.now()),
    time: financials.date ? new Date(financials.date).toISOString() : new Date().toISOString(),
    openingBalance,
    amount,
    type: txnType,
    from: {
      name: financials.proceedAccountName || (txnType === "received" ? "External" : "Self"),
      number: financials.proceedAccountNumber || phone
    },
    to: {
      name: txnType === "received" ? "Self" : "External",
      number: phone
    },
    closingBalance,
    environment: financials.environment || "unknown",
    notes: financials.notes || null
  };

  if (!account.transactions) {
    account.transactions = [];
  }
  account.transactions.unshift(transaction);
  account.updatedAt = new Date().toISOString();

  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Financial recorded as transaction successfully",
    transaction,
    account: { accountKey, phone }
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

/* ================= TRANSACTION SHEET ROUTES ================= */

/* GET /p_account/account/:phone/transactions - Get transaction history for an account */
router.get("/account/:phone/transactions", (req, res) => {
  const { phone } = req.params;
  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  const account = personalData.personalAccounts[accountKey];
  const transactions = account.transactions || [];

  res.json({
    success: true,
    accountKey,
    phone,
    transactions,
    count: transactions.length,
  });
});

/* POST /p_account/account/:phone/transaction - Record a new transaction */
router.post("/account/:phone/transaction", (req, res) => {
  const { phone } = req.params;
  const {
    accountType,
    amount,
    transactionType, // "received" or "sent"
    proceedAccountName,
    proceedAccountNumber,
    environment,
    reference,
    notes,
    date
  } = req.body;

  if (!phone || !accountType || !amount || !transactionType) {
    return res.status(400).json({
      success: false,
      message: "Phone, accountType, amount, and transactionType are required"
    });
  }

  if (transactionType !== "received" && transactionType !== "sent") {
    return res.status(400).json({
      success: false,
      message: "transactionType must be 'received' or 'sent'"
    });
  }

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  const account = personalData.personalAccounts[accountKey];

  // Validate account type exists
  const validAccountTypes = Object.keys(account.accountTypes || {});
  if (!validAccountTypes.includes(accountType)) {
    return res.status(400).json({
      success: false,
      message: `Invalid account type. Valid types: ${validAccountTypes.join(", ")}`
    });
  }

  // Initialize transactions array if missing
  if (!account.transactions) {
    account.transactions = [];
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Amount must be a positive number"
    });
  }

  // Calculate opening balance from existing transactions
  const existingTxns = account.transactions || [];
  const runningBalance = existingTxns.reduce((sum, t) => {
    return sum + (parseFloat(t.amount) || 0) * (t.transactionType === "received" ? 1 : -1);
  }, 0);
  const openingBalance = runningBalance;
  const closingBalance = openingBalance + (transactionType === "received" ? parsedAmount : -parsedAmount);

  // Build transaction record with flat structure
  const transaction = {
    cord: "txn_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
    reference: reference || ("REF-" + Date.now()),
    time: date ? new Date(date).toISOString() : new Date().toISOString(),
    openingBalance,
    amount: parsedAmount,
    type: transactionType,
    from: {
      name: proceedAccountName || (transactionType === "received" ? "External" : "Self"),
      number: proceedAccountNumber || phone
    },
    to: {
      name: (transactionType === "received" ? "Self" : "External"),
      number: phone
    },
    closingBalance,
    environment: environment || "unknown",
    notes: notes || null
  };

  // Add transaction to history
  account.transactions.unshift(transaction); // newest first

  // Update timestamps
  account.updatedAt = new Date().toISOString();
  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: `Transaction recorded: ${transactionType} KSh ${parsedAmount.toLocaleString()}`,
    transaction,
    account: {
      accountKey,
      phone
    }
  });
});

/* PUT /p_account/account/:phone/transaction/:transactionId - Update a transaction */
router.put("/account/:phone/transaction/:transactionId", (req, res) => {
  const { phone, transactionId } = req.params;
  const updates = req.body;

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  const account = personalData.personalAccounts[accountKey];
  if (!account.transactions) {
    return res.status(404).json({ success: false, message: "No transactions found" });
  }

  const txnIndex = account.transactions.findIndex(t => t.id === transactionId);
  if (txnIndex === -1) {
    return res.status(404).json({ success: false, message: "Transaction not found" });
  }

  // Update transaction fields
  account.transactions[txnIndex] = {
    ...account.transactions[txnIndex],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  account.updatedAt = new Date().toISOString();
  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Transaction updated successfully",
    transaction: account.transactions[txnIndex]
  });
});

/* DELETE /p_account/account/:phone/transaction/:transactionId - Delete a transaction */
router.delete("/account/:phone/transaction/:transactionId", (req, res) => {
  const { phone, transactionId } = req.params;

  const personalData = readJSON(personalFile, { personalAccounts: {} });

  const accountKey = Object.keys(personalData.personalAccounts || {}).find(key =>
    normPhone(personalData.personalAccounts[key].phone) === normPhone(phone)
  );

  if (!accountKey) {
    return res.status(404).json({ success: false, message: "Account not found" });
  }

  const account = personalData.personalAccounts[accountKey];
  if (!account.transactions) {
    return res.status(404).json({ success: false, message: "No transactions found" });
  }

  const txnIndex = account.transactions.findIndex(t => t.id === transactionId);
  if (txnIndex === -1) {
    return res.status(404).json({ success: false, message: "Transaction not found" });
  }

  const deletedTransaction = account.transactions[txnIndex];
  account.transactions.splice(txnIndex, 1);

  account.updatedAt = new Date().toISOString();
  personalData.metadata = {
    ...personalData.metadata,
    lastUpdated: new Date().toISOString()
  };

  writeJSON(personalFile, personalData);

  res.json({
    success: true,
    message: "Transaction deleted successfully",
    transaction: deletedTransaction,
    newFinancials: account.financials
  });
});

/* GET /p_account/transactions/summary - Get transaction summary across all accounts */
router.get("/transactions/summary", (req, res) => {
  const personalData = readJSON(personalFile, { personalAccounts: {} });
  const accounts = Object.values(personalData.personalAccounts || {});

  let totalTransactions = 0;
  let totalReceived = 0;
  let totalSent = 0;

  const accountSummaries = accounts.map(account => {
    const txns = account.transactions || [];
    const txnCount = txns.length;
    let received = 0;
    let sent = 0;

    txns.forEach(t => {
      if (t.transactionType === "received") {
        received += parseFloat(t.amount) || 0;
      } else {
        sent += parseFloat(t.amount) || 0;
      }
    });

    totalTransactions += txnCount;
    totalReceived += received;
    totalSent += sent;

    return {
      phone: account.phone,
      name: account.name,
      accountType: "personal",
      transactionCount: txnCount,
      received,
      sent,
      closingBalance: received - sent,
      financials: account.financials
    };
  });

  res.json({
    success: true,
    summary: {
      totalAccounts: accounts.length,
      totalTransactions,
      totalReceived,
      totalSent,
      netFlow: totalReceived - totalSent
    },
    accounts: accountSummaries
  });
});

module.exports = router;