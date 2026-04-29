const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const memberFile = path.join(__dirname, "../member.json");
const generalFile = path.join(__dirname, "../general.json");
const dataFile = path.join(__dirname, "../data.json");

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

const restructureData = (data) => {
  const counties = Object.keys(data);
  const result = {};
  
  for (const county of counties) {
    const constis = data[county];
    for (const consti in constis) {
      const wards = constis[consti];
      for (const ward in wards) {
        const groups = wards[ward];
        if (Array.isArray(groups)) {
          for (const g of groups) {
            if (g.groupName) {
              if (!result[county]) result[county] = {};
              if (!result[county][consti]) result[county][consti] = {};
              if (!result[county][consti][ward]) result[county][consti][ward] = [];
              result[county][consti][ward].push(g);
            }
          }
        }
      }
    }
  }
  
  return result;
};

const defaultMemberStructure = () => ({
  group: {}
});

const normalizeKenyanPhone = (p = "") => {
  let digits = String(p).replace(/\D/g, "");

  // Handle +254..., 254..., and incorrect 2540... variants.
  if (digits.startsWith("254")) {
    digits = digits.substring(3);
  }
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
  }

  // Keep canonical local number as 9 digits (7XXXXXXXX).
  if (digits.length > 9) {
    digits = digits.slice(-9);
  }
  return digits;
};

const phoneVariants = (p = "") => {
  const canonical = normalizeKenyanPhone(p);
  const set = new Set();
  if (canonical) {
    set.add(canonical);
    set.add("0" + canonical);
    set.add("254" + canonical);
    set.add("+254" + canonical);
  }
  return set;
};

const findGroupInGeneral = (generalData, groupName) => {
  if (!generalData || !groupName) return null;
  const wanted = String(groupName || "").trim().toLowerCase();
  for (const county in generalData) {
    const constituencies = generalData[county] || {};
    for (const constituency in constituencies) {
      const wardArray = constituencies[constituency];
      if (!Array.isArray(wardArray)) continue;
      for (let idx = 0; idx < wardArray.length; idx++) {
        const item = wardArray[idx];
        const itemName = String(item && item.groupName ? item.groupName : "").trim().toLowerCase();
        if (item && typeof item === "object" && itemName === wanted) {
          return { county, constituency, wardArray, index: idx, group: item };
        }
      }
    }
  }
  return null;
};

const findGroupByMemberPhoneInGeneral = (generalData, memberPhone) => {
  const targetNorm = normalizeKenyanPhone(memberPhone || "");
  if (!generalData || !targetNorm) return null;

  for (const county in generalData) {
    const constituencies = generalData[county] || {};
    for (const constituency in constituencies) {
      const wardArray = constituencies[constituency];
      if (!Array.isArray(wardArray)) continue;
      for (let idx = 0; idx < wardArray.length; idx++) {
        const item = wardArray[idx];
        if (!item || typeof item !== "object" || !item.groupName) continue;

        const memberKeys = Object.keys(item).filter(k =>
          k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
        );
        for (const key of memberKeys) {
          const person = item[key];
          if (person && person.phone && normalizeKenyanPhone(person.phone) === targetNorm) {
            return { county, constituency, wardArray, index: idx, group: item };
          }
        }
      }
    }
  }
  return null;
};

