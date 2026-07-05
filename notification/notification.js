const fs = require('fs');
const path = require('path');
const { saveMessageToMongo, ensureMongoReady } = require('../mongoose');

/**
 * Normalizes phone numbers
 */
const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

/**
 * Internal helper to read JSON safely
 */
const readJSON = (file, fallback = []) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`Error parsing JSON from ${file}:`, e);
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

/**
 * Finds the correct official (Agent/Dealer/Regional Office) for a location
 */
const getAllocatedOfficial = (ward, constituency) => {
  if (!ward || !constituency) return null;

  const agentFile = path.join(__dirname, "../agent.json");
  const dealerFile = path.join(__dirname, "../dealer.json");
  const hqFile = path.join(__dirname, "../hq.json");

  const agents = readJSON(agentFile, []);
  const dealers = readJSON(dealerFile, []);
  const hqs = readJSON(hqFile, []);

  const wardLower = ward.toLowerCase();
  const constiLower = constituency.toLowerCase();

  const agent = agents.find(a => a.ward && a.ward.toLowerCase() === wardLower);
  if (agent) return { ...agent, type: "Agent" };

  const dealer = dealers.find(d => d.ward && d.ward.toLowerCase() === wardLower);
  if (dealer) return { ...dealer, type: "Dealer" };

  const hq = hqs.find(h => h.constituency && h.constituency.toLowerCase() === constiLower);
  if (hq) return { ...hq, type: "Regional Office" };

  return null;
};

/**
 * Core function to process a message.
 * Saves to MongoDB messages collection.
 */
const processMessage = (groupName, message) => {
  const msg = {
    groupName,
    to: message.to,
    type: message.type || "general",
    title: message.title || "Notification",
    content: message.content,
    key: message.key || null,
    broadcast: message.broadcast || false,
    roles: message.roles || [],
    meta: message.meta || null,
    createdAt: new Date().toISOString(),
  };

  ensureMongoReady().then(ready => {
    if (ready) {
      saveMessageToMongo(msg).catch(e => console.error('[notification] MongoDB save error:', e.message));
    }
  }).catch(() => {});

   return msg;
};

/**
 * Logic for initial group creation alerts
 */
const sendGroupCreationAlerts = (group, processorPhone) => {
  const { groupName, ward, constituency, county, phone: chairPhone } = group;
  const official = getAllocatedOfficial(ward, constituency);
  
  let notificationContent = "";
  let officialPhone = null;

  if (official) {
    officialPhone = official.phoneNumber || official.hqPhone || official.dealerPhone;
    notificationContent = `Your application for ${groupName} is pending. ${official.type} available at your location. Contact: ${officialPhone}`;
  } else {
    notificationContent = `Your application for ${groupName} is pending. Note: Your regional block is not yet allocated to any of our officials.`;
  }

  // 1. Log for the Processor
  processMessage(groupName, {
    to: processorPhone,
    type: "security_alert",
    title: "Group Creation",
    content: notificationContent
  });

  // 2. Log for the Official (if allocated)
  if (officialPhone) {
    processMessage(groupName, {
      to: officialPhone,
      type: "security_alert",
      title: "Group Creation",
      content: `Group Creation Request: ${groupName}. Submitted by Processor: ${processorPhone || 'Anonymous'}. Chairperson Phone: ${chairPhone}. Location: ${county}/${constituency}/${ward}. Please verify this request.`
    });
  }

  return { official, notificationContent };
};

/**
 * Logic for member addition notices (Used in Update Members)
 */
const sendMemberAddedNotices = (group, membersData, agentName, agentPhone) => {
  const { groupName, phone: chairPhone } = group;

  Object.values(membersData).forEach(member => {
    if (member && member.phone) {
      const messageContent = `You have been added to ${groupName}. \n` +
                             `Agent: ${agentName} (${agentPhone})\n` +
                             `Chairperson: ${chairPhone}\n` +
                             `Role: ${member.type || 'Member'}`;

      processMessage(groupName, {
        to: member.phone,
        type: "group_added",
        title: "Group Registration Notice",
        content: messageContent
      });
    }
  });
};

/**
 * Logic for full group registration/activation (Used in Activate Group)
 */
const sendActivationNotices = (group, payload, agentName, agentPhone) => {
  const { groupName, constitutionStartKey } = group;
  const chairPhone = group.phone || (payload.trustees && payload.trustees[0] ? payload.trustees[0].phone : '');

  // Collect all people to notify
  const allPeople = [];
  if (payload.trustees) allPeople.push(...payload.trustees);
  if (payload.officials) allPeople.push(...payload.officials);
  if (payload.members) allPeople.push(...payload.members);

  // Send constitution key to chairperson (trustee) specifically
  if (chairPhone && constitutionStartKey) {
    processMessage(groupName, {
      to: chairPhone,
      type: "security_alert",
      title: "Constitution Key",
      content: constitutionStartKey
    });
  }

  allPeople.forEach(person => {
    if (person && person.phone) {
      const messageContent = `Registration Complete: ${groupName} has been activated by Agent ${agentName}. \n` +
                             `Role: ${person.title || person.type || 'Member'}\n` +
                             `Chairperson: ${chairPhone}\n` +
                             `Status: Phase 2 (Pending HQ Approval)`;

      processMessage(groupName, {
        to: person.phone,
        type: "registration_activated",
        title: "Registration Success",
        content: messageContent
      });
    }
  });
};

module.exports = {
  norm,
  getAllocatedOfficial,
  processMessage,
  sendGroupCreationAlerts,
  sendMemberAddedNotices,
  sendActivationNotices
};
