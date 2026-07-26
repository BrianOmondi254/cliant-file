const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const {
  submitOrderRequest,
  getTransactionStatus,
  registerIpnUrl,
  getIpnList,
  getAccessToken,
  callbackUrl: envCallbackUrl,
  ipnUrl: envIpnUrl,
  ipnId: envIpnId,
} = require("../config/pesapal");

const router = express.Router();

const ENV_PATH = path.resolve(__dirname, "..", ".env");

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return "";
  return fs.readFileSync(ENV_PATH, "utf8");
}

function writeEnvWithIpnId(newIpnId) {
  const prev = readEnvFile();
  const lines = prev ? prev.split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    if (/^\s*PESAPAL_IPN_ID\s*=/.test(line)) {
      found = true;
      return `PESAPAL_IPN_ID=${newIpnId}`;
    }
    return line;
  });
  if (!found) out.push(`PESAPAL_IPN_ID=${newIpnId}`);
  fs.writeFileSync(ENV_PATH, out.join("\n") + (out.length ? "\n" : ""));
}

async function ensureValidIpn(options = {}) {
  const { preferredNotifType = "POST", writeFile = true, log = false } = options;

  const logOut = (...args) => {
    if (log) console.log(...args);
  };

  logOut("== Pesapal ensureValidIpn start ==");
  logOut("  loaded env PESAPAL_ENVIRONMENT  =", process.env.PESAPAL_ENVIRONMENT);
  logOut("  loaded env PESAPAL_IPN_URL       =", envIpnUrl);
  logOut("  loaded env PESAPAL_IPN_ID        =", envIpnId);

  const token = await getAccessToken();
  if (token.error) {
    throw new Error(`Pesapal auth failed: ${JSON.stringify(token.error)}`);
  }
  logOut("  ✔ Pesapal access token OK");

  const list = await getIpnList();
  logOut("  Existing registered IPNs on Pesapal:", JSON.stringify(list, null, 2).split("\n").map((l, i) => i === 0 ? l : "      " + l).join("\n"));

  let chosenIpnId = null;
  let actionTaken = "none";
  let matchedEntry = null;
  let registerResult = null;

  const matchById = Array.isArray(list)
    ? list.find((x) => x.ipn_id && envIpnId && String(x.ipn_id).trim() === String(envIpnId).trim())
    : null;
  const matchByUrl = Array.isArray(list)
    ? list.find((x) => {
        const a = String(x.url || "").replace(/\/$/, "").toLowerCase();
        const b = String(envIpnUrl || "").replace(/\/$/, "").toLowerCase();
        return !!a && !!b && a === b;
      })
    : null;
  const matchByUrlPost = Array.isArray(list)
    ? list.find((x) => {
        const a = String(x.url || "").replace(/\/$/, "").toLowerCase();
        const b = String(envIpnUrl || "").replace(/\/$/, "").toLowerCase();
        const type = String(x.ipn_notification_type_description || "").toUpperCase();
        return !!a && !!b && a === b && type === preferredNotifType;
      })
    : null;

  if (matchById) {
    const type = String(matchById.ipn_notification_type_description || "").toUpperCase();
    logOut(`  ✔ Current PESAPAL_IPN_ID matches a registered IPN by id. Type=${type} status=${matchById.ipn_status_decription || matchById.ipn_status}`);
    if (type === preferredNotifType) {
      chosenIpnId = matchById.ipn_id;
      actionTaken = "reused-id";
      matchedEntry = matchById;
    } else {
      logOut(`  ⚠ Existing IPN is ${type}, preferred is ${preferredNotifType}. Will register a ${preferredNotifType} IPN.`);
    }
  } else if (matchByUrlPost) {
    logOut(`  ✔ Found registered ${preferredNotifType} IPN matching PESAPAL_IPN_URL. ipn_id=${matchByUrlPost.ipn_id}`);
    chosenIpnId = matchByUrlPost.ipn_id;
    actionTaken = "reused-post";
    matchedEntry = matchByUrlPost;
  } else if (matchByUrl) {
    const type = String(matchByUrl.ipn_notification_type_description || "").toUpperCase();
    logOut(`  ℹ Found registered IPN matching env PESAPAL_IPN_URL but it's ${type}, not ${preferredNotifType}. Registering ${preferredNotifType} variant.`);
  } else if (envIpnId) {
    logOut(`  ⚠ PESAPAL_IPN_ID in .env (${envIpnId}) was NOT found on Pesapal for this merchant (cause of "specified IPN ID is invalid"). Registering new ${preferredNotifType} IPN for ${envIpnUrl}.`);
  } else {
    logOut(`  ℹ No PESAPAL_IPN_ID set in .env yet. Registering a new ${preferredNotifType} IPN for ${envIpnUrl}.`);
  }

  if (!chosenIpnId) {
    if (!envIpnUrl) {
      throw new Error("PESAPAL_IPN_URL env var is empty. Cannot register an IPN without a public URL.");
    }
    logOut(`  Registering new ${preferredNotifType} IPN URL: ${envIpnUrl}`);
    const registered = await registerIpnUrl(envIpnUrl, preferredNotifType);
    registerResult = registered;
    chosenIpnId = registered?.ipn_id || null;
    if (!chosenIpnId) {
      throw new Error(
        `Pesapal RegisterIPN response did not include ipn_id: ${JSON.stringify(registered)}`
      );
    }
    actionTaken = "registered-new";
    logOut(`  ✔ New ${preferredNotifType} IPN registered. ipn_id = ${chosenIpnId}`);
  }

  if (writeFile) {
    writeEnvWithIpnId(chosenIpnId);
    logOut(`  ✔ Wrote PESAPAL_IPN_ID=${chosenIpnId} into ${ENV_PATH}`);
  }

  return {
    ipnId: chosenIpnId,
    ipnUrl: envIpnUrl,
    preferredNotifType,
    actionTaken,
    matchedEntry,
    registerResult,
    registeredList: list,
    envPath: ENV_PATH,
    envWritten: !!writeFile,
  };
}