const getMemberMetaFromGeneralGroup = (group, memberPhone) => {
  const targetNorm = normalizeKenyanPhone(memberPhone || "");
  if (!group || !targetNorm) return { index: "", memberNumber: "", phone: "" };

  const memberKeys = Object.keys(group).filter(k =>
    k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
  );

  for (const key of memberKeys) {
    const person = group[key];
    if (person && person.phone && normalizeKenyanPhone(person.phone) === targetNorm) {
      return {
        index: person.index || "",
        memberNumber: person.memberNumber || "",
        phone: person.phone || ""
      };
    }
  }

   return { index: "", memberNumber: "", phone: "" };
 };

 const flattenData = (data) => {
  const groups = [];
  for (const county in data) {
    const constis = data[county];
    for (const consti in constis) {
      const wardArray = constis[consti];
      if (Array.isArray(wardArray)) {
        for (const item of wardArray) {
          if (item && typeof item === 'object' && item.groupName) {
            // Also attach location info from the keys
            item._county = county;
            item._constituency = consti;
            groups.push(item);
          }
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

  // Also fetch metadata from general.json
  let accounts = readJSON(generalFile, {});
  if (Array.isArray(accounts)) {
    accounts = restructureData(accounts);
  }
  const flattenData = (data) => {
    const result = {};
    for (const county in data) {
      const constis = data[county];
      for (const consti in constis) {
        const wards = constis[consti];
        for (const ward in wards) {
          const groups = wards[ward];
          for (const idx in groups) {
            const g = groups[idx];
            if (g.groupName) {
              result[g.groupName] = { ...g, _key: idx };
            }
          }
        }
      }
    }
    return result;
  };
  const allGroups = flattenData(accounts);
  const generalGroup = allGroups[groupName];

  // Merge metadata from general.json if available
  if (generalGroup) {
    if (generalGroup.principles) foundGroup.principles = generalGroup.principles;
    if (generalGroup.requests) foundGroup.requests = generalGroup.requests;
    if (generalGroup.accountNumber) foundGroup.accountNumber = generalGroup.accountNumber;
    if (generalGroup.phase) foundGroup.phase = generalGroup.phase;
    if (generalGroup.totalProposedMembers) foundGroup.totalProposedMembers = generalGroup.totalProposedMembers;
    if (generalGroup.createdAt) foundGroup.createdAt = generalGroup.createdAt;
    if (generalGroup.county) foundGroup.county = generalGroup.county;
    if (generalGroup.constituency) foundGroup.constituency = generalGroup.constituency;
    if (generalGroup.ward) foundGroup.ward = generalGroup.ward;
  }

  // Return group with merged data
  res.json(foundGroup);
});

// POST /verify-user - Verify user exists in data.json by phone and check group membership (from general.json)
router.post("/verify-user", (req, res) => {
  const { phone, groupName, requesterPhone } = req.body;
  
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }
  
  const usersData = readJSON(dataFile, []);
  const generalData = readJSON(generalFile, {});
  
  const sessionProcessorPhone = req.session?.user?.phoneNumber || "";
  const processorPhone = requesterPhone || sessionProcessorPhone;
  const targetNorm = normalizeKenyanPhone(phone);
  const targetVariants = phoneVariants(phone);
  const requesterNorm = normalizeKenyanPhone(processorPhone || "");

  if (requesterNorm && targetNorm && requesterNorm === targetNorm) {
    return res.json({
      success: false,
      verified: false,
      ownNumber: true,
      message: "You cannot request to add your own number."
    });
  }
  
  // Check if already in group via general.json (source of truth for group composition)
  let isGroupMember = false;
  let existingRole = null;
  let existingMemberIndex = null;
  
  if (generalData && Object.keys(generalData).length > 0) {
    // First preference: use processor/requester group to locate members content.
    const processorGroupRef = findGroupByMemberPhoneInGeneral(generalData, processorPhone || "");

    // Fallback: locate by provided groupName.
    let targetGroup = null;
    if (processorGroupRef && processorGroupRef.group) {
      if (groupName) {
        const normalizedRequestedGroup = String(groupName).trim().toLowerCase();
        const normalizedProcessorGroup = String(processorGroupRef.group.groupName || "").trim().toLowerCase();
        targetGroup = normalizedRequestedGroup === normalizedProcessorGroup ? processorGroupRef.group : null;
      } else {
        targetGroup = processorGroupRef.group;
      }
    } else if (groupName) {
      const byNameRef = findGroupInGeneral(generalData, String(groupName).trim());
      targetGroup = byNameRef ? byNameRef.group : null;
    }

    if (targetGroup) {
      const memberKeys = Object.keys(targetGroup).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );
      for (const key of memberKeys) {
        const item = targetGroup[key];
        if (item && item.phone && targetVariants.has(normalizeKenyanPhone(item.phone))) {
          isGroupMember = true;
          existingRole = item.role || item.type || key.replace(/_/g, ' ').replace(/\d+/, '').trim() || 'member';
          existingMemberIndex = memberKeys.indexOf(key) + 1;
          break;
        }
      }
    }
  }
  
  if (isGroupMember) {
    return res.json({
      success: false,
      verified: false,
      isGroupMember: true,
      role: existingRole,
      memberIndex: existingMemberIndex,
      message: `This phone number is already a ${existingRole} in this group (Index: ${existingMemberIndex}).`
    });
  }
  
  // Look up in data.json
  const user = usersData.find(u => {
    // data.json primary key is "phoneNumber"
    const uPhone = normalizeKenyanPhone(u.phoneNumber || u.phone || "");
    return targetVariants.has(uPhone);
  });
  
  if (!user) {
    // Fallback: lookup by "phone" entry in general.json
    if (generalData && Object.keys(generalData).length > 0) {
      for (const county in generalData) {
        const constis = generalData[county] || {};
        for (const consti in constis) {
          const wardArray = constis[consti];
          if (!Array.isArray(wardArray)) continue;
          for (const item of wardArray) {
            if (!item || typeof item !== "object" || !item.groupName) continue;
            const memberKeys = Object.keys(item).filter(k =>
              k.startsWith("trustee_") || k.startsWith("official_") || k.startsWith("member_")
            );
            for (const key of memberKeys) {
              const person = item[key];
              if (person && person.phone && targetVariants.has(normalizeKenyanPhone(person.phone))) {
                return res.json({
                  success: true,
                  verified: true,
                  isGroupMember: false,
                  phone: person.phone,
                  name: person.name || person.title || person.phone,
                  firstName: "",
                  lastName: "",
                  county: county || "",
                  constituency: consti || "",
                  ward: "",
                  source: "general.json"
                });
              }
            }
          }
        }
      }
    }

    return res.json({
      success: false, 
      verified: false, 
      isGroupMember: false,
      message: "Phone number not found in system."
    });
  }
  
  const fullName = `${user.FirstName || ''} ${user.MiddleName || ''} ${user.LastName || ''}`.trim();
  
  res.json({
    success: true,
    verified: true,
    isGroupMember: false,
    phone: user.phoneNumber || user.phone || phone,
    name: fullName,
    firstName: user.FirstName,
    lastName: user.LastName,
    county: user.county,
    constituency: user.constituency,
    ward: user.ward
  });
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

// GET /gmember - Group membership management (for agents/officials)
router.get("/gmember", (req, res) => {
  const { groupName } = req.query;

  if (!groupName) {
    return res.redirect("/");
  }

  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }

  let foundGroup = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundGroup = data.group[key];
      break;
    }
  }

  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }

  // Fetch requests from general.json
  let generalData = readJSON(generalFile, {});
  if (generalData && Object.keys(generalData).length > 0) {
    const groupRef = findGroupInGeneral(generalData, groupName);
    if (groupRef && groupRef.group && groupRef.group.requests) {
      // Merge requests from general.json
      foundGroup.requests = groupRef.group.requests;
    } else {
      foundGroup.requests = foundGroup.requests || {};
    }
  } else {
    foundGroup.requests = foundGroup.requests || {};
  }

  const membersList = foundGroup.members ? Object.entries(foundGroup.members).map(([phone, m]) => ({
    phone,
    name: m.name || phone,
    memberId: m.memberId || phone,
    role: m.role || 'member',
    accounts: m.accounts || {},
    memberFinancials: m.memberFinancials || {}
  })) : [];

  res.render("gaccount/gmember", {
    group: foundGroup,
    members: membersList,
    user: req.session.user
  });
});

