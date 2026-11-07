// Icom CI-V (and CI-V compatible radios such as Xiegu).
// Frame: FE FE <to> <from> <cmd> [sub] [data…] FD. Frequencies are BCD, least significant byte first.
import { SerialLink, deferred } from './serial-link.js';

const CTRL = 0xe0; // our controller address
const OK = 0xfb;
const NG = 0xfa;

const MODE_TO_RADIO = { LSB: 0x00, USB: 0x01, AM: 0x02, CW: 0x03, FM: 0x05 };
const MODE_FROM_RADIO = { 0x00: 'LSB', 0x01: 'USB', 0x02: 'AM', 0x03: 'CW', 0x04: 'RTTY', 0x05: 'FM', 0x06: 'WFM', 0x07: 'CW-R', 0x08: 'RTTY-R', 0x17: 'DV' };

function bcdLE(hz, nBytes) {
  const out = [];
  let n = Math.round(hz);
  for (let i = 0; i < nBytes; i++) {
    const lo = n % 10; n = Math.floor(n / 10);
    const hi = n % 10; n = Math.floor(n / 10);
    out.push((hi << 4) | lo);
  }
  return out;
}
function fromBcdLE(bytes) {
  let n = 0;
  for (let i = bytes.length - 1; i >= 0; i--) n = n * 100 + (bytes[i] >> 4) * 10 + (bytes[i] & 0x0f);
  return n;
}

export class IcomDriver {
  constructor({ port, model, cfg, log, onState }) {
    this.model = model;
    this.cfg = cfg;
    this.log = log;
    this.onState = onState;
    this.addr = parseInt(cfg.civAddr || model.civ || '94', 16);
    this.freqBytes = model.freqBytes || 5;
    this.buf = [];
    this.waiters = [];
    this.txSupported = true;
    this.last = { hz: null, mode: null };
    this.link = new SerialLink(port, { onData: (b) => this.onData(b), log });
  }

  get minHz() { return this.model.minHz ?? 30_000; }
  get maxHz() { return this.model.maxHz ?? 470_000_000; }

  async open() {
    if (!Number.isFinite(this.addr) || this.addr < 1 || this.addr > 0xdf) {
      throw new Error(`Invalid CI-V address "${this.cfg.civAddr}" (hex, e.g. 94).`);
    }
    await this.link.open(this.cfg);
  }

  async close() {
    for (const w of this.waiters.splice(0)) w.d.reject(new Error('disconnected'));
    await this.link.close();
  }

  onData(bytes) {
    for (const b of bytes) {
      if (b === 0xfd) {
        this.onFrame(this.buf);
        this.buf = [];
      } else {
        this.buf.push(b);
        if (this.buf.length > 64) this.buf = [];
      }
    }
  }

  onFrame(raw) {
    // Strip any leading noise/collision bytes before the FE FE preamble.
    let i = 0;
    while (i < raw.length && raw[i] !== 0xfe) i++;
    while (i < raw.length && raw[i] === 0xfe) i++;
    const f = raw.slice(i);
    if (f.length < 3) return;
    const [to, from, cmd, ...data] = f;
    if (from === CTRL) return; // our own echo (CI-V bus / USB echo back)
    if (from !== this.addr) return;

    if (to === 0x00) { // transceive broadcast: someone turned the knob
      if (cmd === 0x00 && data.length >= 4) this.onState({ hz: fromBcdLE(data) });
      else if (cmd === 0x01 && data.length >= 1) this.onState({ mode: MODE_FROM_RADIO[data[0]] || null });
      return;
    }
    if (to !== CTRL) return;

    const w = this.waiters.shift();
    if (!w) return;
    if (cmd === NG) {
      const e = new Error(`radio rejected CI-V command ${w.label}`);
      e.rejected = true;
      w.d.reject(e);
    } else if (cmd === OK) {
      w.d.resolve([]);
    } else if (cmd !== w.cmd) {
      w.d.reject(new Error(`unexpected CI-V reply 0x${cmd.toString(16)} to ${w.label}`));
    } else {
      w.d.resolve(data);
    }
  }

  async request(cmd, payload = [], ms = 500) {
    const label = `0x${cmd.toString(16).padStart(2, '0')}`;
    const d = deferred(ms, `CI-V ${label}`);
    const w = { cmd, label, d };
    this.waiters.push(w);
    d.promise.catch(() => {
      const i = this.waiters.indexOf(w);
      if (i >= 0) this.waiters.splice(i, 1);
    });
    try {
      await this.link.write(new Uint8Array([0xfe, 0xfe, this.addr, CTRL, cmd, ...payload, 0xfd]));
    } catch (e) {
      d.reject(e);
    }
    return d.promise;
  }

  async identify() {
    try {
      await this.request(0x03, [], 1000);
    } catch (e) {
      if (!e.fatal && /no answer/.test(e.message)) {
        e.message += ` — check the CI-V address (now ${this.addr.toString(16).toUpperCase()}h) and baud rate`;
      }
      throw e;
    }
    return `${this.model.name.replace(/^Icom /, '')} @ ${this.addr.toString(16).toUpperCase()}h`;
  }

  async poll() {
    const f = await this.request(0x03);
    const hz = f.length >= 4 ? fromBcdLE(f) : null;
    let mode = this.last.mode;
    try {
      const m = await this.request(0x04);
      if (m.length) mode = MODE_FROM_RADIO[m[0]] || null;
    } catch (e) {
      if (e.fatal) throw e;
    }
    let tx = false;
    if (this.txSupported) {
      try {
        const t = await this.request(0x1c, [0x00], 300);
        tx = t[0] === 0x00 && t[1] === 0x01; // reply: 00 <0|1>
      } catch (e) {
        if (e.fatal) throw e;
        this.txSupported = false; // older radios don't have 1C 00
      }
    }
    this.last = { hz, mode };
    return { hz, mode, vfo: null, tx };
  }

  async setFreq(hz) {
    await this.request(0x05, bcdLE(hz, this.freqBytes));
  }

  canSetMode(mode) { return mode in MODE_TO_RADIO; }

  async setMode(mode) {
    await this.request(0x06, [MODE_TO_RADIO[mode]]);
  }
}
