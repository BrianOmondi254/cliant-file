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
  group: {}
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
  
  const dataFile = path.join(__dirname, "../data.json");
  const usersData = readJSON(dataFile, []);
  const getUserName = (phone) => {
    const u = usersData.find(user => user.phoneNumber === phone || user.phoneNumber === '0' + phone || user.phoneNumber === '+254' + phone.substring(1));
    return u ? `${u.FirstName} ${u.LastName}`.trim() : null;
  };
  
  const allGroups = flattenData(generalData);
  const memberData = readJSON(memberFile, defaultMemberStructure());
  
  // Ensure group object exists
  if (!memberData.group) {
    memberData.group = {};
  }
  
  allGroups.forEach(group => {
    const groupName = group.groupName;
    if (!groupName) return;
    
    const memberKeys = Object.keys(group).filter(k =>
      k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
    );
    
    const membersObj = {};
    memberKeys.forEach(key => {
      const item = group[key];
      if (item && item.phone) {
        // Get name from data.json users
        const memberName = getUserName(item.phone) || item.title || key.replace(/_/g, ' ').replace(/(\d+)/, '#$1');
        
        membersObj[item.phone] = {
          memberId: item.phone,
          name: memberName,
          memberFinancials: {
            openingBalance: 0,
            amountIn: 0,
            amountOut: 0,
            closingBalance: 0
          },
          accounts: {
            "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
            "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
            "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
            "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
          },
          processedDeductions: []
        };
      }
    });
    
    if (memberData.group[groupName]) {
      // Add new members to existing group and update existing members with names
      Object.keys(membersObj).forEach(phone => {
        if (!memberData.group[groupName].members[phone]) {
          memberData.group[groupName].members[phone] = membersObj[phone];
        } else if (membersObj[phone].name) {
          // Update name for existing member
          memberData.group[groupName].members[phone].name = membersObj[phone].name;
        }
      });
    } else {
      // Try to find by groupName in existing keys
      let foundKey = Object.keys(memberData.group).find(k => memberData.group[k].groupName === groupName);
      if (foundKey) {
        Object.keys(membersObj).forEach(phone => {
          if (!memberData.group[foundKey].members[phone]) {
            memberData.group[foundKey].members[phone] = membersObj[phone];
          } else if (membersObj[phone].name) {
            memberData.group[foundKey].members[phone].name = membersObj[phone].name;
          }
        });
      } else {
        // Create new group structure
        const groupNum = Object.keys(memberData.group).length + 1;
        const accountNum = group.accountNumber || "ACC" + groupNum;
        memberData.group[accountNum] = {
          groupNumber: groupNum,
          groupName: groupName,
          groupFinancials: {
            totalOpeningBalance: 0,
            totalAmountIn: 0,
            totalAmountOut: 0,
            totalClosingBalance: 0,
            availableWithdrawalBalance: 0
          },
          accountSchema: {
            "001": { accountId: "001", accountName: "Saving", expectedAmount: "100" },
            "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
            "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
            "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
          },
          members: membersObj
        };
      }
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
  const groupKey = Object.keys(data.group).find(k => data.group[k].groupNumber == groupNumber);
  const group = groupKey ? data.group[groupKey] : null;
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  res.json(group);
});

router.get("/group/:groupNumber/member/:memberId", (req, res) => {
  const { groupNumber, memberId } = req.params;
  const data = readJSON(memberFile, defaultMemberStructure());
  const groupKey = Object.keys(data.group).find(k => data.group[k].groupNumber == groupNumber);
  const group = groupKey ? data.group[groupKey] : null;
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
  
  const accountNum = accountNumber || "ACC" + (Object.keys(data.group).length + 1);
  
  const newGroup = {
    groupNumber: groupNumber || Object.keys(data.group).length + 1,
    groupName: groupName || "",
    groupFinancials: {
      totalOpeningBalance: 0,
      totalAmountIn: 0,
      totalAmountOut: 0,
      totalClosingBalance: 0,
      availableWithdrawalBalance: 0
    },
    accountSchema: otherContributions || {
      "001": { accountId: "001", accountName: "Saving", expectedAmount: "100" },
      "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
      "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
      "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
    },
    members: {}
  };
  
  data.group[accountNum] = newGroup;
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
  const groupKey = Object.keys(data.group).find(k => data.group[k].groupNumber == groupNumber);
  const group = groupKey ? data.group[groupKey] : null;
  
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }
  
  const defaultAccounts = {
    "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
  };
  
  group.members[memberId] = {
    memberId: memberId,
    memberFinancials: {
      openingBalance: 0,
      amountIn: 0,
      amountOut: 0,
      closingBalance: 0
    },
    accounts: accounts || defaultAccounts,
    processedDeductions: []
  };
  
  writeJSON(memberFile, data);
  res.json({ success: true, member: group.members[memberId] });
});

