// Firebase client bootstrap (browser-safe).
// Loads Firebase only from a CDN global (window.firebase) so it never breaks
// the page if the SDK or config is missing. Uses window.__FIREBASE_CONFIG__
// (injected by the server into cliant.ejs) and falls back to guarded env vars
// when running under Node/bundler.

(function () {
  function readConfig() {
    // Prefer the server-injected config.
    if (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) {
      return window.__FIREBASE_CONFIG__;
    }
    // Guarded fallback for Node/bundler contexts.
    if (typeof process !== "undefined" && process.env) {
      return {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
        measurementId: process.env.FIREBASE_MEASUREMENT_ID
      };
    }
    return null;
  }

  function isConfigured(cfg) {
    return !!(cfg && cfg.apiKey && cfg.projectId);
  }

  // Exposed globally so views (e.g. cliant.ejs) can initialise.firebase
  // without risk of crashing the page.
  window.initFirebase = function () {
    try {
      const cfg = readConfig();
      if (!isConfigured(cfg)) {
        console.warn("[firebase] No valid config provided; skipping init.");
        return null;
      }
      if (window.__firebaseAppInstance__) return window.__firebaseAppInstance__;
      if (!window.firebase || !window.firebase.initializeApp) {
        console.warn("[firebase] SDK (window.firebase) not loaded; skipping init.");
        return null;
      }
      const app = window.firebase.initializeApp(cfg);
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

  // Auto-init when the SDK is present (e.g. via CDN script tag).
  if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", function () {
      try { window.initFirebase(); } catch (e) { /* never break the page */ }
    });
  }
})();