async function runColdStartVerification(expectedIpnId) {
  const verifyCode = `
    require("dotenv").config({ override: true });
    const cfg = require(${JSON.stringify(path.resolve(__dirname, "..", "config", "pesapal.js"))});
    console.log("coldStart.config.ipnId  =", cfg.ipnId);
    console.log("coldStart.config.ipnUrl =", cfg.ipnUrl);
    if (cfg.ipnId === ${JSON.stringify(expectedIpnId)}) {
      console.log("✅ COLD-START CONFIRMATION: config/pesapal.js correctly loaded the new IPN ID from .env.");
      process.exit(0);
    } else {
      console.log("❌ MISMATCH — expected =", ${JSON.stringify(expectedIpnId)});
      process.exit(7);
    }
  `;
  const child = child_process.spawnSync(process.execPath, ["-e", verifyCode], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.resolve(__dirname, ".."),
  });
  process.stdout.write(child.stdout || Buffer.alloc(0));
  process.stderr.write(child.stderr || Buffer.alloc(0));
  return child.status ?? 99;
}

const getBaseUrl = (req) => {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (req.connection.encrypted ? "https" : "http");
  return `${proto}://${req.get("host")}`;
};

const getPendingPayment = (req) => {
  if (!req.session.pesapalPayments) req.session.pesapalPayments = {};
  return req.session.pesapalPayments;
};

const setPendingPayment = (req, orderId, data) => {
  const payments = getPendingPayment(req);
  payments[orderId] = data;
};

const clearPendingPayment = (req, orderId) => {
  const payments = getPendingPayment(req);
  delete payments[orderId];
};

const getVerifiedRegistrations = (req) => {
  if (!req.session.pesapalVerifiedRegistrations) {
    req.session.pesapalVerifiedRegistrations = {};
  }
  return req.session.pesapalVerifiedRegistrations;
};

const setVerifiedRegistration = (req, verificationNonce, data) => {
  const map = getVerifiedRegistrations(req);
  map[verificationNonce] = data;
};

const consumeVerifiedRegistration = (req, verificationNonce) => {
  const map = getVerifiedRegistrations(req);
  const found = map[verificationNonce];
  if (found) delete map[verificationNonce];
  return found || null;
};