router.put("/group/:groupNumber/member/:memberId/account/:accountNumber/transaction", (req, res) => {
  const { groupNumber, memberId, accountNumber } = req.params;
  const transactionData = req.body;
  
  const data = readJSON(memberFile, defaultMemberStructure());
  const group = data.group.find(g => g.groupNumber == groupNumber);
  
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
  const group = data.group.find(g => g.groupNumber == groupNumber);
  
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
  
  if (!data.group || Object.keys(data.group).length === 0) {
    return res.status(404).json({ error: "No groups in member.json" });
  }
  
  // Find group by groupName
  let foundKey = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundKey = key;
      break;
    }
  }
  
  const group = foundKey ? data.group[foundKey] : null;
  
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
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  // Find group by groupName
  let foundKey = null;
  let foundGroup = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundKey = key;
      foundGroup = data.group[key];
      break;
    }
  }
  
  if (!foundGroup) {
    return res.status(404).json({ error: "Group not found" });
  }
  
  // Return group as-is (member.json already has correct names)
  res.json(foundGroup);
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
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  // Find group by groupName
  let foundKey = null;
  let foundGroup = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundKey = key;
      foundGroup = data.group[key];
      break;
    }
  }
  
  const group = foundGroup;
  
  if (!group) {
    return res.status(404).json({ error: "Group not found: " + groupName });
  }
  
  // Calculate round based on constitution creation date
  const constitutionCreated = group.constitutionKeyGeneratedAt || group.constitutionKeySetByAgentAt || group.createdAt || new Date().toISOString();
  const now = new Date();
  const created = new Date(constitutionCreated);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // Store reference for updates
  const groupRef = data.group[foundKey];
  
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
    
    // Create member if not exists
    if (!group.members[memberPhone]) {
      group.members[memberPhone] = {
        memberId: memberPhone,
        memberFinancials: {
          openingBalance: 0,
          amountIn: 0,
          amountOut: 0,
          closingBalance: 0
        },
        accounts: {
          "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
        },
        processedDeductions: []
      };
    }
    
    const member = group.members[memberPhone];
    
    // Get existing totals
    const processedArr = member.processedDeductions || [];
    const existingTotal = processedArr.length > 0 ? (processedArr[processedArr.length - 1].totalDeductions || 0) : 0;
    const existingPending = processedArr.length > 0 ? (processedArr[processedArr.length - 1].totalPendingDeductions || 0) : 0;
    const newTotal = existingTotal + amount;
    const newPending = existingPending + amount;
    
    // Ensure source account exists
    if (!member.accounts[fromAccountNum]) {
      member.accounts[fromAccountNum] = {
        accountId: fromAccountNum,
        accountName: ded.memberAccount,
        expectedAmount: "100",
        financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 },
        transactionHistory: []
      };
    }
    
    // Add to transaction history
    const txnRecord = {
      time: scheduledTime,
      transactionId: "TXN" + Date.now() + idx,
      transactionNumber: idx + 1,
      type: "credit",
      targetAccount: toAccountNum,
      amount: amount,
      state: transactionState,
      description: "Deduction sent to " + ded.accountType
    };
    member.accounts[fromAccountNum].transactionHistory.push(txnRecord);
    
    // Update account financials
    member.accounts[fromAccountNum].financials.amountOut = (member.accounts[fromAccountNum].financials.amountOut || 0) + amount;
    member.accounts[fromAccountNum].financials.closingBalance = (member.accounts[fromAccountNum].financials.openingBalance || 0) + (member.accounts[fromAccountNum].financials.amountIn || 0) - (member.accounts[fromAccountNum].financials.amountOut || 0);
    
    // Add to processed deductions array
    if (!member.processedDeductions) {
      member.processedDeductions = [];
    }
    
    // Get round info
    const currentRound = Math.ceil(diffDays / 7) || 1;
    
    member.processedDeductions.push({
      time: scheduledTime,
      transactionId: "TXN" + Date.now() + idx,
      transactionNumber: idx + 1,
      type: "credit",
      targetAccount: toAccountNum,
      amount: amount,
      state: transactionState,
      description: "Deduction sent to " + ded.accountType,
      totalDeductions: newTotal,
      totalPendingDeductions: newPending,
      round: currentRound,
      createdAt: constitutionCreated
    });
    
    // Update member financials
    member.memberFinancials.amountOut = (member.memberFinancials.amountOut || 0) + amount;
    member.memberFinancials.closingBalance = (member.memberFinancials.openingBalance || 0) + (member.memberFinancials.amountIn || 0) - (member.memberFinancials.amountOut || 0);
    
    // Update group financials
    groupRef.groupFinancials.totalAmountOut = (group.groupFinancials.totalAmountOut || 0) + amount;
    groupRef.groupFinancials.totalClosingBalance = (group.groupFinancials.totalOpeningBalance || 0) + (group.groupFinancials.totalAmountIn || 0) - (group.groupFinancials.totalAmountOut || 0);
    groupRef.groupFinancials.availableWithdrawalBalance = group.groupFinancials.totalClosingBalance;
    
    transactionCount++;
  });
  
  writeJSON(memberFile, data);
  res.json({ success: true, message: `Processed ${transactionCount} deductions`, processed: transactionCount });
});

