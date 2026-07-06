const express = require("express");
const bcrypt = require("bcrypt");
const {
  ensureMongoReady,
  ensureAdminReady,
  findUserInCounties,
  Admin,
  SuperAdmin,
  Agent,
  Dealer,
  PendingOfficerMessage,
  savePendingOfficerMessage,
  deletePendingOfficerMessage,
} = require("../mongoose");
const { processMessage } = require("../notification/notification");

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.hqUser) {
    return res.redirect("/hq");
  }
  next();
};

router.get("/", requireAuth, async (req, res) => {
  res.render("hq/admin", { hqUser: req.session.hqUser || null });
});

const norm = (p) => {
  if (!p) return "";
  let s = String(p).trim();
  if (s.startsWith("+254")) s = s.substring(4);
  if (s.startsWith("254") && s.length > 9) s = s.substring(3);
  if (s.startsWith("0")) s = s.substring(1);
  return "0" + s;
};

router.get("/check-superadmin", async (req, res) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      return res.json({ status: "ERROR", message: "Database not available" });
    }
    const adminReady = await ensureAdminReady();
    if (!adminReady) {
      return res.json({ status: "ERROR", message: "Admin database not available" });
    }
    const count = await SuperAdmin.countDocuments();
    return res.json({ status: "OK", exists: count > 0 });
  } catch (err) {
    console.error("Error checking superadmin:", err);
    return res.json({ status: "ERROR", message: err.message });
  }
});

router.post("/verify-phone", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system.",
    });
  }

  return res.json({
    status: "FOUND",
    name: `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`
      .trim()
      .toUpperCase(),
  });
});

router.post("/check-phone", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const normalised = norm(phone);

  const adminReady = await ensureAdminReady();
  if (!adminReady) {
    return res.json({ status: "ERROR", message: "Admin database not available" });
  }

  const [superAdmin, existingAdmin, agent, dealer, countiesUser] = await Promise.all([
    SuperAdmin.findOne({
      $or: [{ phoneNumber: phone }, { phoneNumber: normalised }],
    }).lean(),
    Admin.findOne({ phoneNumber: normalised }).lean(),
    Agent.findOne({ phoneNumber: normalised }).lean(),
    Dealer.findOne({ phoneNumber: normalised }).lean(),
    findUserInCounties(phone),
  ]);

  if (superAdmin) {
    return res.json({
      status: "ALREADY_SUPERADMIN",
      message: "This phone is already registered as Super Admin.",
    });
  }

  // Only treat as an existing admin (→ PIN login) when the account actually has
  // a PIN. A leftover record with pin:null is still pending creation, so it must
  // go through the PIN-creation workflow like any other non-admin.
  if (existingAdmin && existingAdmin.pin) {
    return res.json({
      status: "ALREADY_ADMIN",
      message: `This phone is already registered as Admin in ${existingAdmin.department}.`,
    });
  }

  if (!countiesUser) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system.",
    });
  }

  // Phone is verified in the counties (member) collection but is NOT a
  // SuperAdmin and has no active (PIN-set) Admin account. Whether or not they
  // are an Agent/Dealer, they are not yet an active HQ admin, so route them into
  // the PIN-creation (pending admin) flow instead of the PIN-login step.
  const fullName =
    `${countiesUser.FirstName} ${countiesUser.MiddleName || ""} ${countiesUser.LastName || ""}`
      .trim()
      .toUpperCase();

  return res.json({
    status: "VERIFIED",
    name: fullName,
    isAgent: Boolean(agent),
    isDealer: Boolean(dealer),
    hasPendingAdmin: Boolean(existingAdmin),
  });
});

router.post("/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }

  const passkey = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.adminOTP = {
    phone: norm(phone),
    passkey,
    expiresAt: Date.now() + 86400000,
  };

  // Store in shared pending map so cliant.ejs can pick it up
  const normalizedPhone = norm(phone);
  const user = await findUserInCounties(phone);
  const userName = user
    ? `${user.FirstName} ${user.LastName || ""}`.trim()
    : "";

  if (req.app && req.app.locals && req.app.locals.pendingAdminPasskeys) {
    req.app.locals.pendingAdminPasskeys.set(normalizedPhone, {
      passkey,
      expiresAt: Date.now() + 86400000,
      name: userName,
      verified: false,
    });
  }

  processMessage("HQ Admin", {
    to: phone.trim(),
    type: "security_alert",
    title: "Admin Passkey",
    content: `Your one-time admin passkey is: ${passkey}\nThis passkey expires in 24 hours.`,
    key: passkey,
  });

  if (!req.session.user) {
    req.session.user = { phoneNumber: phone.trim() };
  }
  if (!req.session.user.inbox) {
    req.session.user.inbox = [];
  }
  req.session.user.inbox.push({
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: "security_alert",
    title: "Admin Passkey",
    content: `Your one-time admin passkey is: ${passkey}\nThis passkey expires in 24 hours.`,
    date: new Date().toISOString(),
    unread: true,
    redirect: "/hq",
  });

  return res.json({
    status: "SENT",
    message: "Passkey sent. Check your inbox — expires in 24 hours.",
    passkey,
  });
});

