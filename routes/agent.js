const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const PDFDocument = require("pdfkit");

const agentFile = path.join(__dirname, "../agent.json");
const generalFile = path.join(__dirname, "../general.json");
const dealerFile = path.join(__dirname, "../dealer.json");
const dataFile = path.join(__dirname, "../data.json");

const loadJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : fallback;
  } catch (e) {
    console.error("Error reading JSON:", e);
    return fallback;
  }
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

const flattenData = (data) => {
    if (Array.isArray(data)) return data;
    const flat = [];
    if (!data) return flat;
    for (const county in data) {
        if (typeof data[county] !== 'object') continue;
        for (const constituency in data[county]) {
            if (typeof data[county][constituency] !== 'object') continue;
            for (const ward in data[county][constituency]) {
                    const groups = data[county][constituency][ward];
                    if (Array.isArray(groups)) flat.push(...groups);
            }
        }
    }
    return flat;
};

// GET /agent
router.get("/", (req, res) => {
  // Prevent caching to ensure strict PIN entry logic works on back/forward navigation
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  // 1. Enforce Login: If no session exists, redirect to login immediately.
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  // 2. Use the logged-in user's phone number
  const currentPhoneNumber = req.session.user.phoneNumber;
  const agents = loadJSON(agentFile);
  const users = loadJSON(dataFile);

  // Create a map for faster user name lookups
  const userMap = new Map();
  if (Array.isArray(users)) {
    users.forEach(u => {
        // Filter out empty strings and join with space
        const parts = [u.FirstName, u.MiddleName, u.LastName].map(s => s && String(s).trim()).filter(Boolean);
        if (u.phoneNumber) userMap.set(normPhone(u.phoneNumber), parts.join(' '));
    });
  }

  const agent = agents.find((a) => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  // Helper to render safe views (No dashboard data)
  const renderSafe = (step, msg = null) => {
    return res.render("agent/agent", {
      step: step,
      phoneNumber: currentPhoneNumber,
      agentName: agent ? agent.name : "Unknown",
      agent: agent ? { name: agent.name, phoneNumber: agent.phoneNumber } : null, // Strict sanitization
      user: req.session.user,
      message: msg,
      groups: [], // BLOCK dashboard content
      dealer: null // BLOCK dashboard content
    });
  };

  // If the determined phone number doesn't belong to an agent
  if (!agent) {
    return renderSafe("not-agent", { type: "error", text: "Not qualified to be an agent." });
  }

  // Render the dashboard directly.
  const generalRaw = loadJSON(generalFile, {});
  const general = flattenData(generalRaw);
  
  // Normalize agent details once outside the loop for performance
  const agentWard = agent.ward ? normStr(agent.ward) : "";
  const agentCounty = agent.county ? normStr(agent.county) : "";
  const agentConst = agent.constituency ? normStr(agent.constituency) : "";
  const agentPhoneNormalized = normPhone(agent.phoneNumber);

  const managedGroups = general.filter((g) => {
      const groupWard = g.ward ? normStr(g.ward) : "";
      
      // Geographic Match Logic
      // 1. Ward must match exactly (and exist for both)
      const sameWard = groupWard && agentWard && groupWard === agentWard;
      
      // 2. County/Constituency must match IF the agent has them defined
      const groupCounty = g.county ? normStr(g.county) : "";
      const sameCounty = !agentCounty || (groupCounty && groupCounty === agentCounty);
      
      const groupConst = g.constituency ? normStr(g.constituency) : "";
      const sameConst = !agentConst || (groupConst && groupConst === agentConst);
      
      // Direct Assignment Logic
      const isProcessor = g.processorPhone && normPhone(g.processorPhone) === agentPhoneNormalized;
      const isAgentProcessed = g.agentProcessed && normPhone(g.agentProcessed) === agentPhoneNormalized;

      return (sameWard && sameCounty && sameConst) || isProcessor || isAgentProcessed;
  });

  // Augment managed groups with a list of members including their full names
  managedGroups.forEach(group => {
    // Only create a membersList if the group is already populated with members
    if (group.membersPopulatedAt || (group.phase && group.phase >= 2)) {
        group.membersList = [];
        for (const key in group) {
            if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
                let member = group[key];
                let phone = null;
                
                if (member && typeof member === 'object' && member.phone) {
                    phone = member.phone;
                } else if (typeof member === 'string') {
                    phone = member;
                }

                if (phone) {
                    const normalizedPhone = normPhone(phone);
                    // Lookup name from data.json, fallback to existing name, fallback to 'Unknown'
                    const memberName = userMap.get(normalizedPhone) || (typeof member === 'object' && member.name ? member.name : '') || 'Unknown Name';
                    
                    // Standardize member object
                    const memberObj = typeof member === 'object' ? { ...member } : { phone: phone, type: key.split('_')[0] };
                    memberObj.name = memberName;

                    // 1. Add to cleaned list for easy iteration
                    group.membersList.push(memberObj);

                    // 2. Update the original key in the group object so legacy views find the name
                    if (typeof group[key] === 'object') {
                        group[key].name = memberName;
                    } else {
                        // Convert string-only member to object in-memory
                        group[key] = memberObj;
                    }
                }
            }
        }
    }
  });

  const dealers = loadJSON(dealerFile);
  const dealer = (agent && Array.isArray(dealers)) ? dealers.find(d => normPhone(d.phoneNumber) === normPhone(agent.dealerPhone)) : null;

  const displayAgent = agent ? { ...agent, name: agent.name } : { phoneNumber: currentPhoneNumber, name: "Unknown Agent" };

  const selectedGroupName = req.query.groupName;
  const selectedGroupIndex = selectedGroupName ? managedGroups.findIndex(g => g.groupName === selectedGroupName) : -1;
  let selectedGroup = selectedGroupIndex > -1 ? managedGroups[selectedGroupIndex] : null;

  // If a group is selected and it's new (not populated), get registration config
  let registrationConfig = null;
  if (selectedGroup && !selectedGroup.membersPopulatedAt && (!selectedGroup.phase || selectedGroup.phase < 2)) {
    const tbankFile = path.join(__dirname, "../tbank.json");
    const tbankData = loadJSON(tbankFile, {});
    
    if (tbankData && tbankData.compliance && tbankData.compliance.membership) {
      const { trustees, officials, members, maxMembers } = tbankData.compliance.membership;
      registrationConfig = {
        trustees: parseInt(trustees) || 0,
        officials: parseInt(officials) || 0,
        members: parseInt(members) || 0,
        maxMembers: parseInt(maxMembers) || 40,
        showRegistrationForm: true,
      };
    }
    // To robustly prevent the "Existing Members" view, we replace the group object
    // in the main list with a minimal one, ensuring the template receives no conflicting data.
    const minimalGroup = { groupName: selectedGroup.groupName, isNew: true };
    managedGroups[selectedGroupIndex] = minimalGroup;
    selectedGroup = minimalGroup;
  }

  res.render("agent/agent", { 
    step: "dashboard", 
    agent: displayAgent, 
    groups: managedGroups, 
    selectedGroup: selectedGroup,
    dealer: dealer, 
    message: null, 
    phoneNumber: currentPhoneNumber, 
    user: (req.session && req.session.user) || { phoneNumber: currentPhoneNumber },
    registrationConfig: registrationConfig
  });

});

