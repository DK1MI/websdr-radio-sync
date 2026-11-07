// Yaesu "new CAT" ASCII protocol (FT-450 and later: FT-950, FT-2000, FTDX-series,
// FT-891, FT-991, FT-710). FA takes 8 or 9 digits depending on the model.
import { TextCatDriver } from './text-cat.js';

// MD0x mode codes (main receiver).
const MODE_TO_RADIO = { LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5' };
const MODE_FROM_RADIO = {
  1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY-L', 7: 'CW-R', 8: 'DATA-L',
  9: 'RTTY-U', A: 'DATA-FM', B: 'FM', C: 'DATA-U', D: 'AM', E: 'PSK', F: 'DATA-FM',
};

export class YaesuDriver extends TextCatDriver {
  constructor(opts) {
    super(opts);
    this.digits = opts.model.digits || 9;
    this.txSupported = true;
  }

  async identify() {
    return this.query('ID', 1000);
  }

  async poll() {
    const fa = await this.query('FA', 600);
    const hz = parseInt(fa.slice(2), 10);
    let mode = null;
    let tx = false;
    try {
      const md = await this.query('MD0', 600, 'MD');
      mode = MODE_FROM_RADIO[md.slice(-1)] || null;
    } catch (e) {
      if (e.fatal) throw e;
    }
    if (this.txSupported) {
      try {
        const t = await this.query('TX', 400);
        tx = t[2] === '1' || t[2] === '2';
      } catch (e) {
        if (e.fatal) throw e;
        if (e.rejected) this.txSupported = false;
      }
    }
    return { hz: Number.isFinite(hz) ? hz : null, mode, vfo: 'A', tx };
  }

  async setFreq(hz) {
    await this.send(`FA${String(hz).padStart(this.digits, '0')}`);
  }

  canSetMode(mode) { return mode in MODE_TO_RADIO; }

  async setMode(mode) {
    await this.send(`MD0${MODE_TO_RADIO[mode]}`);
  }
}