function isAdminSession(req) {
  const hq = req.session && req.session.hqUser;
  if (!hq) return false;
  const role = String(hq.role || "").toLowerCase();
  return role === "superadmin" || role === "admin";
}

function requireAdminOrInternalSecret(req, res, next) {
  if (isAdminSession(req)) return next();
  const envSecret = process.env.PESAPAL_ADMIN_API_SECRET || "";
  const headerSecret =
    req.headers["x-pesapal-admin-secret"] ||
    req.headers["X-Pesapal-Admin-Secret"] ||
    "";
  if (envSecret && headerSecret && envSecret === headerSecret) return next();
  return res.status(403).json({
    success: false,
    message: "Admin authentication required for this Pesapal management endpoint.",
  });
}

async function loadRegistrationFeeSettings() {
  const fallback = { amount: 0, paymentMethod: "none" };
  let source = "none";
  try {
    const { getTbankSettings } = require("./../mongoose");
    const tbankSettings = await getTbankSettings();
    if (tbankSettings && tbankSettings.compliance && tbankSettings.compliance.personal_account_registration) {
      source = "mongodb";
      return { settings: tbankSettings.compliance.personal_account_registration, source };
    }
  } catch (_mongoErr) {
    /* fall through */
  }
  try {
    const fsLib = require("fs");
    const tbankFile = path.resolve(__dirname, "..", "tbank.json");
    if (fsLib.existsSync(tbankFile)) {
      const raw = JSON.parse(fsLib.readFileSync(tbankFile, "utf8"));
      if (raw && raw.compliance && raw.compliance.personal_account_registration) {
        source = "tbank.json";
        return { settings: raw.compliance.personal_account_registration, source };
      }
    }
  } catch (_fsErr) {
    /* fall through */
  }
  return { settings: fallback, source };
}

const moneyEq = (a, b, cents = 0) => {
  const na = Number(a) || 0;
  const nb = Number(b) || 0;
  const mult = Math.pow(10, cents);
  return Math.round(na * mult) === Math.round(nb * mult);
};

const isSuccessStatus = (statusCode) => {
  const COMPLETED = 1;
  const FAILED = 2;
  const REVERSED = 3;
  const PENDING = 0;
  const PROCESSING = 101;
  const SUCCESS_CODES = new Set([COMPLETED]);
  return SUCCESS_CODES.has(Number(statusCode));
};

const isTerminalFailure = (statusCode) => {
  const FAILED = 2;
  const REVERSED = 3;
  const INVALID = 4;
  return new Set([FAILED, REVERSED, INVALID]).has(Number(statusCode));
};

const isPesapalIpnInvalid = (err) => {
  const data = err?.response?.data || {};
  const msg =
    String(
      data?.error?.message ||
        data?.message ||
        data?.error ||
        err?.message ||
        ""
    ).toLowerCase();
  return (
    msg.includes("ipn id") ||
    msg.includes("ipn_id") ||
    msg.includes("notification id") ||
    msg.includes("notification_id") ||
    msg.includes("specified ipn") ||
    msg.includes("invalid ipn")
  );
};

