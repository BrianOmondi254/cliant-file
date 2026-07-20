require("dotenv").config();

module.exports = {
  environment: process.env.PESAPAL_ENVIRONMENT || "sandbox",
  consumerKey: process.env.PESAPAL_CONSUMER_KEY,
  consumerSecret: process.env.PESAPAL_CONSUMER_SECRET,
};