router.get("/gcon", (req, res) => {
  const { groupName } = req.query;
  
  if (!groupName) {
    return res.redirect("/");
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  let foundGroup = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundGroup = data.group[key];
      break;
    }
  }
  
  if (!foundGroup) {
    return res.status(404).send("Group not found");
  }
  
  const membersCount = foundGroup.members ? Object.keys(foundGroup.members).length : 0;
  const activeRound = foundGroup.currentRound || 1;
  const meetingsHeld = foundGroup.meetings ? foundGroup.meetings.length : 0;
  const groupAccountNumber = foundGroup.accountNumber || 'Pending';
  const hasConstitution = foundGroup.pinIsSet || false;
  
  let totalSavings = 0;
  let totalShares = 0;
  let totalLoans = 0;
  let totalFines = 0;
  
  if (foundGroup.members) {
    for (const phone in foundGroup.members) {
      const member = foundGroup.members[phone];
      if (member.accounts) {
        for (const accId in member.accounts) {
          const acc = member.accounts[accId];
          const fin = acc.financials || {};
          if (accId.toLowerCase().includes('saving')) {
            totalSavings += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('share')) {
            totalShares += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('loan')) {
            totalLoans += fin.closingBalance || 0;
          } else if (accId.toLowerCase().includes('fine')) {
            totalFines += fin.closingBalance || 0;
          }
        }
      }
    }
  }
  
  res.render("gaccount/gcon", {
    group: foundGroup,
    user: req.session.user,
    membersCount: membersCount,
    activeRound: activeRound,
    meetingsHeld: meetingsHeld,
    groupAccountNumber: groupAccountNumber,
    hasConstitution: hasConstitution,
    totalSavings: totalSavings,
    totalShares: totalShares,
    totalLoans: totalLoans,
    totalFines: totalFines
  });
});