// GET /agent/new-group - Redirect to a dedicated page for populating new group requests
router.get("/new-group", (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const { groupName } = req.query;
  const agents = loadJSON(agentFile);
  const general = flattenData(loadJSON(generalFile, {}));
  
  const currentPhoneNumber = req.session.user.phoneNumber;
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));
  
  if (!agent) {
    return res.redirect("/agent");
  }

  // Find the group
  const group = general.find(g => g.groupName === groupName);
  if (!group) {
    return res.redirect("/agent");
  }

  // Get compliance standards
  const tbankFile = path.join(__dirname, "../tbank.json");
  const tbankData = loadJSON(tbankFile, {});
  
  let registrationConfig = {
    trustees: 3,
    officials: 3,
    members: 10,
    maxMembers: 100,
    newGroupFee: 50
  };

  if (tbankData && tbankData.compliance) {
    if (tbankData.compliance.membership) {
      const { trustees, officials, members, maxMembers } = tbankData.compliance.membership;
      registrationConfig.trustees = parseInt(trustees) || 3;
      registrationConfig.officials = parseInt(officials) || 3;
      registrationConfig.members = parseInt(members) || 10;
      registrationConfig.maxMembers = parseInt(maxMembers) || 100;
    }
    if (tbankData.compliance.registration && tbankData.compliance.registration.newGroupFee) {
      registrationConfig.newGroupFee = parseInt(tbankData.compliance.registration.newGroupFee) || 50;
    }
  }

  res.render("agent/new_group", {
    agent: agent,
    group: group,
    registrationConfig: registrationConfig,
    user: req.session.user
  });
});

