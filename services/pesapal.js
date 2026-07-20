const axios = require("axios");
const pesapal = require("../config/pesapal");

const BASE_URL =
  pesapal.environment === "live"
    ? "https://pay.pesapal.com/v3"
    : "https://cybqa.pesapal.com/pesapalv3";

async function getAccessToken() {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/Auth/RequestToken`,
      {
        consumer_key: pesapal.consumerKey,
        consumer_secret: pesapal.consumerSecret,
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

module.exports = {
  getAccessToken,
};