router.post("/initiate", async (req, res) => {
  try {
    const now = Date.now();
    if (!req.session.pesapalRateLimit) req.session.pesapalRateLimit = [];
    const recent = (req.session.pesapalRateLimit || []).filter(
      (t) => now - t < 2 * 60 * 1000
    );
    if (recent.length >= 6) {
      return res.status(429).json({
        success: false,
        message: "Too many payment attempts. Please wait 2 minutes and try again.",
      });
    }
    recent.push(now);
    req.session.pesapalRateLimit = recent;

    const { amount, registrationData } = req.body;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid amount provided." });
    }

    const { settings: feeSettings, source } = await loadRegistrationFeeSettings();
    if (!feeSettings || feeSettings.paymentMethod !== "pesapal") {
      return res.status(400).json({
        success: false,
        message: `Pesapal is not the currently enabled registration payment method on this server (source=${source}, method=${
          feeSettings?.paymentMethod || "none"
        }). No charges were made.`,
      });
    }
    const expectedAmount = Number(feeSettings.amount || 0);
    const requestedAmount = Number(amount);
    if (!moneyEq(requestedAmount, expectedAmount, 0)) {
      console.warn(
        `[Pesapal initiate] Amount mismatch from client: requested=${requestedAmount} expected=${expectedAmount} (source=${source}). Rejecting as tampering.`
      );
      return res.status(400).json({
        success: false,
        message: `Incorrect registration fee amount. Expected ${expectedAmount.toFixed(
          2
        )} KES.`,
      });
    }

    let userData = {};
    try {
      if (registrationData) {
        userData =
          typeof registrationData === "string"
            ? JSON.parse(registrationData)
            : registrationData;
      }
    } catch (parseErr) {
      console.warn("Pesapal initiate: Could not parse registrationData");
      userData = {};
    }

    const orderId = crypto.randomBytes(16).toString("hex");
    const baseUrl = getBaseUrl(req);

    const callbackUrl =
      envCallbackUrl || `${baseUrl}/api/payment/pesapal/callback`;
    const notificationId = envIpnId || "";

    const firstName = userData.FirstName || userData.firstName || "";
    const middleName = userData.MiddleName || userData.middleName || "";
    const lastName = userData.LastName || userData.lastName || "";
    const email = userData.email || "";
    const phoneNumber =
      userData.phoneNumber ||
      userData.PhoneNumber ||
      userData.phone ||
      "";

    let orderResult = null;
    let usedFallback = false;

    try {
      orderResult = await submitOrderRequest(
        {
          id: orderId,
          amount: expectedAmount,
          currency: "KES",
          description: "Cliant Account Registration Fee",
          callbackUrl: callbackUrl,
          notificationId: notificationId,
          firstName,
          middleName,
          lastName,
          email,
          phoneNumber,
        },
        { skipNotificationId: false }
      );
    } catch (primaryErr) {
      if (isPesapalIpnInvalid(primaryErr)) {
        console.warn(
          "[Pesapal initiate] IPN ID rejected by Pesapal, retrying without notification_id.",
          "Original error:",
          primaryErr.response?.data || primaryErr.message
        );
        usedFallback = true;
        try {
          orderResult = await submitOrderRequest(
            {
              id: orderId,
              amount: expectedAmount,
              currency: "KES",
              description: "Cliant Account Registration Fee",
              callbackUrl: callbackUrl,
              notificationId: "",
              firstName,
              middleName,
              lastName,
              email,
              phoneNumber,
            },
            { skipNotificationId: true }
          );
        } catch (fallbackErr) {
          throw fallbackErr;
        }
      } else {
        throw primaryErr;
      }
    }

    if (!orderResult || !orderResult.redirect_url) {
      console.error(
        "Pesapal initiate: No redirect_url returned:",
        orderResult
      );
      return res.status(500).json({
        success: false,
        message:
          orderResult?.error?.message ||
          "Failed to initiate Pesapal payment. Please check your Pesapal credentials.",
      });
    }

    setPendingPayment(req, orderId, {
      amount: expectedAmount,
      expectedAmount: expectedAmount,
      registrationData:
        typeof registrationData === "string"
          ? registrationData
          : JSON.stringify(registrationData || {}),
      orderTrackingId: orderResult.order_tracking_id || null,
      merchantReference: orderResult.merchant_reference || orderId,
      createdAt: new Date().toISOString(),
      initiatedAtMs: now,
      status: "INITIATED",
      ipnUsed: !usedFallback && !!notificationId,
    });

    return res.json({
      success: true,
      redirect_url: orderResult.redirect_url,
      orderId: orderId,
      warning: usedFallback
        ? "Warning: Your Pesapal PESAPAL_IPN_ID value is not recognized by Pesapal. Payment will still complete via browser callback, but server webhooks (IPN) will be skipped until you fix the IPN ID. See /api/payment/pesapal/ipn-list or /api/payment/pesapal/register-ipn."
        : null,
    });
  } catch (err) {
    console.error(
      "Pesapal initiate error:",
      err.message,
      err.response?.data
    );
    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.error?.message ||
        "Server error initiating Pesapal payment. Please try again later.",
    });
  }
});

