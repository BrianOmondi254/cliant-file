/**
 * Firebase config (server) + browser bootstrap helpers.
 * Env vars: FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, etc.
 */

function getFirebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || "",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || "",
  };
}

function isFirebaseConfigured(cfg = getFirebaseConfig()) {
  return !!(cfg && cfg.apiKey && cfg.projectId);
}

/**
 * Browser-safe init (also available at /js/firebase-client.js).
 * Uses window.__FIREBASE_CONFIG__ injected by the server.
 */
const browserBootstrap = `(function () {
  function readConfig() {
    if (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) {
      return window.__FIREBASE_CONFIG__;
    }
    return null;
  }

  function isConfigured(cfg) {
    return !!(cfg && cfg.apiKey && cfg.projectId);
  }

  window.initFirebase = function () {
    try {
      var cfg = readConfig();
      if (!isConfigured(cfg)) {
        console.warn("[firebase] No valid config provided; skipping init.");
        return null;
      }
      if (window.__firebaseAppInstance__) return window.__firebaseAppInstance__;
      if (!window.firebase || !window.firebase.initializeApp) {
        console.warn("[firebase] SDK (window.firebase) not loaded; skipping init.");
        return null;
      }
      var app = window.firebase.initializeApp(cfg);
      window.__firebaseAppInstance__ = app;
      try {
        if (window.firebase.analytics) {
          window.__firebaseAnalytics = window.firebase.analytics();
        }
      } catch (e) {
        console.warn("[firebase] analytics init skipped:", e);
      }
      return app;
    } catch (e) {
      console.warn("[firebase] init failed; continuing without Firebase:", e);
      return null;
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", function () {
      try { window.initFirebase(); } catch (e) { /* never break the page */ }
    });
  }
})();`;

module.exports = {
  getFirebaseConfig,
  isFirebaseConfigured,
  browserBootstrap,
  get firebaseConfig() {
    return getFirebaseConfig();
  },
};
