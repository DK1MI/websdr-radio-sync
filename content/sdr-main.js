// Runs in the page's own JS world so it can use the web SDR's JavaScript.
// Supports PA3FWM WebSDR, KiwiSDR, and OpenWebRX / OpenWebRX+.
// Talks to bridge.js (isolated world) via window.postMessage.
//
// Frequencies are always the *signal* frequency, as a radio shows it: in CW that is
// the frequency of a signal heard at the CW pitch, not the BFO/dial frequency.
(() => {
  'use strict';
  if (window.__sdrRadioSyncMain) return;
  window.__sdrRadioSyncMain = true;

  const TAG = '__sdr_radio_sync__';
  const POLL_MS = 150;
  const HEARTBEAT_MS = 2000;
  const DETECT_MS = 500;
  const DETECT_TRIES = 120; // ~60 s: KiwiSDR/OpenWebRX finish setting up after their websocket connects

  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

  /* ------------------------------------------------------------ PA3FWM WebSDR */
  const WEBSDR_FILTERS = { usb: [0.3, 2.7], lsb: [-2.7, -0.3], cw: [-0.95, -0.55], am: [-4, 4], fm: [-6, 6] };
  const websdr = {
    name: 'WebSDR',
    detect: () =>
      typeof window.nominalfreq === 'function' &&
      typeof window.freq === 'number' &&
      (typeof window.setfreqb === 'function' || typeof window.setfreqif === 'function'),
    readHz() {
      const khz = num(window.nominalfreq()); // what the page shows in its frequency box
      return khz && khz > 0 ? Math.round(khz * 1000) : null;
    },
    readMode() {
      let m = window.mode;
      if (typeof m === 'string') {
        m = m.toUpperCase();
        if (m.startsWith('AM') || m === 'SAM') return 'AM';
        if (['USB', 'LSB', 'CW', 'FM'].includes(m)) return m;
      }
      // Older WebSDR versions: mode is numeric (1 = AM, 4 = FM, 0 = SSB/CW).
      if (m === 1) return 'AM';
      if (m === 4) return 'FM';
      const lo = window.lo, hi = window.hi;
      if (typeof lo === 'number' && typeof hi === 'number') {
        if (hi - lo < 1.4) return 'CW';
        if (hi <= 0) return 'LSB';
        return 'USB';
      }
      return null;
    },
    setMode(m) {
      if (typeof window.set_mode === 'function') {
        window.set_mode(m);
        try { if (typeof window.MakeModebox === 'function') window.MakeModebox(m); } catch (_) {}
      } else if (typeof window.setmf === 'function' && WEBSDR_FILTERS[m.toLowerCase()]) {
        const [lo, hi] = WEBSDR_FILTERS[m.toLowerCase()];
        window.setmf(m.toLowerCase(), lo, hi);
      }
    },
    setFreq(hz) {
      const khz = hz / 1000;
      if (typeof window.setfreqb === 'function') window.setfreqb(khz); // also switches band if needed
      else window.setfreqif(String(khz));
    },
  };

  /* ------------------------------------------------------------ KiwiSDR
     Uses the extension API every KiwiSDR exposes (ext_get_freq, ext_get_mode, ext_tune).
     The displayed frequency already is the signal frequency in CW. */
  const KIWI_MODE_IN = {
    am: 'AM', amn: 'AM', amw: 'AM', sam: 'AM', sau: 'AM', sal: 'AM', sas: 'AM', qam: 'AM',
    usb: 'USB', usn: 'USB', lsb: 'LSB', lsn: 'LSB', cw: 'CW', cwn: 'CW', nbfm: 'FM', nnfm: 'FM',
  };
  const KIWI_MODE_OUT = { AM: 'am', USB: 'usb', LSB: 'lsb', CW: 'cw', FM: 'nbfm' };
  const kiwiOffsetHz = () => {
    try { return (num(window.ext_get_freq_range?.().offset_kHz) || 0) * 1000; } catch (_) { return 0; }
  };
  const kiwiZoomCur = () => (window.ext_zoom && typeof window.ext_zoom.CUR === 'number' ? window.ext_zoom.CUR : 4);
  const kiwisdr = {
    name: 'KiwiSDR',
    detect: () =>
      typeof window.ext_get_freq === 'function' &&
      typeof window.ext_get_mode === 'function' &&
      typeof window.ext_tune === 'function',
    readHz() {
      const hz = num(window.ext_get_freq());
      return hz && hz > 0 ? Math.round(hz + kiwiOffsetHz()) : null;
    },
    readMode() {
      const m = window.ext_get_mode();
      return typeof m === 'string' ? KIWI_MODE_IN[m.toLowerCase()] || m.toUpperCase() : null;
    },
    inRange(hz) {
      try {
        const r = window.ext_get_freq_range();
        return hz >= r.lo_kHz * 1000 && hz <= r.hi_kHz * 1000;
      } catch (_) {
        return true;
      }
    },
    // Tune frequency and mode in one call, keeping the current waterfall zoom.
    apply(hz, mode) {
      const m = mode ? KIWI_MODE_OUT[mode] : undefined;
      if (hz != null && !this.inRange(hz)) hz = null;
      if (hz == null && !m) return;
      window.ext_tune(hz != null ? hz / 1000 : undefined, m, kiwiZoomCur());
    },
  };

  /* ------------------------------------------------------------ OpenWebRX / OpenWebRX+
     Frequency = center_freq + demodulator offset. Plain OpenWebRX reports the dial
     frequency in CW, so add the passband centre there. OpenWebRX+ has UI.getFrequency /
     UI.setFrequency, which already do that. Only the current profile's span is tunable. */
  const OWRX_MODE_IN = { usb: 'USB', lsb: 'LSB', cw: 'CW', am: 'AM', sam: 'AM', nfm: 'FM', nxdn: 'FM', dmr: 'FM', ysf: 'FM', dstar: 'FM', m17: 'FM', wfm: 'WFM' };
  const OWRX_MODE_OUT = { USB: 'usb', LSB: 'lsb', CW: 'cw', AM: 'am', FM: 'nfm' };
  const owrxPanel = () => {
    try {
      const $ = window.jQuery;
      if (!$ || !$.fn || typeof $.fn.demodulatorPanel !== 'function') return null;
      const el = $('#openwebrx-panel-receiver');
      return el.length ? el.demodulatorPanel() : null;
    } catch (_) {
      return null;
    }
  };
  const owrxCenter = (panel) => num(window.center_freq) ?? num(panel?.center_freq);
  const owrxPlus = () => window.UI && typeof window.UI.getFrequency === 'function' && typeof window.UI.setFrequency === 'function';
  const owrxCwShift = (demod) => {
    if (!demod || demod.get_modulation() !== 'cw') return 0;
    const lo = num(demod.low_cut), hi = num(demod.high_cut);
    return lo != null && hi != null ? Math.round((lo + hi) / 2) : 800;
  };
  const openwebrx = {
    name: 'OpenWebRX',
    detect() {
      const p = owrxPanel();
      if (!p || typeof p.getDemodulator !== 'function') return false;
      const d = p.getDemodulator();
      if (!d || typeof d.get_offset_frequency !== 'function') return false;
      this.name = owrxPlus() ? 'OpenWebRX+' : 'OpenWebRX';
      return owrxCenter(p) != null;
    },
    readHz() {
      const p = owrxPanel();
      const d = p?.getDemodulator();
      const c = owrxCenter(p);
      if (!d || c == null) return null;
      if (owrxPlus()) {
        const f = num(window.UI.getFrequency());
        if (f && f > 0) return Math.round(f);
      }
      const off = num(d.get_offset_frequency());
      return off == null ? null : Math.round(c + off + owrxCwShift(d));
    },
    readMode() {
      const d = owrxPanel()?.getDemodulator();
      const m = d && d.get_modulation();
      return typeof m === 'string' ? OWRX_MODE_IN[m] || m.toUpperCase() : null;
    },
    setMode(m) {
      const mod = OWRX_MODE_OUT[m];
      if (!mod) return;
      if (owrxPlus() && typeof window.UI.setModulation === 'function') window.UI.setModulation(mod);
      else owrxPanel()?.setMode(mod);
    },
    setFreq(hz) {
      if (owrxPlus()) {
        window.UI.setFrequency(hz, false);
        return;
      }
      const p = owrxPanel();
      const d = p?.getDemodulator();
      const c = owrxCenter(p);
      if (!d || c == null) return;
      d.set_offset_frequency(hz - c - owrxCwShift(d)); // ignored outside the current profile's span
    },
  };

  // Order matters: KiwiSDR is an OpenWebRX descendant, so test it first.
  const ADAPTERS = [kiwisdr, openwebrx, websdr];
  let sdr = null;

  function readHz() {
    try { return sdr.readHz(); } catch (_) { return null; }
  }
  function readMode() {
    try { return sdr.readMode(); } catch (_) { return null; }
  }

  let last = { hz: null, mode: null };
  let lastPost = 0;

  function post(kind) {
    window.postMessage(
      {
        tag: TAG,
        dir: 'to-ext',
        payload: { kind, sdr: sdr.name, hz: last.hz, mode: last.mode, title: document.title, host: location.host },
      },
      '*'
    );
    lastPost = Date.now();
  }

  function refresh() {
    last = { hz: readHz(), mode: readMode() };
  }

  function tick() {
    const hz = readHz();
    const mode = readMode();
    if (hz == null) return;
    if (hz !== last.hz || mode !== last.mode) {
      last = { hz, mode };
      post('change');
    } else if (Date.now() - lastPost > HEARTBEAT_MS) {
      post('heartbeat');
    }
  }

  function apply(c) {
    const hz = typeof c.hz === 'number' && c.hz > 0 ? c.hz : null;
    const mode = c.mode ? String(c.mode).toUpperCase() : null;
    if (sdr.apply) {
      sdr.apply(hz, mode);
      return;
    }
    if (mode) sdr.setMode(mode); // mode first: the CW frequency correction depends on it
    if (hz != null) sdr.setFreq(hz);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !sdr) return;
    const d = e.data;
    if (!d || d.tag !== TAG || d.dir !== 'to-page') return;
    const c = d.cmd || {};
    if (c.get) {
      refresh();
      if (last.hz != null) post('initial');
      return;
    }
    try {
      apply(c);
    } catch (err) {
      console.warn('[SDR radio sync] could not apply command', err);
    }
    refresh(); // so the poller does not report our own change as a user change
    // Some SDRs update their frequency asynchronously; report the settled result.
    setTimeout(() => { refresh(); post('applied'); }, 300);
  });

  let tries = 0;
  (function detect() {
    if (!sdr) sdr = ADAPTERS.find((a) => { try { return a.detect(); } catch (_) { return false; } }) || null;
    if (sdr && readHz() != null) {
      refresh();
      post('initial');
      setInterval(tick, POLL_MS);
      return;
    }
    if (++tries < DETECT_TRIES) setTimeout(detect, DETECT_MS);
  })();
})();