async function handlePesapalCallback(req, res) {
  const {
    OrderTrackingId,
    OrderMerchantReference,
    OrderNotificationType,
  } = req.query;

  if (!OrderTrackingId) {
    return res
      .status(400)
      .send("Invalid Pesapal callback: Missing OrderTrackingId.");
  }

  const payments = getPendingPayment(req);
  let matchedOrderId = null;
  let pending = null;

  for (const [orderId, data] of Object.entries(payments)) {
    if (
      data.orderTrackingId === OrderTrackingId ||
      orderId === OrderMerchantReference ||
      data.merchantReference === OrderMerchantReference
    ) {
      matchedOrderId = orderId;
      pending = data;
      break;
    }
  }

  if (!pending || !matchedOrderId) {
    console.warn(
      "Pesapal callback: Could not find pending payment for tracking id:",
      OrderTrackingId
    );
    return res.redirect(
      "/register?message=Payment%20session%20not%20found.%20Please%20try%20again."
    );
  }

  try {
    const statusResult = await getTransactionStatus(OrderTrackingId);
    const statusCode = statusResult?.status_code;
    const paymentStatusDescription = statusResult?.payment_status_description || "";
    const chargedAmount = Number(statusResult?.amount || pending.amount || 0);
    const currency = String(statusResult?.currency || "KES").toUpperCase();

    console.log(
      `[Pesapal Callback] Order=${matchedOrderId} status_code=${statusCode} desc=${paymentStatusDescription} amount=${chargedAmount} currency=${currency}`
    );

    const expectedAmount = Number(pending.expectedAmount ?? pending.amount ?? 0);
    const amountOk = moneyEq(chargedAmount, expectedAmount, 0);
    const currencyOk = currency === "KES" || currency === "";

    if (isSuccessStatus(statusCode) && amountOk && currencyOk) {
      clearPendingPayment(req, matchedOrderId);
      const verificationNonce = crypto.randomBytes(24).toString("hex");
      const createdAt = Date.now();

      let userData = {};
      try {
        userData =
          typeof pending.registrationData === "string"
            ? JSON.parse(pending.registrationData)
            : pending.registrationData || {};
      } catch (_e) { userData = {}; }

      const phoneNumber =
        userData.phoneNumber ||
        userData.PhoneNumber ||
        userData.phone ||
        "";

      setVerifiedRegistration(req, verificationNonce, {
        nonce: verificationNonce,
        createdAt,
        expiresAt: createdAt + 20 * 60 * 1000,
        orderId: matchedOrderId,
        orderTrackingId: String(OrderTrackingId || ""),
        amount: expectedAmount,
        chargedAmount,
        currency,
        statusCode,
        paymentStatusDescription,
        phoneNumber: String(phoneNumber || ""),
        registrationData: pending.registrationData,
      });

      const rdEscaped = String(pending.registrationData || "{}")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Completing Registration...</title>
            <style>
              body {
                font-family: Inter, Arial, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: #f4f6f9;
                color: #0b1f3a;
              }
              .box {
                background: white;
                padding: 32px 40px;
                border-radius: 14px;
                box-shadow: 0 20px 45px -18px rgba(11, 31, 58, 0.25);
                text-align: center;
                max-width: 420px;
              }
              .spinner {
                width: 36px;
                height: 36px;
                border: 4px solid #e2e8f0;
                border-top-color: #0f9d58;
                border-radius: 50%;
                margin: 0 auto 18px;
                animation: spin 0.9s linear infinite;
              }
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            </style>
          </head>
          <body>
            <div class="box">
              <div class="spinner"></div>
              <h3>Payment Successful!</h3>
              <p>Completing your registration, please wait...</p>
            </div>
            <form id="completeForm" action="/complete-registration" method="POST">
              <input type="hidden" name="registrationData" value="${rdEscaped}">
              <input type="hidden" name="paymentConfirmed" value="true">
              <input type="hidden" name="paymentProvider" value="pesapal">
              <input type="hidden" name="__verification_nonce" value="${verificationNonce}">
              <input type="hidden" name="passkey" value="">
            </form>
            <script>
              document.getElementById('completeForm').submit();
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (isSuccessStatus(statusCode) && (!amountOk || !currencyOk)) {
      console.error(
        `[Pesapal Callback] FRAUD SUSPICION: status=COMPLETED but amount/currency mismatch. ` +
          `expectedAmount=${expectedAmount} chargedAmount=${chargedAmount} expectedCurrency=KES chargedCurrency=${currency}. orderId=${matchedOrderId}. Clearing session.`
      );
      clearPendingPayment(req, matchedOrderId);
      const msg = encodeURIComponent(
        "Payment verification mismatch. Please contact support if you have already been charged. Do NOT submit multiple duplicate forms."
      );
      return res.redirect(`/register?message=${msg}`);
    }

    if (isTerminalFailure(statusCode)) {
      clearPendingPayment(req, matchedOrderId);
      const msg = encodeURIComponent(
        `Pesapal payment failed: ${paymentStatusDescription || "Transaction was not completed."} Please try again.`
      );
      return res.redirect(`/register?message=${msg}`);
    }

    const msg = encodeURIComponent(
      `Pesapal payment is still processing. Status: ${
        paymentStatusDescription || "Pending"
      }. Please wait a moment then try registering again.`
    );
    return res.redirect(`/register?message=${msg}`);
  } catch (err) {
    console.error("Pesapal callback error:", err.message);
    const msg = encodeURIComponent(
      "Server error verifying Pesapal payment. Please try again later."
    );
    return res.redirect(`/register?message=${msg}`);
  }
}

function hasPendingTrackingId(req, orderTrackingId) {
  if (!orderTrackingId) return false;
  const payments = getPendingPayment(req) || {};
  for (const data of Object.values(payments)) {
    if (data && data.orderTrackingId === orderTrackingId) return true;
    if (data && data.merchantReference && (
      data.merchantReference === orderTrackingId
    )) return true;
  }
  return false;
}

async function handlePesapalIpnGet(req, res) {
  const { OrderTrackingId, OrderNotificationType } = req.query;
  const envSecret = process.env.PESAPAL_IPN_SECRET || "";
  const suppliedSecret = String(req.query.ipn_secret || req.query.secret || "");
  if (envSecret && suppliedSecret !== envSecret) {
    console.warn(
      "[Pesapal IPN (GET)] Ignoring request without matching IPN secret (configured in PESAPAL_IPN_SECRET).",
      "OTID=", OrderTrackingId
    );
    return res.status(204).end();
  }
  console.log(
    `[Pesapal IPN (GET)] OrderTrackingId=${OrderTrackingId} Type=${OrderNotificationType}`
  );

  if (OrderTrackingId && hasPendingTrackingId(req, OrderTrackingId)) {
    try {
      const status = await getTransactionStatus(OrderTrackingId);
      console.log(
        `[Pesapal IPN] Verified status for ${OrderTrackingId}:`,
        status?.payment_status_description,
        "code:",
        status?.status_code
      );
    } catch (err) {
      console.error("[Pesapal IPN] Verify status error:", err.message);
    }
  }

  res.status(200).end();
}

async function handlePesapalIpnPost(req, res) {
  const body = req.body || {};
  const OrderTrackingId = body.OrderTrackingId || body.order_tracking_id;
  const envSecret = process.env.PESAPAL_IPN_SECRET || "";
  const suppliedSecret = String(
    body.ipn_secret ||
    body.secret ||
    req.query.ipn_secret ||
    req.query.secret ||
    ""
  );
  if (envSecret && suppliedSecret !== envSecret) {
    console.warn(
      "[Pesapal IPN (POST)] Ignoring request without matching IPN secret.",
      "OTID=", OrderTrackingId
    );
    return res.status(204).end();
  }
  console.log(`[Pesapal IPN (POST)] payload:`, body);

  if (OrderTrackingId && hasPendingTrackingId(req, OrderTrackingId)) {
    try {
      const status = await getTransactionStatus(OrderTrackingId);
      console.log(
        `[Pesapal IPN (POST)] Verified status for ${OrderTrackingId}:`,
        status?.payment_status_description,
        "code:",
        status?.status_code
      );
    } catch (err) {
      console.error("[Pesapal IPN (POST)] Verify status error:", err.message);
    }
  }

  res.status(200).json({ success: true });
}

router.get("/callback", handlePesapalCallback);

router.get("/ipn", handlePesapalIpnGet);

router.post("/ipn", handlePesapalIpnPost);

router.post("/register-ipn", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const { ipnUrl, notificationType } = req.body;
    if (!ipnUrl && !envIpnUrl) {
      return res
        .status(400)
        .json({ success: false, message: "IPN URL is required." });
    }
    const result = await registerIpnUrl(
      ipnUrl || envIpnUrl,
      notificationType || "GET"
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Pesapal register IPN error:", err.message);
    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.error?.message ||
        "Failed to register Pesapal IPN URL.",
    });
  }
});

