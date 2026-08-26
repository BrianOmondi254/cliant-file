const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const {
  setMpesaPending,
  getMpesaPending,
  clearMpesaPending,
  applyVerifiedMpesaPayment,
} = require("../routes/trans");

const mpesaConfig = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || "",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "",
  shortcode: process.env.MPESA_SHORTCODE || "",
  passkey: process.env.MPESA_PASSKEY || "",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "",
  authUrl: "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
  stkPushUrl: "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
  stkQueryUrl: "https://sandbox.safaricom.co.ke/mpesa/stkquery/v1/query",
};

function toMpesaPhone(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 10) d = "254" + d.slice(1);
  else if (d.length === 9) d = "254" + d;
  return d;
}

async function loadPaymentMethod() {
  try {
    const { getTbankSettings } = require("../mongoose");
    const tbankSettings = await getTbankSettings();
    const reg = tbankSettings?.compliance?.personal_account_registration;
    if (reg?.paymentMethod) {
      return { paymentMethod: String(reg.paymentMethod).toLowerCase(), source: "mongodb" };
    }
  } catch (_e) { /* fall through */ }
  try {
    const tbankFile = path.resolve(__dirname, "..", "tbank.json");
    if (fs.existsSync(tbankFile)) {
      const raw = JSON.parse(fs.readFileSync(tbankFile, "utf8"));
      const reg = raw?.compliance?.personal_account_registration;
      if (reg?.paymentMethod) {
        return { paymentMethod: String(reg.paymentMethod).toLowerCase(), source: "tbank.json" };
      }
    }
  } catch (_e) { /* fall through */ }
  return { paymentMethod: "none", source: "none" };
}

async function safeJsonParse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch (_e) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(
      response.ok
        ? `M-Pesa API returned a non-JSON response. Please check your credentials or try again later.`
        : `M-Pesa API request failed (HTTP ${response.status}). ${snippet ? "Response: " + snippet : ""}`
    );
  }
}

function validateMpesaCredentials() {
  if (!mpesaConfig.consumerKey || !mpesaConfig.consumerSecret) {
    throw new Error("M-Pesa credentials are not configured on this server. Please contact the administrator to set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET.");
  }
  if (!mpesaConfig.shortcode || !mpesaConfig.passkey) {
    throw new Error("M-Pesa shortcode or passkey is not configured. Please contact the administrator to set MPESA_SHORTCODE and MPESA_PASSKEY.");
  }
}