// POST /add-member - Add a new member to a group
router.post("/add-member", (req, res) => {
  const { groupName, name, phone, role, initialSavings } = req.body;
  
  if (!groupName || !name || !phone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  
  let data = readJSON(memberFile, defaultMemberStructure());
  if (!data.group || Object.keys(data.group).length === 0) {
    syncFromGeneral();
    data = readJSON(memberFile, defaultMemberStructure());
  }
  
  let foundKey = null;
  for (const key in data.group) {
    if (data.group[key].groupName === groupName) {
      foundKey = key;
      break;
    }
  }
  
  if (!foundKey) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }
  
  const group = data.group[foundKey];
  
  // Check if member already exists
  if (group.members && group.members[phone]) {
    return res.status(400).json({ success: false, error: "Member already exists" });
  }
  
  // Create new member structure
  const memberId = phone;
  const defaultAccounts = {
    "001": { 
      accountId: "001", 
      accountName: "Saving", 
      expectedAmount: "100", 
      financials: { openingBalance: initialSavings || 0, amountIn: initialSavings || 0, amountOut: 0, closingBalance: initialSavings || 0 }, 
      transactionHistory: initialSavings > 0 ? [{
        date: new Date().toISOString(),
        type: "deposit",
        amount: initialSavings,
        balance: initialSavings,
        note: "Initial savings"
      }] : []
    },
    "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "003": { accountId: "003", accountName: "Shares", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
    "004": { accountId: "004", accountName: "Welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
  };
  
  if (!group.members) group.members = {};
  
  group.members[phone] = {
    memberId: memberId,
    name: name,
    role: role || 'member',
    memberFinancials: {
      openingBalance: initialSavings || 0,
      amountIn: initialSavings || 0,
      amountOut: 0,
      closingBalance: initialSavings || 0
    },
    accounts: defaultAccounts,
    processedDeductions: [],
    createdAt: new Date().toISOString()
  };
  
  writeJSON(memberFile, data);
  
  res.json({ success: true, member: group.members[phone] });
});


// POST /request-add-member - Submit a request to add a new member
router.post("/request-add-member", (req, res) => {
  const { groupName, requesterPhone, newMemberName, newMemberPhone, reason, county, constituency, ward, idNumber, conformed } = req.body;

  if (!groupName || !newMemberPhone) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  // Read from general.json
  let generalData = readJSON(generalFile, {});
  if (!generalData || Object.keys(generalData).length === 0) {
    return res.status(404).json({ success: false, error: "No groups found in general.json" });
  }

  // Find the target group
  const groupRef = findGroupInGeneral(generalData, groupName);
  if (!groupRef) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }

  const targetGroup = groupRef.group;

  // Check if member already exists in the group
  const memberKeys = Object.keys(targetGroup).filter(k =>
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  );
  const existingMember = memberKeys.find(key => {
    const person = targetGroup[key];
    return person && person.phone && normalizeKenyanPhone(person.phone) === normalizeKenyanPhone(newMemberPhone);
  });

  if (existingMember) {
    return res.status(400).json({ success: false, error: "Member already exists in this group" });
  }

  // Initialize requests array if not exists
  if (!targetGroup.requests) targetGroup.requests = {};
  if (!targetGroup.requests.addMember) targetGroup.requests.addMember = [];

  // Check for any existing request for this phone (any status)
  const existingRequest = targetGroup.requests.addMember.find(r =>
    normalizeKenyanPhone(r.newMemberPhone) === normalizeKenyanPhone(newMemberPhone)
  );
  if (existingRequest) {
    return res.status(400).json({ success: false, error: "A request already exists for this phone number (status: " + existingRequest.status + ")" });
  }

   // Add the request
   const newRequest = {
     id: Date.now().toString(),
     type: 'addMember',
     requesterPhone: requesterPhone || '',
     newMemberName,
     newMemberPhone,
     idNumber: idNumber || null,
     reason: reason || '',
     conformed: conformed === true || conformed === 'true', // Boolean flag
     status: 'pending',
     createdAt: new Date().toISOString()
   };

  targetGroup.requests.addMember.push(newRequest);

  // Write back to general.json
  writeJSON(generalFile, generalData);

  res.json({ success: true, request: newRequest });
});