router.get("/ipn-list", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const list = await getIpnList();
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error("Pesapal get IPN list error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to list Pesapal IPNs.",
    });
  }
});

router.post("/ensure-ipn", requireAdminOrInternalSecret, async (req, res) => {
  try {
    const { preferredNotifType, writeFile, log } = req.body || {};
    const result = await ensureValidIpn({
      preferredNotifType: preferredNotifType || "POST",
      writeFile: writeFile !== false,
      log: log === true,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Pesapal ensure-ipn error:", err?.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: err?.response?.data?.error?.message || err.message || "Failed to ensure a valid Pesapal IPN configuration.",
      raw: err?.response?.data || null,
    });
  }
});

module.exports = router;
module.exports.handlePesapalCallback = handlePesapalCallback;
module.exports.handlePesapalIpnGet = handlePesapalIpnGet;
module.exports.handlePesapalIpnPost = handlePesapalIpnPost;
module.exports.ensureValidIpn = ensureValidIpn;
module.exports.runColdStartVerification = runColdStartVerification;
module.exports.writeEnvWithIpnId = writeEnvWithIpnId;
module.exports.readEnvFile = readEnvFile;
module.exports.ENV_PATH = ENV_PATH;
module.exports.consumeVerifiedRegistration = consumeVerifiedRegistration;
module.exports.requireAdminOrInternalSecret = requireAdminOrInternalSecret;

