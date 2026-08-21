const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const { creditWalletTopUp } = require("../routes/trans");
const { applyAtomicGroupMemberContribution } = require("../mongoose");

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

/** CheckoutRequestID → pending wallet top-up meta */
const pendingWalletTopups = new Map();
const creditedCheckoutIds = new Set();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of pendingWalletTopups.entries()) {
    if ((val.initiatedAtMs || 0) < cutoff) pendingWalletTopups.delete(key);
  }
}, 15 * 60 * 1000);

async function applyWalletTopUpFromPending(checkoutId, overrides = {}) {
  const id = String(checkoutId || "");
  if (!id || creditedCheckoutIds.has(id)) {
    return { success: false, reason: "ALREADY_CREDITED_OR_MISSING" };
  }
  const pending = pendingWalletTopups.get(id);
  if (!pending) {
    return { success: false, reason: "NO_PENDING" };
  }

  if (pending.purpose === "group_contribution") {
    creditedCheckoutIds.add(id);
    pendingWalletTopups.delete(id);
    try {
      return await applyAtomicGroupMemberContribution({
        groupName: pending.groupName,
        memberPhone: pending.creditPhone,
        accountId: pending.accountId || "001",
        accountName: pending.accountName || "",
        amount: overrides.amount != null ? overrides.amount : pending.amount,
        reference: overrides.reference || id,
        paymentMethod: "mpesa",
        payerPhone: pending.payerPhone,
      });
    } catch (e) {
      creditedCheckoutIds.delete(id);
      throw e;
    }
  }

  if (pending.purpose !== "wallet_topup") {
    return { success: false, reason: "NO_PENDING" };
  }
  creditedCheckoutIds.add(id);
  pendingWalletTopups.delete(id);
  try {
    return await creditWalletTopUp({
      phone: pending.creditPhone,
      amount: overrides.amount != null ? overrides.amount : pending.amount,
      reference: overrides.reference || id,
      paymentMethod: "mpesa",
      payerPhone: pending.payerPhone,
      notes: overrides.notes || "Wallet Add Fund via M-Pesa STK",
    });
  } catch (e) {
    creditedCheckoutIds.delete(id);
    throw e;
  }
}

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

async function getAccessToken() {
  const auth = Buffer.from(`${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`).toString("base64");

  const response = await fetch(mpesaConfig.authUrl, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });

  const data = await response.json();
  return data.access_token;
}

router.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, reference, description, purpose, accountPhone } = req.body;
    const accessToken = await getAccessToken();

    const isWalletTopup = String(purpose || "").toLowerCase() === "wallet_topup";
    if (isWalletTopup) {
      const { paymentMethod, source } = await loadPaymentMethod();
      if (paymentMethod !== "mpesa") {
        return res.status(400).json({
          success: false,
          message: `M-Pesa is not the active payment method (source=${source}, method=${paymentMethod}).`,
          paymentMethod,
        });
      }
      const sessionUser = req.session && req.session.user;
      if (!sessionUser || !sessionUser.phoneNumber) {
        return res.status(401).json({ success: false, message: "Please log in to add funds." });
      }
    }

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

    const response = await fetch(mpesaConfig.stkPushUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    const isSuccess = data && data.ResponseCode === "0";

    const isGroupContribution = String(purpose || "").toLowerCase() === "group_contribution";

    if (isSuccess && isWalletTopup && data.CheckoutRequestID) {
      const creditPhone = String(
        accountPhone ||
        (req.session && req.session.user && req.session.user.phoneNumber) ||
        phone
      ).trim();
      pendingWalletTopups.set(String(data.CheckoutRequestID), {
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
      pendingWalletTopups.set(String(data.CheckoutRequestID), {
        purpose: "group_contribution",
        groupName: groupName || "",
        accountId: accountId || "001",
        accountName: accountName || "",
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
      const pending = checkoutId ? pendingWalletTopups.get(checkoutId) : null;

      if (pending && resultCode === 0) {
        let paidAmount = pending.amount;
        let mpesaReceipt = "";
        const items = (body.CallbackMetadata && body.CallbackMetadata.Item) || [];
        for (const item of items) {
          if (item.Name === "Amount") paidAmount = Number(item.Value) || paidAmount;
          if (item.Name === "MpesaReceiptNumber") mpesaReceipt = String(item.Value || "");
        }

        const txRes = await applyWalletTopUpFromPending(checkoutId, {
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
        pendingWalletTopups.delete(checkoutId);
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

    const response = await fetch(mpesaConfig.stkQueryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // If STK query reports success and we still have a pending top-up, credit now
    const resultCode = data && (data.ResultCode !== undefined ? Number(data.ResultCode) : null);
    if (resultCode === 0) {
      try {
        const txRes = await applyWalletTopUpFromPending(checkoutId, {
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