router.post("/register", async (req, res) => {
  let { phone } = req.body;
  if (!phone) {
    return res.json({ status: "ERROR", message: "Phone number required." });
  }
  phone = phone.trim();

  const adminReady = await ensureAdminReady();
  if (!adminReady) {
    return res.json({ status: "ERROR", message: "Admin database not available" });
  }

  const existing = await Admin.findOne({ phoneNumber: norm(phone) }).lean();
  if (existing) {
    return res.json({
      status: "ALREADY_REGISTERED",
      message: "Admin already registered for this phone number.",
    });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system.",
    });
  }

  const fullName =
    `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`
      .trim()
      .toUpperCase();

  return res.json({
    status: "ALLOW_PIN",
    name: fullName,
  });
});

router.post("/create-admin-record", requireAuth, async (req, res) => {
  const { phone, department } = req.body;
  if (!phone || !department) {
    return res.json({
      status: "ERROR",
      message: "Phone and department required.",
    });
  }

  const normalised = norm(phone);
  const existing = await Admin.findOne({ phoneNumber: normalised }).lean();
  if (existing) {
    // An admin doc may already exist as a pending (pin:null) record created by a
    // previous attempt. Treat that as success so the PIN-creation flow (OTP +
    // officer message) can continue instead of blocking on "already registered".
    return res.json({
      status: "SUCCESS",
      message: "Admin account already pending. Continue with PIN creation.",
      alreadyExisted: true,
      processNumber: existing.processNumber || null,
    });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({ status: "ERROR", message: "User not found in system." });
  }

  const fullName =
    `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`
      .trim()
      .toUpperCase();
  const processNumber = `PROC-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

  const admin = new Admin({
    phoneNumber: normalised,
    name: fullName,
    department,
    processNumber,
    dateOfProcess: new Date(),
    pin: null,
    pinCreatedAt: null,
    status: "active",
  });

  await admin.save();

  return res.json({
    status: "SUCCESS",
    message: "Admin account created successfully.",
    processNumber,
  });
});

router.post("/create-pin", async (req, res) => {
  const { phone, pin, passkey, department } = req.body;
  if (!phone || !pin || !passkey || !department) {
    return res.json({
      status: "ERROR",
      message: "Phone, PIN, passkey and department are required.",
    });
  }

  const normalised = norm(phone);
  let passkeyVerified = false;

  // First check in-memory pendingAdminPasskeys (from send-otp)
  if (req.app && req.app.locals && req.app.locals.pendingAdminPasskeys) {
    const record = req.app.locals.pendingAdminPasskeys.get(normalised);
    if (record) {
      if (record.passkey !== passkey.trim()) {
        return res.json({
          status: "ERROR",
          message: "Invalid or incorrect passkey.",
        });
      }
      if (Date.now() > record.expiresAt) {
        req.app.locals.pendingAdminPasskeys.delete(normalised);
        return res.json({ status: "ERROR", message: "Passkey has expired." });
      }
      // Clean up passkey after successful validation
      req.app.locals.pendingAdminPasskeys.delete(normalised);
      passkeyVerified = true;
    }
  }

  // If not verified yet, check MongoDB PendingOfficerMessage collection
  if (!passkeyVerified) {
    try {
      const officerMsg = await PendingOfficerMessage.findOne({ phone: normalised });
      if (officerMsg) {
        if (officerMsg.passkey !== passkey.trim()) {
          return res.json({
            status: "ERROR",
            message: "Invalid or incorrect passkey.",
          });
        }
        // Check if passkey is not expired (24 hours)
        const msgTimestamp = officerMsg.timestamp || officerMsg.createdAt?.getTime() || 0;
        if (Date.now() - msgTimestamp > 86400000) {
          await PendingOfficerMessage.deleteOne({ phone: normalised });
          return res.json({ status: "ERROR", message: "Passkey has expired." });
        }
        // Clean up passkey after successful validation
        await PendingOfficerMessage.deleteOne({ phone: normalised });
        passkeyVerified = true;
      }
    } catch (err) {
      console.error("Error checking MongoDB for passkey:", err);
    }
  }

  // If passkey wasn't found in either location
  if (!passkeyVerified) {
    return res.json({
      status: "ERROR",
      message: "Invalid or incorrect passkey.",
    });
  }

  const hashedPin = await bcrypt.hash(pin, 10);

  const existing = await Admin.findOne({ phoneNumber: normalised }).lean();
  if (existing) {
    await Admin.updateOne(
      { phoneNumber: normalised },
      {
        $set: {
          pin: hashedPin,
          pinCreatedAt: new Date(),
          department: existing.department || department,
        },
      },
    );
    try {
      await deletePendingOfficerMessage(phone);
    } catch (e) {
      console.error("[admin] deletePendingOfficerMessage error:", e.message);
    }
    return res.json({
      status: "SUCCESS",
      message: "PIN created successfully.",
    });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({ status: "ERROR", message: "User not found in system." });
  }

  const fullName =
    `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`
      .trim()
      .toUpperCase();
  const processNumber = `PROC-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

  const admin = new Admin({
    phoneNumber: normalised,
    name: fullName,
    department,
    processNumber,
    dateOfProcess: new Date(),
    pin: hashedPin,
    pinCreatedAt: new Date(),
    status: "active",
  });

  await admin.save();
  try {
    await deletePendingOfficerMessage(phone);
  } catch (e) {
    console.error("[admin] deletePendingOfficerMessage error:", e.message);
  }

  return res.json({
    status: "SUCCESS",
    message: "Admin account created successfully.",
  });
});

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.json({ status: "ERROR", message: "Phone and PIN required." });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system.",
    });
  }

  const admin = await Admin.findOne({ phoneNumber: norm(phone) }).lean();
  if (!admin) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Admin account not found.",
    });
  }

  if (!admin.pin) {
    return res.json({
      status: "NO_PIN",
      message:
        "PIN not created yet. Please create your PIN in your client app.",
    });
  }

  const pinMatch = await bcrypt.compare(pin, admin.pin);
  if (!pinMatch) {
    return res.json({
      status: "WRONG_PIN",
      message: "Wrong PIN.",
    });
  }

  req.session.hqUser = {
    phoneNumber: admin.phoneNumber,
    name: admin.name,
    department: admin.department,
  };

  return res.json({
    status: "SUCCESS",
    name: admin.name,
    department: admin.department,
  });
});

