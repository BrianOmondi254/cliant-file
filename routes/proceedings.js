const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");

// Helper to read JSON files
const readJSON = (filePath, defaultVal = {}) => {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
  }
  return defaultVal;
};

// Helper to write JSON files
const writeJSON = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${filePath}:`, e.message);
  }
};

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("0")) s = s.substring(1);
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  return s;
};

const flattenData = (data) => {
  if (Array.isArray(data)) return data;
  const flat = [];
  for (const county in data) {
    for (const constituency in data[county]) {
      for (const ward in data[county][constituency]) {
        flat.push(...data[county][constituency][ward]);
      }
    }
  }
  return flat;
};

// Data file paths
const proceedingsFile = path.join(__dirname, "../data/proceedings.json");
const generalFile = path.join(__dirname, "../general.json");

// Ensure data directory exists
const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize proceedings data file if it doesn't exist
if (!fs.existsSync(proceedingsFile)) {
  writeJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
}

// Helper to get member name by ID
const getMemberName = (members, memberId) => {
  const member = members.find(m => m.id === memberId);
  return member ? member.name : 'Unknown';
};

// GET /proceedings/:groupName - Render proceedings page for a group
router.get("/:groupName", (req, res) => {
  const userPhone = req.session?.user?.phoneNumber;
  
  if (!userPhone) {
    return res.redirect("/login");
  }

  const groupName = decodeURIComponent(req.params.groupName).trim();
  
  // Read proceedings data
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  // Import official members from general.json
  const allGeneralData = readJSON(generalFile, {});
  const userRegistry = readJSON(path.join(__dirname, "../data.json"), []);
  const flatGroups = flattenData(allGeneralData);
  const selectedGroupRecord = flatGroups.find(g => (g.groupName || '').trim() === groupName);
  
  let groupMembers = [];
  if (selectedGroupRecord) {
      const memberKeys = Object.keys(selectedGroupRecord).filter(k => k.startsWith('trustee_') || k.startsWith('official_') || k.startsWith('member_'));
      memberKeys.forEach(key => {
          const item = selectedGroupRecord[key];
          if (item && typeof item === 'object' && item.phone) {
              const normalizedPhone = norm(item.phone);
              
              // Cross-reference with data.json to get the latest name
              const registryUser = userRegistry.find(u => norm(u.phoneNumber) === normalizedPhone);
              let displayName = item.name || "Unknown Name";
              
              if (registryUser) {
                  displayName = [
                      registryUser.FirstName || '',
                      registryUser.MiddleName || '',
                      registryUser.LastName || ''
                  ].filter(n => n.trim() !== '').join(' ');
              }

              groupMembers.push({
                  id: item.id || item.phone || key, 
                  name: displayName,
                  position: item.title || item.type || "Member",
                  groupName: groupName,
                  phone: item.phone
              });
          }
      });
  } else {
      // Fallback to internal members if group doesn't exist in general.json
      groupMembers = proceedingsData.members.filter(m => (m.groupName || '').trim() === groupName);
  }
  
  // Filter data for this group
  const groupMeetings = proceedingsData.meetings.filter(m => (m.groupName || '').trim() === groupName);
  const groupAgenda = proceedingsData.agenda.filter(a => (a.groupName || '').trim() === groupName);
  const groupMinutes = proceedingsData.minutes.filter(m => (m.groupName || '').trim() === groupName);
  const groupVotes = proceedingsData.votes.filter(v => (v.groupName || '').trim() === groupName);
  const groupComments = proceedingsData.comments.filter(c => (c.groupName || '').trim() === groupName);
  const groupAttendance = proceedingsData.attendance.filter(a => (a.groupName || '').trim() === groupName);
  
  // Get current meeting (most recent or selected)
  const meetingId = req.query.meetingId;
  let currentMeeting = null;
  
  if (meetingId) {
    currentMeeting = groupMeetings.find(m => m.id === meetingId);
  } else if (groupMeetings.length > 0) {
    currentMeeting = groupMeetings[groupMeetings.length - 1];
  }
  
  // Get attendance for current meeting
  const currentAttendance = currentMeeting 
    ? groupAttendance.filter(a => a.meetingId === currentMeeting.id)
    : [];
  
  // Get present and absent members
  const presentMembers = [];
  const absentMembers = [];
  
  groupMembers.forEach(member => {
    const attendance = currentAttendance.find(a => a.memberId === member.id);
    if (attendance && attendance.status === 'present') {
      presentMembers.push(member);
    } else {
      absentMembers.push(member);
    }
  });
  
  // Get agenda items for current meeting with comments and votes
  const currentAgenda = currentMeeting
    ? groupAgenda.filter(a => a.meetingId === currentMeeting.id).map(item => {
        const itemComments = groupComments.filter(c => c.agendaId === item.id);
        const itemVotes = groupVotes.filter(v => v.agendaId === item.id);
        return {
          ...item,
          comments: itemComments.map(c => ({
            ...c,
            member: groupMembers.find(m => m.id === c.memberId) || { name: 'Unknown' }
          })),
          votes: itemVotes.map(v => ({
            ...v,
            member: groupMembers.find(m => m.id === v.memberId) || { name: 'Unknown' }
          })),
          supportVotes: itemVotes.filter(v => v.voteType === 'support').length,
          againstVotes: itemVotes.filter(v => v.voteType === 'against').length,
          abstainVotes: itemVotes.filter(v => v.voteType === 'abstain').length
        };
      })
    : [];
  
  // Get minutes for current meeting
  const currentMinutes = currentMeeting
    ? groupMinutes.filter(m => m.meetingId === currentMeeting.id)
    : [];
  
  // Calculate stats
  const presentCount = presentMembers.length;
  const absentCount = absentMembers.length;
  const agendaCount = currentAgenda.length;
  const totalMembers = groupMembers.length;
  const enactedCount = currentAgenda.filter(a => a.status === 'enacted').length;
  const rejectedCount = currentAgenda.filter(a => a.status === 'rejected').length;
  const pendingCount = currentAgenda.filter(a => a.status !== 'enacted' && a.status !== 'rejected').length;
  const approvedMinutesCount = currentMinutes.filter(m => m.status === 'approved').length;
  const minutesCount = currentMinutes.length;
  
  res.render("proccedings", {
    meetings: groupMeetings,
    currentMeeting,
    members: groupMembers,
    attendances: currentAttendance,
    presentMembers,
    absentMembers,
    presentCount,
    absentCount,
    agendaCount,
    totalMembers,
    agendaItems: currentAgenda,
    minutes: currentMinutes,
    enactedCount,
    rejectedCount,
    pendingCount,
    approvedMinutesCount,
    minutesCount,
    getMemberName: (memberId) => getMemberName(groupMembers, memberId),
    groupName
  });
});

// POST /api/meetings - Create a new meeting (Merged)
router.post("/api/meetings", (req, res) => {
  const { groupName, title, project, date, venue, startTime, endTime, chairperson, secretary, status } = req.body;
  
  if (!groupName || !title || !date) {
    return res.status(400).json({ error: "Group name, title, and date are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const newMeeting = {
    id: Date.now().toString(),
    groupName,
    title,
    project: project || '',
    date,
    venue: venue || '',
    startTime: startTime || '',
    endTime: endTime || '',
    chairperson: chairperson || '',
    secretary: secretary || '',
    chairpersonNote: '',
    adjournmentNote: '',
    status: status || 'active',
    visitors: [],
    createdAt: new Date().toISOString()
  };
  
  proceedingsData.meetings.push(newMeeting);
  writeJSON(proceedingsFile, proceedingsData);

  // --- AUTOMATED NOTIFICATIONS ---
  try {
    const allGroups = readJSON(generalFile, []);
    const currentGroup = allGroups.find(g => (g.groupName || '').trim() === groupName.trim());
    
    if (currentGroup && currentGroup.members) {
      const dataFile = path.join(__dirname, "../data.json");
      const allUsers = readJSON(dataFile, []);
      
      // Notify all members
      currentGroup.members.forEach(member => {
        const userIdx = allUsers.findIndex(u => norm(u.phoneNumber) === norm(member.phoneNumber));
        if (userIdx !== -1) {
          const user = allUsers[userIdx];
          if (!user.inbox) user.inbox = [];
          
          const msg = `${user.FirstName} ${user.LastName} you are invited to group meeting for ${groupName} due ${date} at ${startTime}. Contact Secretary ${secretary}`;
          
          user.inbox.push({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: 'meeting_invite',
            groupName: groupName,
            title: title,
            content: msg,
            date: new Date().toISOString(),
            unread: true
          });
        }
      });
      writeJSON(dataFile, allUsers);
    }
  } catch (err) {
    console.error("Notification Error:", err);
  }
  // --- END NOTIFICATIONS ---
  
  res.json({ success: true, meeting: newMeeting });
});

// PUT /api/meetings/:id - Update a meeting (Merged)
router.put("/api/meetings/:id", (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const meetingIndex = proceedingsData.meetings.findIndex(m => m.id === id);
  if (meetingIndex === -1) {
    return res.status(404).json({ error: "Meeting not found" });
  }
  
  proceedingsData.meetings[meetingIndex] = { ...proceedingsData.meetings[meetingIndex], ...updates };
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, meeting: proceedingsData.meetings[meetingIndex] });
});

// DELETE /api/meetings/:id/status - Redundant status route (can be removed if PUT /api/meetings/:id handles it)

// POST /api/meetings/:id/visitors - Add a visitor
router.post("/api/meetings/:id/visitors", (req, res) => {
    const { id } = req.params;
    const { name, phone, description } = req.body;
    
    if (!name) return res.status(400).json({ success: false, message: "Name required" });
    
    const proceedingsData = readJSON(proceedingsFile, { meetings: [] });
    const meetingIndex = proceedingsData.meetings.findIndex(m => m.id === id);
    
    if (meetingIndex === -1) {
        return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    
    if (!proceedingsData.meetings[meetingIndex].visitors) {
        proceedingsData.meetings[meetingIndex].visitors = [];
    }
    
    proceedingsData.meetings[meetingIndex].visitors.push({
        id: Date.now().toString(),
        name,
        phone: phone || '',
        description,
        addedAt: new Date().toISOString()
    });
    
    writeJSON(proceedingsFile, proceedingsData);
    
    res.json({ success: true });
});

// DELETE /api/meetings/:id/visitors/:name - Remove a visitor
router.delete("/api/meetings/:id/visitors/:name", (req, res) => {
    const { id, name } = req.params;
    const decodedName = decodeURIComponent(name);
    
    const proceedingsData = readJSON(proceedingsFile, { meetings: [] });
    const meetingIndex = proceedingsData.meetings.findIndex(m => m.id === id);
    
    if (meetingIndex === -1) {
        return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    
    if (proceedingsData.meetings[meetingIndex].visitors) {
        proceedingsData.meetings[meetingIndex].visitors = proceedingsData.meetings[meetingIndex].visitors.filter(v => v.name !== decodedName);
        writeJSON(proceedingsFile, proceedingsData);
    }
    
    res.json({ success: true });
});

// POST /api/proceedings/attendance - Mark attendance
router.post("/api/attendance", (req, res) => {
  const { meetingId, memberId, status, groupName, apology } = req.body;
  
  if (!meetingId || !memberId || !status || !groupName) {
    return res.status(400).json({ error: "Meeting ID, member ID, status, and group name are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  // Remove existing attendance for this member in this meeting
  proceedingsData.attendance = proceedingsData.attendance.filter(
    a => !(a.meetingId === meetingId && a.memberId === memberId)
  );
  
  // Add new attendance
  proceedingsData.attendance.push({
    id: Date.now().toString(),
    meetingId,
    memberId,
    status,
    apology: apology || '',
    groupName,
    createdAt: new Date().toISOString()
  });
  
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true });
});

// POST /api/proceedings/attendance/bulk - Bulk save attendance
router.post("/api/attendance/bulk", (req, res) => {
    const { meetingId, groupName, updates } = req.body;
    
    if (!meetingId || !updates) {
        return res.status(400).json({ success: false, message: "Meeting ID and updates required" });
    }
    
    const proceedingsData = readJSON(proceedingsFile, { attendance: [] });
    
    Object.keys(updates).forEach(memberId => {
        const { status, apology } = updates[memberId];
        
        // Find existing record for this member in this meeting
        const index = proceedingsData.attendance.findIndex(a => 
            a.meetingId === meetingId && a.memberId === memberId
        );
        
        const record = {
            id: index !== -1 ? proceedingsData.attendance[index].id : Date.now().toString() + Math.random().toString(36).substr(2, 5),
            meetingId,
            memberId,
            groupName,
            status,
            apology: apology || '',
            updatedAt: new Date().toISOString()
        };
        
        if (index !== -1) {
            proceedingsData.attendance[index] = record;
        } else {
            proceedingsData.attendance.push(record);
        }
    });
    
    writeJSON(proceedingsFile, proceedingsData);
    res.json({ success: true });
});

// POST /api/proceedings/projects - Create a new project
router.post("/api/projects", (req, res) => {
    const { groupName, title, objective, budget, targetDate } = req.body;
    
    if (!title) {
        return res.status(400).json({ success: false, message: "Project title required" });
    }
    
    const proceedingsData = readJSON(proceedingsFile, { projects: [] });
    
    const project = {
        id: Date.now().toString(),
        groupName,
        title,
        objective,
        budget,
        targetDate,
        createdAt: new Date().toISOString(),
        status: 'planned'
    };
    
    if (!proceedingsData.projects) proceedingsData.projects = [];
    proceedingsData.projects.push(project);
    
    writeJSON(proceedingsFile, proceedingsData);
    res.json({ success: true, project });
});

// POST /api/proceedings/agenda - Create a new agenda item
router.post("/api/agenda", (req, res) => {
  const { meetingId, groupName, title, description, proposerId, seconderId, thirdId } = req.body;
  
  if (!meetingId || !groupName || !title) {
    return res.status(400).json({ error: "Meeting ID, group name, and title are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const newAgenda = {
    id: Date.now().toString(),
    meetingId,
    groupName,
    title,
    description: description || '',
    proposerId: proposerId || '',
    seconderId: seconderId || '',
    thirdId: thirdId || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  proceedingsData.agenda.push(newAgenda);
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, agenda: newAgenda });
});

// PUT /api/proceedings/agenda/:id - Update agenda status
router.put("/api/agenda/:id", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const agendaIndex = proceedingsData.agenda.findIndex(a => a.id === id);
  if (agendaIndex === -1) {
    return res.status(404).json({ error: "Agenda item not found" });
  }
  
  proceedingsData.agenda[agendaIndex].status = status;
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, agenda: proceedingsData.agenda[agendaIndex] });
});

// POST /api/proceedings/votes - Cast a vote
router.post("/api/votes", (req, res) => {
  const { agendaId, memberId, voteType, groupName } = req.body;
  
  if (!agendaId || !memberId || !voteType || !groupName) {
    return res.status(400).json({ error: "Agenda ID, member ID, vote type, and group name are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  // Remove existing vote for this member on this agenda
  proceedingsData.votes = proceedingsData.votes.filter(
    v => !(v.agendaId === agendaId && v.memberId === memberId)
  );
  
  // Add new vote
  proceedingsData.votes.push({
    id: Date.now().toString(),
    agendaId,
    memberId,
    voteType,
    groupName,
    createdAt: new Date().toISOString()
  });
  
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true });
});

// POST /api/proceedings/comments - Add a comment
router.post("/api/comments", (req, res) => {
  const { agendaId, memberId, content, stance, groupName } = req.body;
  
  if (!agendaId || !memberId || !content || !stance || !groupName) {
    return res.status(400).json({ error: "Agenda ID, member ID, content, stance, and group name are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const newComment = {
    id: Date.now().toString(),
    agendaId,
    memberId,
    content,
    stance,
    groupName,
    createdAt: new Date().toISOString()
  };
  
  proceedingsData.comments.push(newComment);
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, comment: newComment });
});

// POST /api/proceedings/minutes - Create a new minute
router.post("/api/minutes", (req, res) => {
  const { meetingId, groupName, title, content } = req.body;
  
  if (!meetingId || !groupName || !title || !content) {
    return res.status(400).json({ error: "Meeting ID, group name, title, and content are required" });
  }
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const newMinute = {
    id: Date.now().toString(),
    meetingId,
    groupName,
    title,
    content,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  proceedingsData.minutes.push(newMinute);
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, minute: newMinute });
});

// PUT /api/proceedings/minutes/:id - Update minute status
router.put("/api/minutes/:id", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const proceedingsData = readJSON(proceedingsFile, { meetings: [], members: [], agenda: [], minutes: [], votes: [], comments: [], attendance: [] });
  
  const minuteIndex = proceedingsData.minutes.findIndex(m => m.id === id);
  if (minuteIndex === -1) {
    return res.status(404).json({ error: "Minute not found" });
  }
  
  proceedingsData.minutes[minuteIndex].status = status;
  writeJSON(proceedingsFile, proceedingsData);
  
  res.json({ success: true, minute: proceedingsData.minutes[minuteIndex] });
});

module.exports = router;
