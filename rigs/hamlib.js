// Any Hamlib-supported radio, through rigctld and the native-messaging helper in native/.
// The helper either starts rigctld for the chosen model/device or connects to one already running.

export const HOST_NAME = 'websdr_radio_sync.hamlib';

const MODE_FROM_HAMLIB = { LSB: 'LSB', USB: 'USB', CW: 'CW', CWR: 'CW-R', AM: 'AM', SAM: 'AM', AMS: 'AM', FM: 'FM', FMN: 'FM', WFM: 'WFM', PKTUSB: 'DATA-U', PKTLSB: 'DATA-L', RTTY: 'RTTY', RTTYR: 'RTTY-R' };
const MODE_TO_HAMLIB = { LSB: 'LSB', USB: 'USB', CW: 'CW', AM: 'AM', FM: 'FM' };

// One request/response session with the helper.
export class HostSession {
  constructor() {
    this.port = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onDisconnect = null;
  }

  connect() {
    this.port = chrome.runtime.connectNative(HOST_NAME);
    this.port.onMessage.addListener((m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        const e = new Error(m.error);
        if (m.rprt != null) e.rprt = m.rprt;
        p.reject(e);
      } else p.resolve(m);
    });
    this.port.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message || 'helper exited';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(hostError(why)); }
      this.pending.clear();
      this.port = null;
      this.onDisconnect?.(why);
    });
  }

  call(op, args = {}, ms = 5000) {
    if (!this.port) return Promise.reject(hostError('helper not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper did not answer ${op}`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port.postMessage({ id, op, ...args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(hostError(e.message));
      }
    });
  }

  disconnect() {
    const p = this.port;
    this.port = null;
    this.onDisconnect = null;
    try { p?.disconnect(); } catch (_) {}
  }
}

function hostError(msg) {
  const e = new Error(/not found|forbidden|Specified native messaging host/i.test(msg)
    ? `Hamlib helper not installed (${msg}).`
    : `Hamlib helper: ${msg}`);
  e.hostMissing = /not found|forbidden|Specified native messaging host/i.test(msg);
  e.fatal = true;
  return e;
}

export class HamlibDriver {
  constructor({ model, cfg, log }) {
    this.model = model;
    this.cfg = cfg;
    this.log = log;
    this.session = new HostSession();
    this.label = '';
  }

  get minHz() { return 1; }
  get maxHz() { return 100e9; }

  async open() {
    this.session.connect();
    await this.session.call('hello', {}, 3000);
    this.session.onDisconnect = (why) => this.log(`Hamlib helper disconnected: ${why}`, 'err');
    const c = this.cfg;
    if (c.hamlibMode === 'connect') {
      const [host, port] = String(c.hamlibHost || '127.0.0.1:4532').split(':');
      const r = await this.session.call('connect', { host: host || '127.0.0.1', port: Number(port) || 4532 }, 8000);
      this.label = `rigctld @ ${host}:${port || 4532}${r.info ? ' · ' + r.info : ''}`;
    } else {
      if (!c.hamlibModel) throw Object.assign(new Error('Pick a Hamlib radio model first.'), { fatal: true });
      if (!c.hamlibDevice) throw Object.assign(new Error('Pick the serial device for rigctld first.'), { fatal: true });
      const r = await this.session.call('start', {
        model: Number(c.hamlibModel),
        device: c.hamlibDevice,
        baud: Number(c.baudRate),
        extra: c.hamlibExtra || '',
      }, 20000);
      this.label = `Hamlib #${c.hamlibModel}${r.info ? ' · ' + r.info : ''}`;
      this.log(`rigctld started: ${r.cmdline}`);
    }
  }

  async close() {
    try { await this.session.call('stop', {}, 3000); } catch (_) {}
    this.session.disconnect();
  }

  async identify() {
    await this.session.call('poll', {}, 6000);
    return this.label;
  }

  async poll() {
    const r = await this.session.call('poll', {}, 6000);
    return {
      hz: r.hz,
      mode: MODE_FROM_HAMLIB[r.mode] || r.mode || null,
      vfo: r.vfo === 'VFOB' || r.vfo === 'Sub' ? 'B' : r.vfo ? 'A' : null,
      tx: !!r.ptt,
    };
  }

  async setFreq(hz) {
    await this.session.call('set_freq', { hz }, 6000);
  }

  canSetMode(mode) { return mode in MODE_TO_HAMLIB; }

  async setMode(mode) {
    await this.session.call('set_mode', { mode: MODE_TO_HAMLIB[mode] }, 6000);
  }
}