// PIN related routes removed


// POST /agent/set-constitution-key
router.post("/set-constitution-key", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { groupName, key } = req.body;
  if (!key) return res.json({ success: false, message: "Key is required" });
  
  // Reload fresh data
  let general = loadJSON(generalFile);

  let found = false;

  // Logic to find and update group
  const updateGroup = (g) => {
      g.constitutionStartKey = key;
      g.constitutionKeySetByAgentAt = new Date().toISOString();
      found = true;
  };

  if (Array.isArray(general)) {
       const g = general.find(g => g.groupName === groupName);
       if (g) updateGroup(g);
  } else {
       // Traverse Hierarchy
       for (const c in general) {
           if (typeof general[c] !== 'object') continue;
           for (const co in general[c]) {
               if (typeof general[c][co] !== 'object') continue;
               for (const w in general[c][co]) {
                   const list = general[c][co][w];
                   if (Array.isArray(list)) {
                       const g = list.find(g => g.groupName === groupName);
                       if (g) updateGroup(g);
                   }
               }
           }
       }
  }

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      return res.json({ success: true });
  } else {
      return res.json({ success: false, message: "Group not found." });
  }
});

// POST /agent/register-new-group - Register new group with members
router.post("/register-new-group", async (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { groupName, chairpersonPhone, trustees, officials, members } = req.body;
  
  if (!groupName || !chairpersonPhone) {
    return res.json({ success: false, message: "Group name and chairperson phone are required" });
  }
  
  // Load general.json
  let general = loadJSON(generalFile);
  
  // Find and update the group
  let found = false;
  
  const updateGroup = (g) => {
      // Add chairperson as trustee_1
      g.trustee_1 = {
        phone: chairpersonPhone,
        type: 'trustee',
        title: 'Chairperson',
        name: 'Chairperson' // Temporary name until verified against data.json
      };
      g.phone = chairpersonPhone;
      g.createdAt = g.createdAt || new Date().toISOString();
      g.updatedAt = new Date().toISOString();
      g.registeredByAgent = req.session.user.phoneNumber;
      
      // Add trustees
      if (trustees && trustees.length > 0) {
          trustees.forEach((t, idx) => {
              g[`trustee_${idx + 1}`] = { 
                  name: t.name, 
                  id: t.id, 
                  phone: t.phone, 
                  type: 'trustee' 
              };
              if (idx === 0) {
                  g.trustee_1_name = t.name;
              }
          });
      }
      
      // Add officials
      if (officials && officials.length > 0) {
          officials.forEach((o, idx) => {
              g[`official_${idx + 1}`] = { 
                  name: o.name, 
                  id: o.id, 
                  phone: o.phone, 
                  type: 'official' 
              };
          });
      }
      
      // Add members
      if (members && members.length > 0) {
          members.forEach((m, idx) => {
              g[`member_${idx + 1}`] = { 
                  name: m.name, 
                  id: m.id, 
                  phone: m.phone, 
                  type: 'member' 
              };
          });
          g.totalProposedMembers = trustees.length + officials.length + members.length;
      }
      
      found = true;
  };

  if (Array.isArray(general)) {
       const g = general.find(g => g.groupName === groupName);
       if (g) updateGroup(g);
  } else {
       // Traverse Hierarchy
       for (const c in general) {
           if (typeof general[c] !== 'object') continue;
           for (const co in general[c]) {
               if (typeof general[c][co] !== 'object') continue;
               for (const w in general[c][co]) {
                   const list = general[c][co][w];
                   if (Array.isArray(list)) {
                       const g = list.find(g => g.groupName === groupName);
                       if (g) updateGroup(g);
                   }
               }
           }
       }
  }

  if (found) {
      fs.writeFileSync(generalFile, JSON.stringify(general, null, 2));
      return res.json({ success: true, message: "Group registered successfully" });
  } else {
      return res.json({ success: false, message: "Group not found." });
  }
});