// GET /member-requests - Get pending requests for a group
router.get("/member-requests", (req, res) => {
  const { groupName } = req.query;

  if (!groupName) {
    return res.status(400).json({ success: false, error: "groupName is required" });
  }

  // Read from general.json
  let generalData = readJSON(generalFile, {});
  if (!generalData || Object.keys(generalData).length === 0) {
    return res.status(404).json({ success: false, error: "No groups found" });
  }

  // Find the target group
  const groupRef = findGroupInGeneral(generalData, groupName);
  if (!groupRef) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }

  const targetGroup = groupRef.group;
  const requests = targetGroup.requests || {};

   // Enrich addMember requests with requester's details from group membership
   const enrichedAddMemberRequests = (requests.addMember || [])
     .filter(r => r.status === 'pending')
     .map(request => {
       const requesterPhone = request.requesterPhone;
       
       // Look up requester in group members (trustee_*, official_*, member_*)
       const memberKeys = Object.keys(targetGroup).filter(k =>
         k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
       );
       
       let requesterName = request.requesterName || '';
       let requesterMemberIndex = '';
       let requesterMemberNumber = '';
       
       if (requesterPhone) {
         // 1. Try to find in group members first (to get index/memberNumber and name)
         for (const key of memberKeys) {
           const member = targetGroup[key];
           if (member && member.phone && normalizeKenyanPhone(member.phone) === normalizeKenyanPhone(requesterPhone)) {
             requesterName = member.name || requesterName;
             requesterMemberIndex = member.index || '';
             requesterMemberNumber = member.memberNumber || '';
             break;
           }
         }
         
         // 2. If not found in group members, try to get name from data.json (users)
         if (!requesterName) {
           const dataFilePath = path.join(__dirname, "../data.json");
           try {
             if (fs.existsSync(dataFilePath)) {
               const users = JSON.parse(fs.readFileSync(dataFilePath, "utf8"));
               const user = users.find(u => normalizeKenyanPhone(u.phoneNumber) === normalizeKenyanPhone(requesterPhone));
               if (user) {
                 requesterName = [user.FirstName, user.MiddleName, user.LastName].filter(Boolean).join(' ');
               }
             }
           } catch (e) {
             console.error("Error looking up requester in data.json:", e);
           }
         }
         
         // 3. If still not found, try agent.json
         if (!requesterName) {
           const agentFilePath = path.join(__dirname, "../agent.json");
           try {
             if (fs.existsSync(agentFilePath)) {
               const agents = JSON.parse(fs.readFileSync(agentFilePath, "utf8"));
               const agent = agents.find(a => normalizeKenyanPhone(a.phoneNumber) === normalizeKenyanPhone(requesterPhone));
               if (agent) {
                 requesterName = agent.name;
               }
             }
           } catch (e) {
             console.error("Error looking up requester in agent.json:", e);
           }
         }
       }
       
       return {
         ...request,
         requesterName,
         requesterMemberIndex,
         requesterMemberNumber
       };
     });

  res.json({
    success: true,
    requests: {
      addMember: enrichedAddMemberRequests,
      roleChange: (requests.roleChange || []).filter(r => r.status === 'pending'),
      termination: (requests.termination || []).filter(r => r.status === 'pending')
    }
  });
});