router.post("/login-with-department", async (req, res) => {
  const { phone, pin, department } = req.body;
  if (!phone || !pin) {
    return res.json({
      status: "ERROR",
      message: "Phone and PIN are required.",
    });
  }

  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      return res.json({ status: "ERROR", message: "Database not available" });
    }

    const adminReady = await ensureAdminReady();
    if (!adminReady) {
      return res.json({ status: "ERROR", message: "Admin database not available" });
    }

    // 1. Verify phone exists in counties collection
    const countyUser = await findUserInCounties(phone);
    if (!countyUser) {
      return res.json({
        status: "NOT_REGISTERED",
        message: "Phone not registered in TBank system.",
      });
    }

    const normalised = norm(phone);

    // 2. Check SuperAdmin first (super admins can access any department)
    const superAdmin = await SuperAdmin.findOne({
      $or: [{ phoneNumber: phone }, { phoneNumber: normalised }],
    }).lean();
    if (superAdmin) {
      const pinMatch = await bcrypt.compare(pin, superAdmin.pin);
      if (!pinMatch) {
        return res.json({ status: "WRONG_PIN", message: "Wrong PIN." });
      }

      req.session.hqUser = {
        phoneNumber: superAdmin.phoneNumber,
        name: superAdmin.name,
        role: "superadmin",
      };

      return res.json({
        status: "SUCCESS",
        name: superAdmin.name,
        role: "superadmin",
        department: null,
        redirect: "/hq/admin",
      });
    }

    // 3. Check Admin in tbank-admin admins collection
    const admin = await Admin.findOne({ phoneNumber: normalised }).lean();
    if (!admin) {
      return res.json({
        status: "NOT_ADMIN",
        message: "Phone not registered as HQ admin.",
      });
    }

    if (!admin.pin) {
      return res.json({
        status: "NO_PIN",
        message: "PIN not created yet. Please create your PIN.",
      });
    }

    const pinMatch = await bcrypt.compare(pin, admin.pin);
    if (!pinMatch) {
      return res.json({ status: "WRONG_PIN", message: "Wrong PIN." });
    }

    // 4. Verify department matches selected department (only if department was provided)
    if (department && admin.department !== department) {
      return res.json({
        status: "WRONG_DEPARTMENT",
        message: `You are registered under "${admin.department}", not "${department}".`,
        actualDepartment: admin.department,
      });
    }

    // 5. Set session and return success
    req.session.hqUser = {
      phoneNumber: admin.phoneNumber,
      name: admin.name,
      department: admin.department,
    };

    return res.json({
      status: "SUCCESS",
      name: admin.name,
      department: admin.department,
      role: "admin",
    });
  } catch (err) {
    console.error("Error in login-with-department:", err);
    return res.json({ status: "ERROR", message: err.message });
  }
});

