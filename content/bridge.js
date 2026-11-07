// Isolated-world relay between the page (sdr-main.js) and the extension panel.
(() => {
  'use strict';
  const TAG = '__sdr_radio_sync__';

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== TAG || d.dir !== 'to-ext' || !alive()) return;
    const p = d.payload || {};
    if (!Number.isFinite(p.hz)) return;
    const msg = {
      type: 'websdr-state',
      kind: String(p.kind),
      hz: Math.round(p.hz),
      mode: typeof p.mode === 'string' ? p.mode.slice(0, 8) : null,
      sdr: typeof p.sdr === 'string' ? p.sdr.slice(0, 20) : 'WebSDR',
      title: String(p.title || '').slice(0, 120),
      host: String(p.host || '').slice(0, 120),
    };
    try {
      chrome.runtime.sendMessage(msg).catch(() => {}); // no panel open -> ignore
    } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'websdr-cmd') return;
    const src = msg.cmd || {};
    const cmd = {};
    if (src.get) cmd.get = true;
    if (Number.isFinite(src.hz)) cmd.hz = src.hz;
    if (typeof src.mode === 'string') cmd.mode = src.mode;
    window.postMessage({ tag: TAG, dir: 'to-page', cmd }, '*');
  });
})();
