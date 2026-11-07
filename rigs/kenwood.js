// Kenwood CAT and the many radios that speak it: Elecraft, FlexRadio (SmartSDR CAT),
// QRP Labs, truSDX, Lab599 and others. FA/FB take 11 digits in Hz.
import { TextCatDriver } from './text-cat.js';

const MODE_TO_RADIO = { LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5' };
const MODE_FROM_RADIO = { 1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'FSK', 7: 'CW-R', 9: 'FSK-R' };
const KNOWN_IDS = { ID017: 'TS-570 / K3', ID018: 'TS-570', ID019: 'TS-2000', ID020: 'TS-480', ID021: 'TS-590S', ID023: 'TS-590SG' };

export class KenwoodDriver extends TextCatDriver {
  constructor(opts) {
    super(opts);
    this.useIF = true;   // fall back to FA;/MD; polling if the radio rejects IF;
    this.ifRejects = 0;
  }

  async identify() {
    const id = await this.query('ID', 1000);
    return KNOWN_IDS[id] ? `${id} (${KNOWN_IDS[id]})` : id;
  }

  // IF answer: after "IF", 0-based positions in the full frame:
  // 2-12 freq(11) | 13-17 step | 18-22 RIT/XIT | 23 RIT | 24 XIT | 25-27 bank/mem ch
  // 28 RX/TX | 29 mode | 30 VFO/mem | 31 scan | 32 split ...
  // Same layout on TS-480/570/590/2000/890, Elecraft K2/K3/KX and the emulations.
  parseIF(f) {
    if (f.length < 31) return null;
    const hz = parseInt(f.slice(2, 13), 10);
    if (!Number.isFinite(hz)) return null;
    return {
      hz,
      mode: MODE_FROM_RADIO[f[29]] || null,
      vfo: { 0: 'A', 1: 'B', 2: 'MEM' }[f[30]] || null,
      tx: f[28] === '1',
    };
  }

  onUnsolicited(f) {
    // Auto Information mode pushes IF frames.
    if (f.startsWith('IF')) {
      const s = this.parseIF(f);
      if (s) this.onState(s);
    }
  }

  async poll() {
    if (this.useIF) {
      try {
        const s = this.parseIF(await this.query('IF', 600));
        if (s) { this.ifRejects = 0; return s; }
      } catch (e) {
        if (!e.rejected || ++this.ifRejects < 3) throw e;
        this.useIF = false;
        this.log('Radio rejects IF; — polling FA;/MD; instead (no TX or VFO B detection).', 'warn');
      }
    }
    const fa = await this.query('FA', 600);
    const hz = parseInt(fa.slice(2), 10);
    let mode = null;
    try {
      const md = await this.query('MD', 600);
      mode = MODE_FROM_RADIO[md[2]] || null;
    } catch (e) {
      if (e.fatal) throw e;
    }
    return { hz: Number.isFinite(hz) ? hz : null, mode, vfo: 'A', tx: false };
  }

  async setFreq(hz, state) {
    const cmd = state.vfo === 'B' ? 'FB' : 'FA';
    await this.send(`${cmd}${String(hz).padStart(11, '0')}`);
  }

  canSetMode(mode) { return mode in MODE_TO_RADIO; }

  async setMode(mode) {
    await this.send(`MD${MODE_TO_RADIO[mode]}`);
  }
}