async function runCliSetup() {
  try {
    require("dotenv").config({ override: true });
    console.log("== Step 0: Loaded env from .env (override mode) ==");
    console.log("  PESAPAL_ENVIRONMENT  =", process.env.PESAPAL_ENVIRONMENT);
    console.log("  PESAPAL_CONSUMER_KEY starts with =", (process.env.PESAPAL_CONSUMER_KEY || "").slice(0, 6) + "...");
    console.log("  PESAPAL_IPN_URL      =", process.env.PESAPAL_IPN_URL);
    console.log("  PESAPAL_IPN_ID       =", process.env.PESAPAL_IPN_ID);

    const result = await ensureValidIpn({
      preferredNotifType: "POST",
      writeFile: true,
      log: true,
    });

    console.log("\n== Summary ==");
    console.log("  Action taken       :", result.actionTaken);
    console.log("  Final IPN ID       :", result.ipnId);
    console.log("  Final IPN URL      :", result.ipnUrl);
    console.log("  IPN notif. type    :", result.preferredNotifType);
    console.log("  .env file updated  :", result.envWritten, " at ", result.envPath);

    console.log("\n== Step 5: Cold-start verification (fresh node process) ==");
    const code = await runColdStartVerification(result.ipnId);
    if (code !== 0) {
      console.log("\n❌ Cold-start verification did not pass, exit code:", code);
      process.exit(code || 7);
    }

    console.log("\nDone. Restart the server (kill old + run npm start / nodemon) so dotenv re-reads .env with override:true.");
    process.exit(0);
  } catch (err) {
    console.error("❌ CLI setup failed:", err?.response?.data || err?.message || err);
    process.exit(99);
  }
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--setup-ipn") || args.includes("setup-ipn") || args.length === 0) {
    runCliSetup();
  } else {
    console.log("routes/pesapal.js — usage:");
    console.log("  node routes/pesapal.js --setup-ipn    Run the Pesapal IPN validator/registrar + write IPN ID to .env");
    process.exit(1);
  }
}