// POST /approve-member-request - Approve or reject member request
router.post("/approve-member-request", (req, res) => {
  const { groupName, requestId, action } = req.body;

  if (!groupName || !requestId) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  // Read from general.json
  let generalData = readJSON(generalFile, {});
  if (!generalData || Object.keys(generalData).length === 0) {
    return res.status(404).json({ success: false, error: "No groups found" });
  }

  // Find target group in general.json
  const groupRef = findGroupInGeneral(generalData, groupName);
  if (!groupRef) {
    return res.status(404).json({ success: false, error: "Group not found" });
  }

  const targetGroup = groupRef.group;

  if (!targetGroup.requests || !targetGroup.requests.addMember) {
    return res.status(404).json({ success: false, error: "No requests found" });
  }

  const requestIndex = targetGroup.requests.addMember.findIndex(r => r.id === requestId);
  if (requestIndex === -1) {
    return res.status(404).json({ success: false, error: "Request not found" });
  }

  const request = targetGroup.requests.addMember[requestIndex];

  // Authorization: Check if logged-in user is a trustee or official of this group
  const userPhone = req.session?.user?.phoneNumber;
  if (!userPhone) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }

  // Check if user is trustee or official in the group
  const isAuthorized = Object.keys(targetGroup).some(key => {
    if (key.startsWith('trustee_') || key.startsWith('official_')) {
      const member = targetGroup[key];
      return member && member.phone && normalizeKenyanPhone(member.phone) === normalizeKenyanPhone(userPhone);
    }
    return false;
  });

  if (!isAuthorized) {
    return res.status(403).json({ success: false, error: "Only trustees or officials can approve/reject member requests" });
  }

  // Check if this member already exists in the group (prevent double processing)
  const allMemberKeys = Object.keys(targetGroup).filter(k =>
    k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
  );
  const existingMemberInGroup = allMemberKeys.find(key => {
    const person = targetGroup[key];
    return person && person.phone && normalizeKenyanPhone(person.phone) === normalizeKenyanPhone(request.newMemberPhone);
  });
  if (existingMemberInGroup) {
    return res.status(400).json({ success: false, error: "Member already exists in this group" });
  }

   if (action === 'approve') {
      // === ADD NEW MEMBER TO GROUP ===
      // Determine next member number based on existing members
      const memberKeys = Object.keys(targetGroup).filter(k =>
        k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
      );
      const nextIndex = memberKeys.length + 1;
      const newMemberKey = `member_${nextIndex}`;

      // Build new member object
      const newMemberData = {
        phone: request.newMemberPhone,
        name: request.newMemberName,
        id: request.id || null,
        type: 'member',
        index: String(nextIndex),
        memberNumber: String(nextIndex).padStart(3, '0'), // "001", "002", etc.
        idNumber: request.idNumber || null // Store ID number from request
      };

      // Include regional info if present in request
      if (request.county)     newMemberData.county = request.county;
      if (request.constituency) newMemberData.constituency = request.constituency;
      if (request.ward)    newMemberData.ward = request.ward;

       // Reconstruct group with proper key ordering
       // Goal: preserve original order, but ensure the member block is sorted and
       // that 'requests' appears immediately after the member block (before principles)
       const newGroup = {};
       const allKeys = Object.keys(targetGroup);
       
       // Helper: extract numeric suffix from keys like "trustee_3", "member_10"
       const getSuffixNum = (key) => {
         const match = key.match(/_(\d+)$/);
         return match ? parseInt(match[1], 10) : 0;
       };

       // Helper: determine if a key is a member-type key
       const isMemberKey = (k) => k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_');

       // Sort member keys by: type priority (trustee→official→member), then numeric suffix
       const memberPriority = (k) => {
         if (k.startsWith('trustee_')) return 0;
         if (k.startsWith('official_')) return 1;
         return 2; // member_
       };
       const existingMemberKeys = allKeys.filter(isMemberKey);
       const allMemberKeys = [...existingMemberKeys, newMemberKey].sort((a, b) => {
         const priA = memberPriority(a);
         const priB = memberPriority(b);
         if (priA !== priB) return priA - priB;
         return getSuffixNum(a) - getSuffixNum(b);
       });

       // Find the boundaries of the member block in the original key order
       const firstMemberIdx = allKeys.findIndex(isMemberKey);
       const lastMemberIdx = allKeys.reduce((last, k, idx) => isMemberKey(k) ? idx : last, -1);

       // Build the final key order array
       const finalOrder = [];
       // 1. Keys that appear before the member block (excluding 'requests' which we'll handle separately)
       if (firstMemberIdx > 0) {
         for (let i = 0; i < firstMemberIdx; i++) {
           const k = allKeys[i];
           if (k !== 'requests') finalOrder.push(k);
         }
       }
       // 2. Insert the sorted member block (existing members + new member)
       allMemberKeys.forEach(k => finalOrder.push(k));
       // 3. Insert 'requests' immediately after members if it exists
       if (targetGroup.requests !== undefined) {
         finalOrder.push('requests');
       }
       // 4. Append the remaining keys that were originally after the member block (excluding 'requests')
       if (lastMemberIdx >= 0) {
         for (let i = lastMemberIdx + 1; i < allKeys.length; i++) {
           const k = allKeys[i];
           if (k !== 'requests') finalOrder.push(k);
         }
       }

       // Populate newGroup according to the final order
       finalOrder.forEach(k => {
         if (k === newMemberKey) {
           newGroup[k] = newMemberData;
         } else if (isMemberKey(k)) {
           newGroup[k] = targetGroup[k];
         } else if (k === 'requests') {
           newGroup.requests = targetGroup.requests;
         } else {
           newGroup[k] = targetGroup[k];
         }
       });

       // Replace targetGroup contents with new ordered object
       Object.keys(targetGroup).forEach(k => delete targetGroup[k]);
       Object.assign(targetGroup, newGroup);

      // Also add to member.json for financial tracking
      const memberFile = path.join(__dirname, "../member.json");
      let memberData = readJSON(memberFile, { group: {} });
      if (!memberData.group) memberData.group = {};

      let memberGroupKey = Object.keys(memberData.group).find(k => memberData.group[k].groupName === groupName);
      if (!memberGroupKey) {
        const groupNum = Object.keys(memberData.group).length + 1;
        memberGroupKey = "ACC" + groupNum;
        memberData.group[memberGroupKey] = {
          groupNumber: groupNum,
          groupName: groupName,
          groupFinancials: { totalOpeningBalance: 0, totalAmountIn: 0, totalAmountOut: 0, totalClosingBalance: 0, availableWithdrawalBalance: 0 },
          accountSchema: {
            "001": { accountId: "001", accountName: "Saving", expectedAmount: "100" },
            "002": { accountId: "002", accountName: "Registration", expectedAmount: "100" },
            "003": { accountId: "003", accountName: "latenes", expectedAmount: "100" },
            "004": { accountId: "004", accountName: "welfare", expectedAmount: "100" }
          },
          members: {}
        };
      }

      const memberGroup = memberData.group[memberGroupKey];
      if (!memberGroup.members) memberGroup.members = {};

      if (!memberGroup.members[request.newMemberPhone]) {
        const defaultAccounts = {
          "001": { accountId: "001", accountName: "Saving", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "002": { accountId: "002", accountName: "Registration", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "003": { accountId: "003", accountName: "latenes", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] },
          "004": { accountId: "004", accountName: "welfare", expectedAmount: "100", financials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 }, transactionHistory: [] }
        };
        memberGroup.members[request.newMemberPhone] = {
          memberId: request.newMemberPhone,
          name: request.newMemberName,
          role: 'member',
          idNumber: request.idNumber || null, // Store ID number
          memberFinancials: { openingBalance: 0, amountIn: 0, amountOut: 0, closingBalance: 0 },
          accounts: defaultAccounts,
          processedDeductions: [],
          createdAt: new Date().toISOString()
        };
        writeJSON(memberFile, memberData);
      }

      // === GET APPROVER INFO ===
      const approverPhone = req.session?.user?.phoneNumber || "Unknown";
      let approverName = "System User";
      
      const dataFile = path.join(__dirname, "../data.json");
      if (fs.existsSync(dataFile)) {
        try {
          const users = JSON.parse(fs.readFileSync(dataFile, "utf8"));
          const foundUser = users.find(u => 
            normalizeKenyanPhone(u.phoneNumber) === normalizeKenyanPhone(approverPhone)
          );
          if (foundUser) {
            approverName = [foundUser.FirstName, foundUser.MiddleName, foundUser.LastName]
              .filter(Boolean)
              .join(' ');
          }
        } catch (e) {
          console.error("Error looking up user in data.json:", e);
        }
      }
      
      if (approverName === "System User") {
        const agentFile = path.join(__dirname, "../agent.json");
        if (fs.existsSync(agentFile)) {
          try {
            const agents = JSON.parse(fs.readFileSync(agentFile, "utf8"));
            const foundAgent = agents.find(a => 
              normalizeKenyanPhone(a.phoneNumber) === normalizeKenyanPhone(approverPhone)
            );
            if (foundAgent) approverName = foundAgent.name;
          } catch (e) {
            console.error("Error looking up agent in agent.json:", e);
          }
        }
      }
      
       request.approverPhone = approverPhone;
       request.approverName = approverName;
       request.status = 'approved';
       request.approvedAt = new Date().toISOString();

       // Update totalProposedMembers in the group (increment by 1)
       const memberCount = Object.keys(targetGroup).filter(k =>
         k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_')
       ).length;
       targetGroup.totalProposedMembers = memberCount;
     } else if (action === 'reject') {
      // === RECORD WHO REJECTED ===
      const approverPhone = req.session?.user?.phoneNumber || "Unknown";
      let approverName = "System User";
      
      const dataFile = path.join(__dirname, "../data.json");
      if (fs.existsSync(dataFile)) {
        try {
          const users = JSON.parse(fs.readFileSync(dataFile, "utf8"));
          const foundUser = users.find(u => 
            normalizeKenyanPhone(u.phoneNumber) === normalizeKenyanPhone(approverPhone)
          );
          if (foundUser) {
            approverName = [foundUser.FirstName, foundUser.MiddleName, foundUser.LastName]
              .filter(Boolean)
              .join(' ');
          }
        } catch (e) {
          console.error("Error looking up user in data.json:", e);
        }
      }
      
      if (approverName === "System User") {
        const agentFile = path.join(__dirname, "../agent.json");
        if (fs.existsSync(agentFile)) {
          try {
            const agents = JSON.parse(fs.readFileSync(agentFile, "utf8"));
            const foundAgent = agents.find(a => 
              normalizeKenyanPhone(a.phoneNumber) === normalizeKenyanPhone(approverPhone)
            );
            if (foundAgent) approverName = foundAgent.name;
          } catch (e) {
            console.error("Error looking up agent in agent.json:", e);
          }
        }
      }
      
      request.approverPhone = approverPhone;
      request.approverName = approverName;
      request.status = 'rejected';
      request.rejectedAt = new Date().toISOString();
    }

   // Write back to general.json
   writeJSON(generalFile, generalData);

   // Return updated request list to help frontend sync
   const updatedRequests = targetGroup.requests || {};
   res.json({ 
     success: true, 
     request,
     requests: {
       addMember: (updatedRequests.addMember || []).filter(r => r.status === 'pending'),
       roleChange: (updatedRequests.roleChange || []).filter(r => r.status === 'pending'),
       termination: (updatedRequests.termination || []).filter(r => r.status === 'pending')
     }
   });
});

// GET /member/get-by-phone - Get member details by phone number from data.json
router.get("/get-by-phone", (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }

  const dataFile = path.join(__dirname, "../data.json");
  const users = readJSON(dataFile, []);

  // Normalize the phone number for comparison
  const normalizeKenyanPhone = (p = "") => {
    let digits = String(p).replace(/\D/g, "");
    if (digits.startsWith("254")) digits = digits.substring(3);
    if (digits.startsWith("0")) digits = digits.substring(1);
    if (digits.length > 9) digits = digits.slice(-9);
    return digits;
  };

  const normalizedPhone = normalizeKenyanPhone(phone);
  const user = users.find(u => normalizeKenyanPhone(u.phoneNumber) === normalizedPhone);

  if (!user) {
    return res.json({ success: false, member: null });
  }

  const memberName = `${user.FirstName} ${user.MiddleName || ''} ${user.LastName}`.replace(/\s+/g, ' ').trim();
  return res.json({ 
    success: true, 
    member: { 
      name: memberName,
      idNumber: user.idNumber || ""
    } 
  });
});
module.exports = router;