router.get("/contribution", (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;
  
  if (!groupName) {
    return res.redirect("/");
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  // Find group by groupName
  let foundGroup = null;
  let foundKey = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundGroup = data.group[key];
      foundKey = key;
      break;
    }
  }
  
  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  // Get constitution creation date for round calculation
  const constitutionCreated = foundGroup.constitutionKeyGeneratedAt || foundGroup.constitutionKeySetByAgentAt || foundGroup.createdAt || new Date().toISOString();
  const now = new Date();
  const created = new Date(constitutionCreated);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // Get end saving period from principles
  const principles = foundGroup.principles || {};
  const intervals = principles.intervals || {};
  const endSavingPeriod = intervals.endSavingPeriod || '1-year';
  
  // Calculate total rounds based on period
  let totalRounds = 52;
  if (endSavingPeriod === '6-months') totalRounds = 26;
  else if (endSavingPeriod === '2-years') totalRounds = 104;
  else if (endSavingPeriod === '3-years') totalRounds = 156;
  else if (endSavingPeriod === '4-years') totalRounds = 208;
  else if (endSavingPeriod === '5-years') totalRounds = 260;
  
  const activeRound = Math.ceil(diffDays / 7) || 1;
  const daysUntilMeeting = 7 - (diffDays % 7);
  const remainRounds = Math.max(0, totalRounds - activeRound);
  
  const summaryStats = {
    activeRound: activeRound,
    daysUntilMeeting: daysUntilMeeting,
    totalMembers: foundGroup.members ? Object.keys(foundGroup.members).length : 0,
    remainRounds: remainRounds
  };
  
  // Determine member phone and index
  const sessionPhone = req.session.user?.phoneNumber;
  const targetPhone = queryPhone || sessionPhone;
  
  // Format phone number for display
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index - find the position in sorted member list
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members).sort();
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  // Get group number (from groupNumber field)
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  // Get member data directly from group
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/mcont", {
    group: foundGroup,
    user: req.session.user,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber,
    summaryStats: summaryStats,
    memberData: memberData
  });
});

router.get("/loan", (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;
  
  if (!groupName) {
    return res.redirect("/");
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  let foundGroup = null;
  let foundKey = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundGroup = data.group[key];
      foundKey = key;
      break;
    }
  }
  
  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  const targetPhone = queryPhone || req.session?.user?.phoneNumber;
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index from member keys
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members);
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/mloan", {
    group: foundGroup,
    user: req.session.user,
    member: memberData,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber
  });
});

router.get("/membership", (req, res) => {
  const { groupName, memberPhone: queryPhone } = req.query;
  
  if (!groupName) {
    return res.redirect("/");
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  let foundGroup = null;
  let foundKey = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundGroup = data.group[key];
      foundKey = key;
      break;
    }
  }
  
  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  const targetPhone = queryPhone || req.session?.user?.phoneNumber;
  let displayPhone = targetPhone;
  if (targetPhone && targetPhone.startsWith('254')) {
    displayPhone = '0' + targetPhone.substring(3);
  } else if (targetPhone && targetPhone.startsWith('+254')) {
    displayPhone = '0' + targetPhone.substring(4);
  }
  
  // Get member index from member keys
  let memberIndex = null;
  if (foundGroup.members && displayPhone) {
    const memberKeys = Object.keys(foundGroup.members);
    memberIndex = memberKeys.indexOf(displayPhone) + 1;
  }
  
  const groupNumber = foundGroup.groupNumber || 1;
  const accountNumber = foundKey || foundGroup.accountNumber || '';
  
  let memberData = null;
  if (foundGroup && foundGroup.members && foundGroup.members[displayPhone]) {
    memberData = foundGroup.members[displayPhone];
  }
  
  res.render("maccount/membership", {
    group: foundGroup,
    user: req.session.user,
    member: memberData,
    memberPhone: displayPhone,
    memberIndex: memberIndex,
    groupNumber: groupNumber,
    accountNumber: accountNumber
  });
});

module.exports = router;
