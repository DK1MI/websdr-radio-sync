// Shared plumbing for ';'-terminated ASCII CAT protocols (Kenwood, Elecraft, newer Yaesu).
import { SerialLink, deferred } from './serial-link.js';

const ERRORS = { '?': 'command rejected (syntax/state)', E: 'communication error', O: 'receive overflow' };

export class TextCatDriver {
  constructor({ port, model, cfg, log, onState }) {
    this.model = model;
    this.cfg = cfg;
    this.log = log;
    this.onState = onState; // called with unsolicited state updates
    this.rx = '';
    this.waiters = [];
    this.dec = new TextDecoder();
    this.link = new SerialLink(port, { onData: (b) => this.onData(b), log });
  }

  get minHz() { return this.model.minHz ?? 30_000; }
  get maxHz() { return this.model.maxHz ?? 470_000_000; }

  async open() {
    await this.link.open(this.cfg);
  }

  async close() {
    for (const w of this.waiters.splice(0)) w.d.reject(new Error('disconnected'));
    await this.link.close();
  }

  onData(bytes) {
    this.rx += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.rx.indexOf(';')) >= 0) {
      const frame = this.rx.slice(0, i).replace(/^[\r\n\0 ]+/, '');
      this.rx = this.rx.slice(i + 1);
      this.onFrame(frame);
    }
    if (this.rx.length > 512) this.rx = '';
  }

  onFrame(f) {
    if (!f) return;
    const isErr = f in ERRORS;
    const i = this.waiters.findIndex((w) => isErr || f.startsWith(w.prefix));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0];
      if (isErr) {
        const e = new Error(`radio: ${ERRORS[f]} (${w.prefix};)`);
        e.rejected = f === '?';
        w.d.reject(e);
      } else w.d.resolve(f);
      return;
    }
    if (isErr) this.log(`Radio says: ${ERRORS[f]} (${f};)`, 'warn');
    else this.onUnsolicited(f);
  }

  onUnsolicited(_f) {}

  send(cmd) {
    return this.link.write(cmd + ';');
  }

  async query(cmd, ms = 600, prefix = cmd) {
    const d = deferred(ms, `${cmd};`);
    const w = { prefix, d };
    this.waiters.push(w);
    d.promise.catch(() => {
      const i = this.waiters.indexOf(w);
      if (i >= 0) this.waiters.splice(i, 1);
    });
    try {
      await this.send(cmd);
    } catch (e) {
      d.reject(e);
    }
    return d.promise;
  }
}