async function getAccessToken() {
  validateMpesaCredentials();

  const auth = Buffer.from(`${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`).toString("base64");

  let response;
  try {
    response = await fetch(mpesaConfig.authUrl, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (netErr) {
    throw new Error("Could not connect to M-Pesa authentication server. Please check your internet connection or try again later.");
  }

  const data = await safeJsonParse(response);
  if (!response.ok || !data.access_token) {
    const msg = data.errorMessage || data.error || `HTTP ${response.status}`;
    throw new Error(`M-Pesa authentication failed: ${msg}. Please verify your MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET.`);
  }
  return data.access_token;
}

router.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, reference, description, purpose, accountPhone, accounts } = req.body;

    const { paymentMethod, source } = await loadPaymentMethod();
    if (paymentMethod !== "mpesa") {
      return res.status(400).json({
        success: false,
        message: `M-Pesa is not the active payment method on this server (source=${source}, method=${paymentMethod || "none"}).`,
        paymentMethod: paymentMethod || "none",
      });
    }

    const sessionUser = req.session && req.session.user;
    if (!sessionUser || !sessionUser.phoneNumber) {
      return res.status(401).json({ success: false, message: "Please log in to proceed with payment." });
    }

    const isWalletTopup = String(purpose || "").toLowerCase() === "wallet_topup";

    const accessToken = await getAccessToken();

    const mpesaPhone = toMpesaPhone(phone);
    if (!mpesaPhone || mpesaPhone.length < 12) {
      return res.status(400).json({ success: false, message: "Invalid M-Pesa phone number." });
    }

    const payAmount = Math.round(Number(amount));
    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount." });
    }

    const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);
    const password = Buffer.from(`${mpesaConfig.shortcode}${mpesaConfig.passkey}${timestamp}`).toString("base64");

    const payload = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: payAmount,
      PartyA: mpesaPhone,
      PartyB: mpesaConfig.shortcode,
      PhoneNumber: mpesaPhone,
      CallBackURL: mpesaConfig.callbackUrl,
      AccountReference: reference || (isWalletTopup ? "Wallet Top-up" : "Tbank Agent"),
      TransactionDesc: description || (isWalletTopup ? "Cliant Wallet Add Fund" : "Agent Payment Request"),
    };

    let response;
    try {
      response = await fetch(mpesaConfig.stkPushUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      throw new Error("Could not connect to M-Pesa STK push server. Please check your internet connection or try again later.");
    }

    const data = await safeJsonParse(response);

    const isSuccess = data && data.ResponseCode === "0";

    const isGroupContribution = String(purpose || "").toLowerCase() === "group_contribution";

    if (isSuccess && isWalletTopup && data.CheckoutRequestID) {
      const creditPhone = String(
        accountPhone ||
        (req.session && req.session.user && req.session.user.phoneNumber) ||
        phone
      ).trim();
      await setMpesaPending(String(data.CheckoutRequestID), {
        purpose: "wallet_topup",
        creditPhone,
        payerPhone: mpesaPhone,
        amount: payAmount,
        initiatedAtMs: Date.now(),
        MerchantRequestID: data.MerchantRequestID || null,
      });
    } else if (isSuccess && isGroupContribution && data.CheckoutRequestID) {
      const { groupName, accountId, accountName, memberPhone } = req.body;
      const creditPhone = String(
        memberPhone ||
        accountPhone ||
        (req.session && req.session.user && req.session.user.phoneNumber) ||
        phone
      ).trim();
      await setMpesaPending(String(data.CheckoutRequestID), {
        purpose: "group_contribution",
        groupName: groupName || "",
        accountId: accountId || "001",
        accountName: accountName || "",
        accounts: Array.isArray(accounts) ? accounts : [],
        creditPhone,
        payerPhone: mpesaPhone,
        amount: payAmount,
        initiatedAtMs: Date.now(),
        MerchantRequestID: data.MerchantRequestID || null,
      });
    }

    res.json({
      success: isSuccess,
      ResponseCode: data && data.ResponseCode,
      ResponseDescription: data && data.ResponseDescription,
      MerchantRequestID: data && data.MerchantRequestID,
      CheckoutRequestID: data && data.CheckoutRequestID,
      CustomerMessage: data && data.CustomerMessage,
      paymentMethod: "mpesa",
      message: (data && data.ResponseDescription) || (isSuccess ? "STK push initiated" : "Payment initiation failed"),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/callback", async (req, res) => {
  const callbackData = req.body;
  console.log("M-Pesa Callback:", JSON.stringify(callbackData, null, 2));

  const filePath = path.join(__dirname, "../mpesa-callbacks.json");
  try {
    const existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
    existingData.push(callbackData);
    fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
  } catch (e) {
    console.error("[M-Pesa] Failed to persist callback file:", e.message);
  }

  try {
    const body = callbackData && callbackData.Body && callbackData.Body.stkCallback;
    if (body) {
      const checkoutId = String(body.CheckoutRequestID || "");
      const resultCode = Number(body.ResultCode);
      const pending = checkoutId ? getMpesaPending(checkoutId) : null;

      if (pending && resultCode === 0) {
        let paidAmount = pending.amount;
        let mpesaReceipt = "";
        const items = (body.CallbackMetadata && body.CallbackMetadata.Item) || [];
        for (const item of items) {
          if (item.Name === "Amount") paidAmount = Number(item.Value) || paidAmount;
          if (item.Name === "MpesaReceiptNumber") mpesaReceipt = String(item.Value || "");
        }

        const txRes = await applyVerifiedMpesaPayment(checkoutId, {
          amount: paidAmount,
          reference: mpesaReceipt || checkoutId,
          notes: `M-Pesa STK payment (${pending.purpose || "transaction"})`,
        });
        console.log(
          `[M-Pesa Callback] Processed ${pending.purpose} for ${pending.creditPhone}:`,
          txRes.success ? `OK` : txRes.reason
        );
      } else if (pending && resultCode !== 0) {
        console.warn(`[M-Pesa Callback] Payment failed ResultCode=${resultCode} Desc=${body.ResultDesc}`);
        clearMpesaPending(checkoutId);
      }
    }
  } catch (cbErr) {
    console.error("[M-Pesa Callback] Processing error:", cbErr.message);
  }

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

router.get("/status/:checkoutId", async (req, res) => {
  try {
    const { checkoutId } = req.params;
    const accessToken = await getAccessToken();

    const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);
    const password = Buffer.from(`${mpesaConfig.shortcode}${mpesaConfig.passkey}${timestamp}`).toString("base64");

    const payload = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutId,
    };

    let response;
    try {
      response = await fetch(mpesaConfig.stkQueryUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      throw new Error("Could not connect to M-Pesa status server. Please try again later.");
    }

    const data = await safeJsonParse(response);

    // If STK query reports success and we still have a pending top-up, credit now
    const resultCode = data && (data.ResultCode !== undefined ? Number(data.ResultCode) : null);
    if (resultCode === 0) {
      try {
        const txRes = await applyVerifiedMpesaPayment(checkoutId, {
          notes: "M-Pesa STK (status poll)",
        });
        if (txRes && txRes.success) data._txResult = txRes;
      } catch (e) {
        console.error("[M-Pesa status] processing error:", e.message);
      }
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/transactions", (req, res) => {
  const filePath = path.join(__dirname, "../mpesa-callbacks.json");
  const data = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
  res.json(data);
});

module.exports = router;