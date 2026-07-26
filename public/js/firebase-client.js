// Firebase client bootstrap (browser-safe).
// Prefer config injected as window.__FIREBASE_CONFIG__ from the server
// (see config/firebase.js → getFirebaseConfig).

(function () {
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

  if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", function () {
      try { window.initFirebase(); } catch (e) { /* never break the page */ }
    });
  }
})();
