// Loaded before panel.js in the Android app. Provides the parts of the chrome.* extension
// API and of Web Serial that panel.js and the rig drivers use, backed by the app
// (window.AndroidHost, see PanelHost.kt). panel.js itself runs unchanged.
(() => {
  'use strict';
  if (window.__androidShim || !window.AndroidHost) return;
  const host = window.AndroidHost;
  const SDR_TAB = 1; // the app has exactly one SDR view

  /* ------------------------------------------------------------ calls into the app */
  const pending = new Map();
  let nextId = 1;

  function toError(e) {
    const name = (e && e.name) || 'Error';
    const message = (e && e.message) || String(e);
    if (name === 'TypeError') return new TypeError(message);
    if (name === 'Error') return new Error(message);
    return new DOMException(message, name);
  }

  function call(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      host.call(method, id, JSON.stringify(args));
    });
  }

  /* ------------------------------------------------------------ chrome.runtime / chrome.tabs */
  const messageListeners = new Set();
  const removedListeners = new Set();

  function dispatchMessage(msg, sender) {
    for (const f of messageListeners) {
      try { f(msg, sender, () => {}); } catch (e) { console.error(e); }
    }
  }

  // Same checks as content/bridge.js does in the extension.
  function sdrState(p) {
    if (!p || !Number.isFinite(p.hz)) return;
    dispatchMessage({
      type: 'websdr-state',
      kind: String(p.kind),
      hz: Math.round(p.hz),
      mode: typeof p.mode === 'string' ? p.mode.slice(0, 8) : null,
      sdr: typeof p.sdr === 'string' ? p.sdr.slice(0, 20) : 'WebSDR',
      title: String(p.title || '').slice(0, 120),
      host: String(p.host || '').slice(0, 120),
    }, { tab: { id: SDR_TAB, active: true } });
  }

  const runtime = {
    id: 'android',
    lastError: undefined,
    getURL: (path) => new URL(path, location.href).href,
    onMessage: { addListener: (f) => messageListeners.add(f), removeListener: (f) => messageListeners.delete(f) },
    sendMessage: async () => {},
    // No Hamlib on Android: behave like a missing native host.
    connectNative() {
      const onDisconnect = new Set();
      const port = {
        onMessage: { addListener() {} },
        onDisconnect: { addListener: (f) => onDisconnect.add(f) },
        postMessage() { throw new Error('Hamlib is not available in the Android app'); },
        disconnect() {},
      };
      setTimeout(() => {
        runtime.lastError = { message: 'Specified native messaging host not found (Hamlib is not available on Android).' };
        for (const f of onDisconnect) { try { f(port); } catch (_) {} }
        runtime.lastError = undefined;
      }, 0);
      return port;
    },
  };

  const tabs = {
    async sendMessage(tabId, msg) {
      if (tabId !== SDR_TAB || !msg || msg.type !== 'websdr-cmd') throw new Error('no such tab');
      const src = msg.cmd || {};
      const cmd = {};
      if (src.get) cmd.get = true;
      if (Number.isFinite(src.hz)) cmd.hz = src.hz;
      if (typeof src.mode === 'string') cmd.mode = src.mode;
      await call('sdrCommand', cmd);
    },
    query: async () => [{ id: SDR_TAB, active: true }],
    create() {},
    getCurrent: async () => null,
    remove: async () => {},
    onActivated: { addListener() {} },
    onRemoved: { addListener: (f) => removedListeners.add(f) },
  };

  /* ------------------------------------------------------------ chrome.storage.local (localStorage) */
  const PREFIX = 'storage.local:';
  const local = {
    async get(keys) {
      let list;
      let defaults = {};
      if (keys == null) list = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
      else if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys;
      else { defaults = keys; list = Object.keys(keys); }
      const out = {};
      for (const k of list) {
        const raw = localStorage.getItem(PREFIX + k);
        if (raw != null) {
          try { out[k] = JSON.parse(raw); continue; } catch (_) {}
        }
        if (k in defaults) out[k] = defaults[k];
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) {
        if (v === undefined) localStorage.removeItem(PREFIX + k);
        else localStorage.setItem(PREFIX + k, JSON.stringify(v));
      }
    },
    async remove(keys) {
      for (const k of [].concat(keys)) localStorage.removeItem(PREFIX + k);
    },
  };

  Object.defineProperty(window, 'chrome', {
    configurable: true,
    writable: true,
    value: {
      runtime,
      tabs,
      storage: { local },
      windows: { create() {} },
      // The app fetches through native code (no CORS), so every origin is reachable.
      permissions: { contains: async () => true, request: async () => true },
    },
  });

  /* ------------------------------------------------------------ fetch without CORS */
  const pageFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) return pageFetch(input, init);
    const signal = init.signal;
    const abortReason = () => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw abortReason();
    const headers = {};
    if (init.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const req = call('fetch', {
      url: url.href,
      method: init.method || 'GET',
      headers,
      body: init.body == null ? null : String(init.body),
    });
    const r = signal
      ? await Promise.race([req, new Promise((_, rej) => signal.addEventListener('abort', () => rej(abortReason()), { once: true }))])
      : await req;
    const body = r.status === 204 || r.status === 304 ? null : r.body;
    try {
      return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
    } catch (_) {
      return new Response(body, { status: r.status }); // a header the Response constructor refuses
    }
  };

  /* ------------------------------------------------------------ Web Serial over USB host */
  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const asBytes = (chunk) => (chunk instanceof Uint8Array ? chunk : ArrayBuffer.isView(chunk)
    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk));

  const portsByKey = new Map();   // "deviceName#portIndex" -> SerialPort
  const openPorts = new Map();    // native handle -> SerialPort

  class SerialPort extends EventTarget {
    constructor(desc) {
      super();
      this._desc = desc;
      this._handle = null;
      this._rc = null;
      this.readable = null;
      this.writable = null;
    }

    getInfo() {
      return { usbVendorId: this._desc.vendorId, usbProductId: this._desc.productId };
    }

    async open(o = {}) {
      if (this._handle != null) throw new DOMException('The port is already open.', 'InvalidStateError');
      const r = await call('serialOpen', {
        key: this._desc.key,
        baudRate: Number(o.baudRate),
        dataBits: o.dataBits ?? 8,
        stopBits: o.stopBits ?? 1,
        parity: o.parity ?? 'none',
        flowControl: o.flowControl ?? 'none',
      });
      this._handle = r.handle;
      openPorts.set(r.handle, this);
      const self = this;
      this.readable = new ReadableStream({
        start(c) { self._rc = c; },
        cancel() { self._rc = null; },
      });
      this.writable = new WritableStream({
        write(chunk) {
          if (self._handle == null) throw new DOMException('The port is closed.', 'InvalidStateError');
          return call('serialWrite', { handle: self._handle, data: toB64(asBytes(chunk)) });
        },
      });
    }

    _data(bytes) {
      try { this._rc?.enqueue(bytes); } catch (_) {}
    }

    // Device unplugged or I/O failed: end the streams like Web Serial does on a fatal error.
    _lost(message) {
      openPorts.delete(this._handle);
      this._handle = null;
      try { this._rc?.error(new DOMException(message || 'The device has been lost.', 'NetworkError')); } catch (_) {}
      this._rc = null;
      this.readable = null;
      this.writable = null;
    }

    async setSignals(s = {}) {
      if (this._handle == null) throw new DOMException('The port is closed.', 'InvalidStateError');
      const args = { handle: this._handle };
      if (typeof s.dataTerminalReady === 'boolean') args.dtr = s.dataTerminalReady;
      if (typeof s.requestToSend === 'boolean') args.rts = s.requestToSend;
      await call('serialSetSignals', args);
    }

    async getSignals() {
      if (this._handle == null) throw new DOMException('The port is closed.', 'InvalidStateError');
      return call('serialGetSignals', { handle: this._handle });
    }

    async close() {
      const h = this._handle;
      this._handle = null;
      openPorts.delete(h);
      try { this._rc?.close(); } catch (_) {}
      this._rc = null;
      this.readable = null;
      this.writable = null;
      if (h != null) await call('serialClose', { handle: h });
    }
  }

  function portFor(desc) {
    let p = portsByKey.get(desc.key);
    if (!p) {
      p = new SerialPort(desc);
      portsByKey.set(desc.key, p);
    }
    return p;
  }

  class Serial extends EventTarget {
    async requestPort() { return portFor(await call('serialRequestPort')); }
    async getPorts() { return (await call('serialGetPorts')).map(portFor); }
  }
  const serial = new Serial();
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => serial });

  /* ------------------------------------------------------------ events from the app */
  const handlers = {
    sdrState,
    sdrGone() {
      for (const f of removedListeners) { try { f(SDR_TAB, {}); } catch (_) {} }
    },
    runtimeMessage(m) { dispatchMessage(m, {}); },
    serialData({ handle, data }) { openPorts.get(handle)?._data(fromB64(data)); },
    serialLost({ handle, message }) {
      const p = openPorts.get(handle);
      if (!p) return;
      p._lost(message);
      const ev = new Event('disconnect');
      Object.defineProperty(ev, 'target', { value: p }); // panel.js compares e.target with its port
      serial.dispatchEvent(ev);
    },
  };

  /* ------------------------------------------------------------ timers while hidden
     With the screen off or the app in the background, WebView throttles the page's timers
     (1/s, later 1/min), which would stall the radio polling. While hidden, setTimeout goes
     through the app, whose callbacks are not throttled. */
  const pageSetTimeout = window.setTimeout.bind(window);
  const pageClearTimeout = window.clearTimeout.bind(window);
  const appTimers = new Map();
  let nextTimer = 1e9; // well above the page's own timer ids
  window.setTimeout = (fn, ms, ...args) => {
    if (!document.hidden || typeof fn !== 'function') return pageSetTimeout(fn, ms, ...args);
    const id = nextTimer++;
    appTimers.set(id, () => fn(...args));
    host.timer(id, Math.max(0, Number(ms) || 0));
    return id;
  };
  window.clearTimeout = (id) => {
    if (!appTimers.delete(id)) pageClearTimeout(id);
  };

  window.__androidShim = {
    fire(id) {
      const f = appTimers.get(id);
      if (!f) return;
      appTimers.delete(id);
      try { f(); } catch (e) { console.error(e); }
    },
    reply(id, ok, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value);
      else p.reject(toError(value));
    },
    event(name, data) {
      try { handlers[name]?.(data); } catch (e) { console.error(e); }
    },
  };

  /* ------------------------------------------------------------ notification text */
  function watchStatus() {
    const t = (id) => (document.getElementById(id)?.textContent || '').trim();
    let timer = null;
    const send = () => {
      timer = null;
      const freq = t('radioFreq');
      const title = freq && freq !== '—'
        ? [t('radioName'), freq, t('radioMode')].filter((x) => x && x !== '–').join(' · ')
        : t('radioStatus');
      const sdrFreq = t('sdrFreq');
      const text = sdrFreq && sdrFreq !== '—'
        ? [t('sdrKind'), sdrFreq, t('sdrHost')].filter(Boolean).join(' · ')
        : 'No SDR page';
      try { host.status(title, text); } catch (_) {}
    };
    new MutationObserver(() => { if (!timer) timer = window.setTimeout(send, 1000); })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
    send();
  }

  /* ------------------------------------------------------------ panel tweaks */
  document.addEventListener('DOMContentLoaded', () => {
    watchStatus();
    const style = document.createElement('style');
    style.textContent = '#popoutBtn { display: none !important; }';
    document.head.appendChild(style);
    // Hamlib needs the desktop helper; not offered in the app.
    for (const o of document.querySelectorAll('#rigModel option[value="hamlib"]')) {
      const g = o.parentElement;
      o.remove();
      if (g && g.tagName === 'OPTGROUP' && !g.children.length) g.remove();
    }
  });
})();
