const axios = require("axios");

const ALLOWED_NOTIF_TYPES = new Set(["GET", "POST"]);

function assertHttpsUrl(input, label) {
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch (e) {
    throw new Error(`${label} is not a valid URL: ${input}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS (received ${parsed.protocol})`);
  }
  return parsed.toString();
}

const pesapalConfig = {
  environment: process.env.PESAPAL_ENVIRONMENT || "sandbox",
  consumerKey: process.env.PESAPAL_CONSUMER_KEY || "",
  consumerSecret: process.env.PESAPAL_CONSUMER_SECRET || "",
  callbackUrl: process.env.PESAPAL_CALLBACK_URL || "",
  ipnUrl: process.env.PESAPAL_IPN_URL || "",
  ipnId: process.env.PESAPAL_IPN_ID || "",
  ipnSecret: process.env.PESAPAL_IPN_SECRET || "",
};

const BASE_URL =
  pesapalConfig.environment === "live"
    ? "https://pay.pesapal.com/v3"
    : "https://cybqa.pesapal.com/pesapalv3";

async function getAccessToken() {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/Auth/RequestToken`,
      {
        consumer_key: pesapalConfig.consumerKey,
        consumer_secret: pesapalConfig.consumerSecret,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Pesapal Token Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

async function registerIpnUrl(ipnUrl, notificationType = "GET") {
  try {
    const auth = await getAccessToken();
    const safeUrl = assertHttpsUrl(ipnUrl, "IPN URL");
    const notif = String(notificationType || "GET").toUpperCase();
    if (!ALLOWED_NOTIF_TYPES.has(notif)) {
      throw new Error(`Invalid notificationType: ${notif}. Must be GET or POST.`);
    }
    const response = await axios.post(
      `${BASE_URL}/api/URLSetup/RegisterIPN`,
      {
        url: safeUrl,
        ipn_notification_type: notif,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Pesapal Register IPN Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

async function getIpnList() {
  try {
    const auth = await getAccessToken();
    const response = await axios.get(
      `${BASE_URL}/api/URLSetup/GetIpnList`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Pesapal Get IPN List Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * requestPayment — alias used by wallet Add Fund / collection flows.
 * Wraps Pesapal SubmitOrderRequest.
 */
async function requestPayment(orderData, options = {}) {
  return submitOrderRequest(orderData, options);
}

async function submitOrderRequest(orderData, options = {}) {
  try {
    const auth = await getAccessToken();
    const safeCallbackUrl = orderData.callbackUrl
      ? assertHttpsUrl(orderData.callbackUrl, "Callback URL")
      : pesapalConfig.callbackUrl;
    const payload = {
      id: orderData.id,
      currency: orderData.currency || "KES",
      amount: orderData.amount,
      description: orderData.description || "Cliant Payment",
      callback_url: safeCallbackUrl,
      branch: orderData.branch || "",
      billing_address: orderData.billingAddress || {
        phone_number: orderData.phoneNumber || "",
        email_address: orderData.email || "",
        first_name: orderData.firstName || "",
        middle_name: orderData.middleName || "",
        last_name: orderData.lastName || "",
        line_1: orderData.line1 || "",
        line_2: orderData.line2 || "",
        city: orderData.city || "",
        state: orderData.state || "",
        postal_code: orderData.postalCode || "",
        zip_code: orderData.zipCode || "",
        country_code: orderData.countryCode || "KE",
      },
    };

    const notificationId = options.skipNotificationId
      ? null
      : (orderData.notificationId || pesapalConfig.ipnId);

    if (notificationId && String(notificationId).trim()) {
      payload.notification_id = String(notificationId).trim();
    }

    const response = await axios.post(
      `${BASE_URL}/api/Transactions/SubmitOrderRequest`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Pesapal Submit Order Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

async function getTransactionStatus(orderTrackingId) {
  try {
    if (!orderTrackingId || typeof orderTrackingId !== "string" || !orderTrackingId.trim()) {
      throw new Error("orderTrackingId is required for getTransactionStatus");
    }
    const auth = await getAccessToken();
    const response = await axios.get(
      `${BASE_URL}/api/Transactions/GetTransactionStatus`,
      {
        params: { orderTrackingId: orderTrackingId },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Pesapal Transaction Status Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

module.exports = {
  ...pesapalConfig,
  BASE_URL,
  getAccessToken,
  registerIpnUrl,
  getIpnList,
  submitOrderRequest,
  requestPayment,
  getTransactionStatus,
};