// POST /agent/verify-user - Verify member exists in data.json
router.post("/verify-user", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.json({ success: false, message: "Unauthorized" });
  }

  const { phone } = req.body;
  const users = loadJSON(dataFile);
  const normalized = normPhone(phone);
  
  const user = users.find(u => normPhone(u.phoneNumber) === normalized);
  
  if (user) {
      // Construct full verified name
      const name = [user.FirstName, user.MiddleName, user.LastName].map(s => s && String(s).trim()).filter(Boolean).join(' ');
      return res.json({ success: true, name: name });
  } else {
      return res.json({ success: false, message: "User not found in registry." });
  }
});

// GET /agent/group-form/:groupName - Display group registration form
router.get("/group-form/:groupName", (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
    return res.redirect("/login");
  }

  const { groupName } = req.params;
  const decodedGroupName = decodeURIComponent(groupName);
  const agents = loadJSON(agentFile);
  const general = flattenData(loadJSON(generalFile, {}));

  const currentPhoneNumber = req.session.user.phoneNumber;
  const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

  if (!agent) {
    return res.status(403).json({ error: "Agent not found" });
  }

  // Find group
  let group = general.find(g => g.groupName === decodedGroupName);
  if (!group) {
    group = general.find(g => g.groupName && g.groupName.toLowerCase() === decodedGroupName.toLowerCase());
  }

  if (!group) {
    return res.status(404).json({
      error: `Group "${decodedGroupName}" not found`
    });
  }

  const tbank = require('../tbank.json');
  const data = require('../data.json');

  // Function to get name by phone
  function getNameByPhone(phone) {
    const user = data.find(u => u.phoneNumber === phone);
    return user ? `${user.FirstName} ${user.LastName}` : '';
  }

  // Populate names for trustees, officials, members
  Object.keys(group).forEach(key => {
    if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
      if (group[key] && group[key].phone) {
        group[key].name = getNameByPhone(group[key].phone);
      }
    }
  });

  res.render("group_form", {
    agent: agent,
    group: group,
    user: req.session.user,
    tbank: tbank
  });
});

