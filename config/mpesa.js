const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

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
    const { phone, amount, reference, description } = req.body;
    const accessToken = await getAccessToken();
    
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);
    const password = Buffer.from(`${mpesaConfig.shortcode}${mpesaConfig.passkey}${timestamp}`).toString("base64");
    
    const payload = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: mpesaConfig.shortcode,
      PhoneNumber: phone,
      CallBackURL: mpesaConfig.callbackUrl,
      AccountReference: reference,
      TransactionDesc: description,
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
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/callback", (req, res) => {
  const callbackData = req.body;
  console.log("M-Pesa Callback:", JSON.stringify(callbackData, null, 2));
  
  const filePath = path.join(__dirname, "../mpesa-callbacks.json");
  const existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
  existingData.push(callbackData);
  fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
  
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