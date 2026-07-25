/* Installable-app plumbing, kept out of app.js on purpose: everything in
   here is about the window the app sits in, not the record it reads.

   Two jobs.

   1. Register the service worker — but only in a secure context. On a
      plain-HTTP LAN share (the --share path, and the DC-1 over Wi-Fi
      without Tailscale) `navigator.serviceWorker` is absent by browser
      design; asking anyway is how you earn a console error and an
      offline promise you cannot keep. No network, no noise: the outcome
      is recorded on window.__pwa instead of the console, which is also
      the deterministic hook for verification.

   2. Keep the OS chrome the same paper as the page. The manifest's
      theme_color is the vellum token, but calm/amber mode repaints the
      body warmer — on an e-ink panel a status bar that disagrees with
      the sheet under it is a visible seam, so the meta tag follows the
      body's own computed background. */

const state = {
  secure: !!window.isSecureContext,
  supported: "serviceWorker" in navigator,
  registered: false,
  scope: null,
  reason: null,
};
window.__pwa = state;

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const paper = getComputedStyle(document.body).backgroundColor;
  if (paper && paper !== "rgba(0, 0, 0, 0)" && meta.content !== paper) {
    meta.content = paper;
  }
}

function watchPaper() {
  syncThemeColor();
  if (typeof MutationObserver !== "function") return;
  new MutationObserver(syncThemeColor).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", watchPaper, { once: true });
} else {
  watchPaper();
}

if (!state.supported) {
  state.reason = state.secure ? "unsupported" : "insecure-context";
} else if (!state.secure) {
  state.reason = "insecure-context";
} else {
  /* the static demo ships no service worker: its navigation handler
     answers every navigation from the cached index.html, which would
     serve the app in place of guide.html on a real origin. */
  state.reason = "demo-no-service-worker";
}
