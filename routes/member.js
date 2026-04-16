const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const memberFile = path.join(__dirname, "../member.json");
const generalFile = path.join(__dirname, "../general.json");

const readJSON = (file, fallback = null) => {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
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

const defaultMemberStructure = () => ({
  groups: []
});

const flattenData = (data) => {
  const groups = [];
  for (const county in data) {
    for (const constituency in data[county]) {
      for (const ward in data[county][constituency]) {
        for (const group of data[county][constituency][ward]) {
          groups.push(group);
        }
      }
    }
  }
  return groups;
};

const syncFromGeneral = () => {
  const generalData = readJSON(generalFile, {});
  if (!generalData || Object.keys(generalData).length === 0) {
    return;
  }
  
  const allGroups = flattenData(generalData);
  const memberData = readJSON(memberFile, defaultMemberStructure());
  
  allGroups.forEach(group => {
    const existingGroup = memberData.groups.find(g => g.groupName === group.groupName);
    const memberKeys = Object.keys(group).filter(k =>
      k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
    );
    
  const membersObj = {};
  memberKeys.forEach(key => {
    const item = group[key];
    if (item && item.phone) {
      membersObj[item.phone] = {
        totalBalance: "",
        accounts: {
          "001": { accountNumber: "001", accountName: "Saving", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "002": { accountNumber: "002", accountName: "Registration", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "003": { accountNumber: "003", accountName: "latenes", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "004": { accountNumber: "004", accountName: "welfare", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } }
        },
        processedDeductions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" }
      };
    }
  });
    
    if (existingGroup) {
      Object.keys(membersObj).forEach(phone => {
        if (!existingGroup.members[phone]) {
          existingGroup.members[phone] = membersObj[phone];
        }
      });
    } else {
      memberData.groups.push({
        groupNumber: memberData.groups.length + 1,
        accountNumber: group.accountNumber || "",
        groupName: group.groupName || "",
        otherContributions: {
          "001": { accountName: "Saving", expectedAmount: "100", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "002": { accountName: "Registration", expectedAmount: "100", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "003": { accountName: "latenes", expectedAmount: "100", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "004": { accountName: "welfare", expectedAmount: "100", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } }
        },
        members: membersObj
      });
    }
  });
  
  writeJSON(memberFile, memberData);
};

router.post("/sync", (req, res) => {
  try {
    syncFromGeneral();
    res.json({ success: true, message: "Synced from general.json" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", (req, res) => {
  const data = readJSON(memberFile, defaultMemberStructure());
  res.json(data);
});

router.get("/group/:groupNumber", (req, res) => {
  const { groupNumber } = req.params;
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.groups.find(g => g.groupNumber == groupNumber);
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  res.json(group);
});

router.get("/group/:groupNumber/member/:memberId", (req, res) => {
  const { groupNumber, memberId } = req.params;
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.groups.find(g => g.groupNumber == groupNumber);
  if (!group || !group.members || !group.members[memberId]) {
    return res.status(404).json({ error: "Member not found" });
  }
  res.json(group.members[memberId]);
});

router.post("/init", (req, res) => {
  const data = defaultMemberStructure();
  writeJSON(memberFile, data);
  res.json({ success: true, message: "member.json initialized", data });
});

router.post("/group", (req, res) => {
  const { groupNumber, accountNumber, groupName, otherContributions } = req.body;
  const data = readJSON(memberFile, defaultMemberStructure());
  
  const newGroup = {
    groupNumber: groupNumber || data.groups.length + 1,
    accountNumber: accountNumber || "",
    groupName: groupName || "",
    otherContributions: otherContributions || {
      "001": { accountName: "Saving", expectedAmount: "", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
      "002": { accountName: "Registration", expectedAmount: "", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
      "003": { accountName: "latenes", expectedAmount: "", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
      "004": { accountName: "welfare", expectedAmount: "", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } }
    },
    members: {}
  };
  
  data.groups.push(newGroup);
  writeJSON(memberFile, data);
  res.json({ success: true, group: newGroup });
});

router.post("/group/:groupNumber/member", (req, res) => {
  const { groupNumber } = req.params;
  const { memberId, accounts } = req.body;
  
  if (!memberId) {
    return res.status(400).json({ error: "memberId is required" });
  }
  
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.groups.find(g => g.groupNumber == groupNumber);
  
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  
  const defaultAccounts = {
    "001": { accountNumber: "001", accountName: "Saving", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
    "002": { accountNumber: "002", accountName: "Registration", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
    "003": { accountNumber: "003", accountName: "latenes", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
    "004": { accountNumber: "004", accountName: "welfare", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } }
  };
  
  group.members[memberId] = {
    totalBalance: "",
    accounts: accounts || defaultAccounts,
    processedDeductions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" }
  };
  
  writeJSON(memberFile, data);
  res.json({ success: true, member: group.members[memberId] });
});

router.put("/group/:groupNumber/member/:memberId/account/:accountNumber/transaction", (req, res) => {
  const { groupNumber, memberId, accountNumber } = req.params;
  const transactionData = req.body;
  
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.groups.find(g => g.groupNumber == groupNumber);
  
  if (!group || !group.members || !group.members[memberId] || !group.members[memberId].accounts || !group.members[memberId].accounts[accountNumber]) {
    return res.status(404).json({ error: "Account not found" });
  }
  
  const account = group.members[memberId].accounts[accountNumber];
  account.transactions = transactionData;
  
  writeJSON(memberFile, data);
  res.json({ success: true, account });
});

router.put("/group/:groupNumber/contribution/:accountNumber/transaction", (req, res) => {
  const { groupNumber, accountNumber } = req.params;
  const transactionData = req.body;
  
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.groups.find(g => g.groupNumber == groupNumber);
  
  if (!group || !group.otherContributions || !group.otherContributions[accountNumber]) {
    return res.status(404).json({ error: "Contribution account not found" });
  }
  
  group.otherContributions[accountNumber].transactions = transactionData;
  
  writeJSON(memberFile, data);
  res.json({ success: true, contribution: group.otherContributions[accountNumber] });
});

router.get("/structure", (req, res) => {
  res.json(defaultMemberStructure());
});

router.post("/verify-group", (req, res) => {
  const { groupName } = req.body;
  
  let data = readJSON(memberFile, defaultMemberStructure());
  
  if (!data.groups || data.groups.length === 0) {
    return res.status(404).json({ error: "No groups in member.json" });
  }
  
  const group = data.groups.find(g => g.groupName === groupName);
  
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  
  res.json({
    groupNumber: group.groupNumber,
    groupName: group.groupName,
    members: group.members || {}
  });
});

router.post("/group-by-name", (req, res) => {
  const { groupName } = req.body;
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || data.groups.length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  const group = data.groups.find(g => g.groupName === groupName);
  
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  
  res.json(group);
});

const accountTypeMap = {
  "savings": "001",
  "shares": "002",
  "loan": "003",
  "fines": "004",
  "Saving": "001",
  "Registration": "002",
  "latenes": "003",
  "welfare": "004"
};

router.post("/process-deduction", (req, res) => {
  const { groupName, deductions } = req.body;
  
  if (!deductions || !Array.isArray(deductions)) {
    return res.status(400).json({ error: "deductions array is required" });
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.groups || data.groups.length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  const group = data.groups.find(g => g.groupName === groupName);
  
  if (!group) {
    return res.status(404).json({ error: "Group not found: " + groupName });
  }
  
  let transactionCount = 0;
  
  deductions.forEach((ded, idx) => {
    const memberPhone = ded.memberPhone;
    const fromAccountNum = accountTypeMap[ded.memberAccount] || ded.memberAccount;
    const toAccountNum = accountTypeMap[ded.accountType] || ded.accountType;
    const amount = parseFloat(ded.amount);
    const processTime = ded.processTime || "now";
    
    let scheduledTime;
    let transactionState = "completed";
    
    if (processTime === "nextday") {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      scheduledTime = tomorrow.toISOString();
      transactionState = "scheduled";
    } else if (processTime === "nextround") {
      scheduledTime = "next_round";
      transactionState = "scheduled";
    } else {
      scheduledTime = new Date().toISOString();
    }
    
    if (!group.members[memberPhone]) {
      group.members[memberPhone] = {
        totalBalance: "",
        accounts: {
          "001": { accountNumber: "001", accountName: "Saving", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "002": { accountNumber: "002", accountName: "Registration", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "003": { accountNumber: "003", accountName: "latenes", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } },
          "004": { accountNumber: "004", accountName: "welfare", transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" } }
        },
        processedDeductions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" }
      };
    }
    
    const member = group.members[memberPhone];
    
    if (!member.accounts[fromAccountNum]) {
      member.accounts[fromAccountNum] = {
        accountNumber: fromAccountNum,
        accountName: ded.memberAccount,
        transactions: { time: "", transactionId: "", transactionNumber: "", entryType: "", counterpartyAccount: "", amount: "", totalAmount: "", transactionState: "" }
      };
    }
    
    member.processedDeductions = {
      time: scheduledTime,
      transactionId: "TXN" + Date.now() + idx,
      transactionNumber: idx + 1,
      entryType: "sent",
      counterpartyAccount: toAccountNum,
      amount: amount,
      totalAmount: amount,
      transactionState: transactionState
    };
    
    transactionCount++;
  });
  
  writeJSON(memberFile, data);
  res.json({ success: true, message: `Processed ${transactionCount} deductions`, processed: transactionCount });
});

module.exports = router;