// GET /agent/group-registration-pdf/:groupName - Download group registration form PDF
router.get("/group-registration-pdf/:groupName", (req, res) => {
  try {
    // Check authorization first
    if (!req.session || !req.session.user || !req.session.user.phoneNumber) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { groupName } = req.params;
    const decodedGroupName = decodeURIComponent(groupName);
    const agents = loadJSON(agentFile);
    const general = flattenData(loadJSON(generalFile, {}));
    const users = loadJSON(dataFile);

    const currentPhoneNumber = req.session.user.phoneNumber;
    const agent = agents.find(a => normPhone(a.phoneNumber) === normPhone(currentPhoneNumber));

    if (!agent) {
      return res.status(403).json({ error: "Agent not found" });
    }

    // Find group - try exact match first, then case-insensitive
    let group = general.find(g => g.groupName === decodedGroupName);
    if (!group) {
      group = general.find(g => g.groupName && g.groupName.toLowerCase() === decodedGroupName.toLowerCase());
    }



    if (!group) {
      return res.status(404).json({
        error: `Group "${decodedGroupName}" not found`,
        availableGroups: general.map(g => g.groupName)
      });
    }

  // Create a map for user lookups
  const userMap = new Map();
  if (Array.isArray(users)) {
    users.forEach(u => {
      const parts = [u.FirstName, u.MiddleName, u.LastName].map(s => s && String(s).trim()).filter(Boolean);
      if (u.phoneNumber) userMap.set(normPhone(u.phoneNumber), {
        name: parts.join(' '),
        id: u.IDNumber || ''
      });
    });
  }

  // Collect members
  const members = [];
  for (const key in group) {
    if (key.startsWith('trustee_') || key.startsWith('official_') || key.startsWith('member_')) {
      let member = group[key];
      let phone = null;
      let name = '';
      let id = '';
      let title = '';
      let index = 0;

      if (member && typeof member === 'object' && member.phone) {
        phone = member.phone;
        name = member.name || '';
        id = member.id || '';
        title = member.title || '';
        index = member.index || 0;
      } else if (typeof member === 'string') {
        phone = member;
      }

      if (phone) {
        const normalizedPhone = normPhone(phone);
        const userData = userMap.get(normalizedPhone);
        if (userData) {
          name = userData.name;
          id = userData.id;
        }

        const role = key.split('_')[0];
        // Set default titles for trustees if not specified
        if (role === 'trustee' && !title) {
          const trusteeIndex = parseInt(key.split('_')[1]) || 1;
          if (trusteeIndex === 1) title = 'Chairperson';
          else if (trusteeIndex === 2) title = 'Treasurer';
          else if (trusteeIndex === 3) title = 'Secretary';
          else title = 'Trustee';
        }

        members.push({
          role: role.charAt(0).toUpperCase() + role.slice(1),
          name: name,
          phone: phone,
          id: id,
          title: title,
          index: index || members.length + 1
        });
      }
    }
  }

  // Sort members by index
  members.sort((a, b) => a.index - b.index);



    // All validation passed, now generate PDF
    const filename = `${decodedGroupName.replace(/\s+/g, '_')}_Registration_Form.pdf`;

    // Set headers BEFORE any response
    res.setHeader('Content-disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-type', 'application/pdf');

    let doc;
    try {
      doc = new PDFDocument();
      doc.pipe(res);
    } catch (pdfError) {
      console.error('PDF Document creation error:', pdfError);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating PDF document' });
      }
      return;
    }

  // Professional Header
  let infoBoxY;
  try {
    doc.fontSize(18);
    doc.text('T-BANK INVESTMENT GROUP', { align: 'center' });
    doc.fontSize(14);
    doc.text('REGISTRATION FORM', { align: 'center' });
    doc.moveDown(0.5);

    // Decorative line
    doc.moveTo(100, doc.y).lineTo(500, doc.y).stroke();
    doc.moveDown(1);

    // Group Information Box
    infoBoxY = doc.y;
    doc.rect(50, infoBoxY, 500, 50).stroke();
    doc.fontSize(11);
  } catch (headerError) {
    console.error('Header generation error:', headerError);
    doc.end();
    return res.status(500).send('Error generating PDF header');
  }

  doc.text(`Location: ${group.county} | ${group.constituency} | ${group.ward}`, 70, infoBoxY + 10);
  doc.text(`Registration Agent: ${agent.name}`, 70, infoBoxY + 25);
  doc.text(`Agent Contact: ${agent.phoneNumber}`, 320, infoBoxY + 25);

doc.y = infoBoxY + 70;
  doc.moveDown();

  // Load tbank.json for membership requirements
  const tbank = loadJSON('tbank.json', {});
  const membership = tbank.compliance?.membership || {};
  const trusteesCount = parseInt(membership.trustees) || 4;
  const officialsCount = parseInt(membership.officials) || 4;
  const maxMembers = parseInt(membership.maxMembers) || 40;
  const regularMembersCount = maxMembers - trusteesCount - officialsCount;

  // Find chairperson phone number from existing members
  const chairperson = members.find(m => m.title === 'Chairperson');
  const chairpersonPhone = chairperson ? chairperson.phone : '';

  // Helper function to draw section table with grid lines
  function drawSectionTable(sectionTitle, rowCount, isTrusteesSection = false) {
    // Check if we need a new page
    if (doc.y > 700) {
      doc.addPage();
    }

    doc.fontSize(12);
    doc.text(sectionTitle, { underline: true });
    doc.moveDown(0.3);

    const tableTop = doc.y;
    const rowHeight = 15;
    const colWidths = [40, 80, 140, 250, 370, 470, 570];
    const tableWidth = 540;

    // Table headers
    doc.fontSize(10);
    doc.text('Index', 40, tableTop);
    doc.text('Title', 80, tableTop);
    doc.text('Name', 140, tableTop);
    doc.text('Phone Number', 250, tableTop);
    doc.text('ID Number', 370, tableTop);
    doc.text('ID (Optional)', 470, tableTop);

    // Header underline
    doc.moveTo(30, tableTop + 12).lineTo(570, tableTop + 12).stroke();

    // Table content
    let yPosition = tableTop + 20;

    for (let i = 0; i < rowCount; i++) {
      // Check if we need a new page mid-table
      if (yPosition > 750) {
        doc.addPage();
        yPosition = 50;
      }

      doc.fontSize(9);

      // Index column - empty for manual input
      doc.text('', 40, yPosition);

      // Title column
      if (isTrusteesSection && i === 0) {
        doc.text('Chairperson', 80, yPosition);
      } else if (isTrusteesSection && i === 1) {
        doc.text('Treasurer', 80, yPosition);
      } else if (isTrusteesSection && i === 2) {
        doc.text('Secretary', 80, yPosition);
      } else if (isTrusteesSection && i === 3) {
        doc.text('Trustee', 80, yPosition);
      } else {
        doc.text('', 80, yPosition);
      }

      // Name column - empty
      doc.text('', 140, yPosition);

      // Phone Number column - pre-populate chairperson only
      if (isTrusteesSection && i === 0 && chairpersonPhone) {
        doc.text(chairpersonPhone, 250, yPosition);
      } else {
        doc.text('', 250, yPosition);
      }

      // ID Number column - empty
      doc.text('', 370, yPosition);

      // ID (Optional) column - empty
      doc.text('', 470, yPosition);

      // Row separator (horizontal line)
      doc.moveTo(30, yPosition + 12).lineTo(570, yPosition + 12).stroke();
      yPosition += rowHeight;
    }

    // Draw vertical lines for all columns
    for (let i = 0; i < colWidths.length; i++) {
      doc.moveTo(colWidths[i], tableTop - 5).lineTo(colWidths[i], yPosition).stroke();
    }

    // Section border
    doc.rect(30, tableTop - 5, tableWidth, yPosition - tableTop + 5).stroke();
    doc.moveDown(0.5);
  }

  // Draw Trustees Section
  try {
    drawSectionTable('TRUSTEES SECTION', trusteesCount, true);
  } catch (trusteesError) {
    console.error('Trustees section error:', trusteesError);
  }

  // Draw Officials Section
  try {
    drawSectionTable('OFFICIALS SECTION', officialsCount, false);
  } catch (officialsError) {
    console.error('Officials section error:', officialsError);
  }

  // Draw Regular Members Section
  try {
    drawSectionTable('REGULAR MEMBERS SECTION', regularMembersCount, false);
  } catch (membersError) {
    console.error('Members section error:', membersError);
  }

  // Signature sections
  doc.moveDown(2);
  const signatureY = doc.y;
  const leftX = 50;
  const rightX = 320;

  // Prepared By Section - Left Column
  doc.fontSize(12);
  doc.text('PREPARED BY', leftX, signatureY);
  doc.moveTo(leftX, signatureY + 15).lineTo(leftX + 200, signatureY + 15).stroke();

  doc.fontSize(10);
  doc.text('Title/Position:', leftX, signatureY + 25);
  doc.text('Phone Number:', leftX, signatureY + 45);
  doc.text('Name:', leftX, signatureY + 65);
  doc.text('Date:', leftX, signatureY + 85);

  // Signature line
  doc.text('Signature:', leftX, signatureY + 105);
  doc.moveTo(leftX + 60, signatureY + 120).lineTo(leftX + 200, signatureY + 120).stroke();

  // Chairperson Section - Right Column
  doc.fontSize(12);
  doc.text('CHAIRPERSON APPROVAL', rightX, signatureY);
  doc.moveTo(rightX, signatureY + 15).lineTo(rightX + 200, signatureY + 15).stroke();

  doc.fontSize(10);
  doc.text('Phone Number:', rightX, signatureY + 25);
  doc.text('Name:', rightX, signatureY + 45);
  doc.text('Date:', rightX, signatureY + 85);

  // Signature line
  doc.text('Signature:', rightX, signatureY + 105);
  doc.moveTo(rightX + 60, signatureY + 120).lineTo(rightX + 200, signatureY + 120).stroke();

  // Chairperson instructions
  doc.moveDown(1);
  doc.fontSize(8);
  doc.text('Chairperson details pre-populated in Trustees section. Verify and update ID Number if needed.', rightX, doc.y, { width: 200, align: 'left' });
  doc.text('Chairperson must sign to approve all member registrations.', rightX, doc.y + 10, { width: 200, align: 'left' });

  doc.end();
  } catch (error) {
    console.error('Route error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error', details: error.message });
    }
  }
});

module.exports = router;