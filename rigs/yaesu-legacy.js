// Yaesu 5-byte binary CAT: FT-817/818, FT-857, FT-897 and FT-847.
// Commands are [P1 P2 P3 P4 CMD]; frequencies are 8 BCD digits in 10 Hz units.
import { SerialLink, deferred, sleep } from './serial-link.js';

const MODE_TO_RADIO = { LSB: 0x00, USB: 0x01, CW: 0x02, AM: 0x04, FM: 0x08 };
// Narrow variants set bit 7 (0x82 CW-N, 0x88 FM-N …), so the low 7 bits pick the mode.
const MODE_FROM_RADIO = { 0x00: 'LSB', 0x01: 'USB', 0x02: 'CW', 0x03: 'CW-R', 0x04: 'AM', 0x06: 'WFM', 0x08: 'FM', 0x0a: 'DIG', 0x0c: 'PKT' };

function toBcd8(n10) {
  const s = String(n10).padStart(8, '0');
  return [0, 2, 4, 6].map((i) => (Number(s[i]) << 4) | Number(s[i + 1]));
}
function fromBcd(bytes) {
  let n = 0;
  for (const b of bytes) n = n * 100 + (b >> 4) * 10 + (b & 0x0f);
  return n;
}

export class YaesuLegacyDriver {
  constructor({ port, model, cfg, log }) {
    this.model = model;
    this.cfg = cfg;
    this.log = log;
    this.rx = [];
    this.want = null; // { n, d }
    this.link = new SerialLink(port, { onData: (b) => this.onData(b), log });
    this.txSupported = !model.noTxStatus;
  }

  get minHz() { return this.model.minHz ?? 100_000; }
  get maxHz() { return this.model.maxHz ?? 470_000_000; }

  onData(bytes) {
    for (const b of bytes) this.rx.push(b);
    if (this.want && this.rx.length >= this.want.n) {
      const w = this.want;
      this.want = null;
      w.d.resolve(this.rx.splice(0, w.n));
    }
    if (this.rx.length > 256) this.rx = [];
  }

  async cmd(p1, p2, p3, p4, op) {
    await this.link.write(new Uint8Array([p1, p2, p3, p4, op]));
  }

  // These radios answer some commands with a 1-byte ack and others with nothing,
  // so clear stray bytes before each read instead of trying to track acks.
  async read(op, n, ms = 500) {
    await sleep(50);
    this.rx = [];
    const d = deferred(ms, `CAT 0x${op.toString(16)}`);
    this.want = { n, d };
    d.promise.catch(() => { if (this.want && this.want.d === d) this.want = null; });
    try {
      await this.cmd(0, 0, 0, 0, op);
    } catch (e) {
      d.reject(e);
    }
    return d.promise;
  }

  async open() {
    await this.link.open(this.cfg);
    if (this.model.catOn) await this.cmd(0, 0, 0, 0, 0x00); // FT-847: CAT ON
  }

  async close() {
    this.want?.d.reject(new Error('disconnected'));
    if (this.model.catOn) { try { await this.cmd(0, 0, 0, 0, 0x80); } catch (_) {} } // CAT OFF
    await this.link.close();
  }

  async identify() {
    await this.read(0x03, 5, 1000);
    return this.model.name.replace(/^Yaesu /, '');
  }

  async poll() {
    const r = await this.read(0x03, 5);
    const hz = fromBcd(r.slice(0, 4)) * 10;
    const mode = MODE_FROM_RADIO[r[4] & 0x7f] || null;
    let tx = false;
    if (this.txSupported) {
      try {
        const [s] = await this.read(0xf7, 1, 300);
        tx = (s & 0x80) === 0; // bit 7 clear = PTT keyed
      } catch (e) {
        if (e.fatal) throw e;
        this.txSupported = false;
      }
    }
    return { hz, mode, vfo: 'A', tx };
  }

  async setFreq(hz) {
    const [a, b, c, d] = toBcd8(Math.round(hz / 10));
    await this.cmd(a, b, c, d, 0x01);
  }

  canSetMode(mode) { return mode in MODE_TO_RADIO; }

  async setMode(mode) {
    await this.cmd(MODE_TO_RADIO[mode], 0, 0, 0, 0x07);
  }
}
