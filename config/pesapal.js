const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const pesapal = require("./pesapal");

const BASE_URL =
  pesapal.environment === "live"
    ? "https://pay.pesapal.com/v3"
    : "https://cybqa.pesapal.com/pesapalv3";

/**
 * Get Access Token
 */
async function getAccessToken() {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/Auth/RequestToken`,
      {
        consumer_key: pesapal.consumerKey,
        consumer_secret: pesapal.consumerSecret,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    return response.data.token;
  } catch (error) {
    console.error(
      "Pesapal Authentication Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Register IPN
 * Only run this once if you don't already have an IPN ID.
 */
async function registerIPN() {
  const token = await getAccessToken();

  try {
    const response = await axios.post(
      `${BASE_URL}/api/URLSetup/RegisterIPN`,
      {
        url: pesapal.ipnUrl,
        ipn_notification_type: "GET",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Register IPN Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Submit Order
 */
async function submitOrder({
  phone,
  amount,
  firstName = "Customer",
  lastName = "User",
  email = "customer@tbank.local",
  description = "T-BANK Payment",
}) {
  const token = await getAccessToken();

  const payload = {
    id: uuidv4(),
    currency: "KES",
    amount: Number(amount),
    description,

    callback_url: pesapal.callbackUrl,

    notification_id: pesapal.ipnId,

    billing_address: {
      phone_number: phone,
      email_address: email,
      first_name: firstName,
      last_name: lastName,
      line_1: "Kenya",
      line_2: "",
      city: "Nairobi",
      state: "Nairobi",
      postal_code: "00100",
      zip_code: "00100",
      country_code: "KE",
    },
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/api/Transactions/SubmitOrderRequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Submit Order Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Get Transaction Status
 */
async function getTransactionStatus(orderTrackingId) {
  const token = await getAccessToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Transaction Status Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Get Merchant IPNs
 */
async function getRegisteredIPNs() {
  const token = await getAccessToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/URLSetup/GetIpnList`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "Get IPNs Error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

module.exports = {
  getAccessToken,
  registerIPN,
  submitOrder,
  getTransactionStatus,
  getRegisteredIPNs,
};