router.get("/departments", async (req, res) => {
  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      return res.json({ status: "ERROR", message: "Database not available" });
    }
    const adminReady = await ensureAdminReady();
    if (!adminReady) {
      return res.json({ status: "ERROR", message: "Admin database not available" });
    }
    const departments = await Admin.distinct("department");
    const deptsWithCounts = await Admin.aggregate([
      { $group: { _id: "$department", count: { $sum: 1 } } },
      { $project: { name: "$_id", count: 1, _id: 0 } },
    ]);
    return res.json({ status: "OK", departments: deptsWithCounts });
  } catch (err) {
    console.error("Error listing departments:", err);
    return res.json({ status: "ERROR", message: err.message });
  }
});

router.post("/create", async (req, res) => {
  const { department, phone } = req.body;
  if (!department || !phone) {
    return res.json({
      status: "ERROR",
      message: "Department and phone number required.",
    });
  }

  const normalised = norm(phone);
  const existing = await Admin.findOne({ phoneNumber: normalised }).lean();
  if (existing) {
    return res.json({
      status: "ALREADY_REGISTERED",
      message: "Admin already exists.",
    });
  }

  const user = await findUserInCounties(phone);
  if (!user) {
    return res.json({
      status: "NOT_REGISTERED",
      message: "Phone not registered in TBank system.",
    });
  }

  const validDepts = [
    "Finance",
    "Relations",
    "IT Department",
    "Operations",
    "Regions",
    "Human Resources",
  ];
  if (!validDepts.includes(department)) {
    return res.json({ status: "ERROR", message: "Invalid department." });
  }

  const fullName =
    `${user.FirstName} ${user.MiddleName || ""} ${user.LastName || ""}`
      .trim()
      .toUpperCase();
  const tempPin = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedPin = await bcrypt.hash(tempPin, 10);

  const admin = new Admin({
    phoneNumber: normalised,
    name: fullName,
    department,
    pin: hashedPin,
    createdAt: new Date(),
  });

  await admin.save();

  processMessage("HQ Admin", {
    to: phone.trim(),
    type: "security_alert",
    title: "Admin Account Created",
    content: `Your admin account for ${department} has been created. Temporary PIN: ${tempPin}`,
  });

  return res.json({
    status: "SUCCESS",
    message: "Admin account created successfully.",
  });
});

router.post("/send-officer-message", requireAuth, async (req, res) => {
  const { phone, name, dept, passkey } = req.body;
  if (!phone) return res.json({ status: "ERROR", message: "Phone required." });

  const hqUser = req.session.hqUser || {};
  const processorName = hqUser.name || "";
  const processorPhone = hqUser.phoneNumber || "";

  try {
    const result = await savePendingOfficerMessage({
      phone,
      name: name || "",
      dept: dept || "",
      passkey: passkey || "",
      processorName,
      processorPhone,
      timestamp: Date.now(),
    });
    if (!result) {
      return res.json({
        status: "ERROR",
        message: "Database unavailable. Please try again.",
      });
    }
    return res.json({ status: "SUCCESS" });
  } catch (e) {
    console.error("[admin] savePendingOfficerMessage error:", e.message);
    return res.json({
      status: "ERROR",
      message: "Failed to save officer message.",
    });
  }
});

router.get("/verify-department", async (req, res) => {
  if (!req.session || !req.session.hqUser) {
    return res.json({ status: "UNAUTHENTICATED" });
  }

  try {
    const ready = await ensureMongoReady();
    if (!ready) {
      return res.json({ status: "ERROR", message: "Database not available" });
    }

    const admin = await Admin.findOne({
      phoneNumber: norm(req.session.hqUser.phoneNumber),
    }).lean();
    if (admin) {
      return res.json({
        status: "OK",
        department: admin.department,
        isSuperAdmin: false,
        county: admin.county || null,
        constituency: admin.constituency || null,
        ward: admin.ward || null,
      });
    }

    const sessionNorm = norm(req.session.hqUser.phoneNumber);
    const superAdmin = await SuperAdmin.findOne({
      $or: [
        { phoneNumber: req.session.hqUser.phoneNumber },
        { phoneNumber: sessionNorm },
      ],
    }).lean();
    if (superAdmin) {
      return res.json({
        status: "OK",
        department: null,
        isSuperAdmin: true,
      });
    }

    return res.json({ status: "ERROR", message: "User not found in system" });
  } catch (err) {
    return res.json({ status: "ERROR", message: err.message });
  }
});

module.exports = router;
