// Android counterpart of content/bridge.js: relays sdr-main.js reports to the app.
// Commands from the app arrive as window.postMessage(..., dir: 'to-page') directly.
(() => {
  'use strict';
  const TAG = '__sdr_radio_sync__';
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== TAG || d.dir !== 'to-ext' || !window.SdrBridge) return;
    try { window.SdrBridge.post(JSON.stringify(d.payload || {})); } catch (_) {}
  });
})();
