// Reports the current frequency and mode to a Cloudlog or Wavelog logbook through its radio API
// (POST /index.php/api/radio), so the QSO entry form is pre-filled. The logbook derives the band
// from the frequency itself.

import { bandOf } from './spots.js';

const DEBOUNCE_MS = 1000;   // tuning across the band sends one update, not dozens
const REFRESH_MS = 120000;  // re-send an unchanged state so the logbook doesn't mark the radio stale
const TIMEOUT_MS = 8000;

// How the radio is listed in the logbook's QSO window (Radio → "Polling - WebSDR").
export const RADIO_NAME = 'WebSDR';

// Accepts the logbook's base URL (https://log.example.com, …/index.php) or the full API
// endpoint (…/index.php/api/radio, …/api/radio) and returns the endpoint, or null.
export function endpointFor(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let path = u.pathname.replace(/\/+$/, '');
  if (!/\/api\/radio$/.test(path)) path += /\/index\.php$/.test(path) ? '/api/radio' : '/index.php/api/radio';
  u.pathname = path;
  u.search = '';
  u.hash = '';
  return u.href;
}

// Host permission pattern for the endpoint (match patterns cover every port).
export function originPattern(endpoint) {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.hostname}/*`;
}

// Mode names as Hamlib/flrig report them, which both logbooks understand.
const MODE_MAP = {
  'CW-R': 'CW', 'RTTY-R': 'RTTY', 'RTTY-L': 'RTTY', 'RTTY-U': 'RTTY', FSK: 'RTTY', 'FSK-R': 'RTTY',
  'DATA-U': 'PKTUSB', PKT: 'PKTUSB', 'DATA-L': 'PKTLSB', 'DATA-FM': 'PKTFM',
};
const logMode = (m) => (m ? MODE_MAP[m] || m : null);

/* ---------------------------------------------------------------- ADIF for QSO logging */

// Spot modes that ADIF files under a parent mode.
const ADIF_SUBMODES = {
  FT4: 'MFSK', JS8: 'MFSK', Q65: 'MFSK', FST4: 'MFSK',
  PSK31: 'PSK', PSK63: 'PSK', PSK125: 'PSK', BPSK31: 'PSK',
  USB: 'SSB', LSB: 'SSB',
};

export function adifMode(mode, hz) {
  const m = String(mode || '').toUpperCase().trim();
  if (m === 'SSB' || m === 'PHONE') return ['SSB', hz < 10e6 && bandOf(hz) !== '60m' ? 'LSB' : 'USB'];
  if (ADIF_SUBMODES[m]) return [ADIF_SUBMODES[m], m];
  return [m || 'SSB', null];
}

const field = (name, value) => {
  const v = String(value);
  return `<${name}:${new TextEncoder().encode(v).length}>${v}`;
};

// ADIF fields of their own for some programmes (ADIF 3.1.4). POTA_REF takes a comma-separated
// list (two-fers); the others take one reference.
const REF_FIELDS = { POTA: ['POTA_REF', true], SOTA: ['SOTA_REF', false], WWFF: ['WWFF_REF', false], IOTA: ['IOTA', false] };

// One ADIF record for a QSO with a spotted activator. refs: [{ activity, id }].
// The report is 599 in CW, 59 otherwise. The first reference also goes into SIG / SIG_INFO.
export function spotQsoAdif({ call, hz, mode, refs = [] }, when = new Date()) {
  const [m, sub] = adifMode(mode, hz);
  const rst = m === 'CW' ? '599' : '59';
  const iso = when.toISOString();
  const parts = [
    field('CALL', call.toUpperCase()),
    field('QSO_DATE', iso.slice(0, 10).replace(/-/g, '')),
    field('TIME_ON', iso.slice(11, 19).replace(/:/g, '')),
    field('FREQ', (hz / 1e6).toFixed(6)),
    field('MODE', m),
  ];
  if (sub) parts.push(field('SUBMODE', sub));
  const band = bandOf(hz);
  if (band !== 'other') parts.push(field('BAND', band));
  parts.push(field('RST_SENT', rst), field('RST_RCVD', rst));
  if (refs.length) parts.push(field('SIG', refs[0].activity), field('SIG_INFO', refs[0].id));
  for (const [activity, [name, many]] of Object.entries(REF_FIELDS)) {
    const ids = refs.filter((r) => r.activity === activity).map((r) => r.id);
    if (ids.length) parts.push(field(name, many ? ids.join(',') : ids[0]));
  }
  return parts.join(' ') + ' <EOR>';
}

export class Logbook {
  constructor({ log, onStatus }) {
    this.log = log;
    this.onStatus = onStatus;   // (level: ''|'ok'|'warn'|'bad', text)
    this.settings = {};
    this.state = null;          // latest { hz, mode } to report
    this.sentKey = null;        // what the logbook last accepted
    this.sentAt = 0;
    this.timer = null;
    this.busy = false;
    this.failing = false;
    setInterval(() => this.schedule(0), REFRESH_MS / 4);
  }

  get radioName() {
    return RADIO_NAME;
  }

  // The logbook's station location ID (a number), or null if none is set.
  get stationId() {
    const v = String(this.settings.logbookStation ?? '').trim();
    return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null;
  }

  get stationInvalid() {
    const v = String(this.settings.logbookStation ?? '').trim();
    return v !== '' && this.stationId == null;
  }

  get enabled() {
    const s = this.settings;
    return !!(s.logbookOn && s.logbookKey && endpointFor(s.logbookUrl) && !this.stationInvalid);
  }

  configure(settings) {
    this.settings = { ...settings };
    this.sentKey = null;        // new settings: send again
    this.failing = false;
    if (!this.settings.logbookOn) this.onStatus('', 'Off');
    else if (!endpointFor(this.settings.logbookUrl)) this.onStatus('warn', 'Enter the logbook URL');
    else if (!this.settings.logbookKey) this.onStatus('warn', 'Enter an API key');
    else if (this.stationInvalid) this.onStatus('warn', 'Station ID must be a number');
    else this.onStatus('', 'Waiting for a frequency');
    this.schedule(0);
  }

  // Called on every UI refresh; only real changes are sent.
  update(state) {
    this.state = state && state.hz ? { hz: Math.round(state.hz), mode: logMode(state.mode) } : null;
    if (this.state && this.key(this.state) !== this.sentKey) this.schedule(DEBOUNCE_MS);
  }

  key(s) {
    return `${s.hz}|${s.mode || ''}`;
  }

  schedule(ms) {
    if (!this.enabled || !this.state || this.timer) return;
    const changed = this.key(this.state) !== this.sentKey;
    if (!changed && performance.now() - this.sentAt < REFRESH_MS) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
  }

  async flush() {
    if (this.busy || !this.enabled || !this.state) return;
    this.busy = true;
    const s = this.state;
    try {
      await this.post(s);
      this.sentKey = this.key(s);
      this.sentAt = performance.now();
      if (this.failing) this.log('Logbook is reachable again.');
      this.failing = false;
      this.onStatus('ok', `Sent ${(s.hz / 1e6).toFixed(4)} MHz${s.mode ? ' ' + s.mode : ''} as "${this.radioName}"`);
    } catch (e) {
      if (!this.failing) this.log(`Logbook update failed: ${e.message}`, 'warn');
      this.failing = true;
      this.sentAt = performance.now();  // retry with the next refresh, not in a tight loop
      this.sentKey = this.key(s);
      this.onStatus('bad', e.message);
    } finally {
      this.busy = false;
    }
    if (this.state && this.key(this.state) !== this.sentKey) this.schedule(DEBOUNCE_MS);
  }

  // Sends one update and throws a readable error if the logbook doesn't accept it.
  async post({ hz, mode }) {
    const url = endpointFor(this.settings.logbookUrl);
    if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) {
      throw new Error(`no access to ${new URL(url).hostname} yet. Click "Save & test"`);
    }
    const body = {
      key: String(this.settings.logbookKey).trim(),
      radio: this.radioName,
      frequency: hz,
    };
    if (mode) body.mode = mode;
    if (this.stationId) body.station_profile_id = this.stationId;
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'no answer from the logbook' : `cannot reach ${new URL(url).host}`);
    }
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || (j && j.status && j.status !== 'success')) {
      const reason = j?.reason || j?.message;
      if (r.status === 404 && !reason) throw new Error('API not found at this URL. Check the address');
      throw new Error(reason ? `${reason} (HTTP ${r.status})` : `HTTP ${r.status}`);
    }
  }

  // QSO logging needs a URL, an API key and a station ID.
  get canLogQso() {
    const s = this.settings;
    return !!(s.logbookKey && endpointFor(s.logbookUrl) && this.stationId);
  }

  // Logs one QSO through the logbook's QSO API (POST …/api/qso) into the configured station.
  async logQso(qso) {
    if (!this.canLogQso) throw new Error('set the logbook URL, API key and station ID first');
    const url = endpointFor(this.settings.logbookUrl).replace(/\/api\/radio$/, '/api/qso');
    if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) {
      throw new Error(`no access to ${new URL(url).hostname} yet. Click "Save & test" in the logbook settings`);
    }
    const body = {
      key: String(this.settings.logbookKey).trim(),
      station_profile_id: String(this.stationId),
      type: 'adif',
      string: spotQsoAdif(qso),
    };
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'no answer from the logbook' : `cannot reach ${new URL(url).host}`);
    }
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || j.status !== 'created') {
      const msg = j?.reason || (Array.isArray(j?.messages) ? j.messages.filter(Boolean).join(' ') : '');
      throw new Error(msg ? `${msg} (HTTP ${r.status})` : `the logbook did not accept the QSO (HTTP ${r.status})`);
    }
    if (j.adif_count === 0) throw new Error('the logbook imported no QSO');
    return body.string;
  }

  // Looks the station ID up in the logbook (GET …/api/station_info/{key}) and returns its
  // name, or throws if the logbook has no station with that ID.
  async checkStation() {
    const id = this.stationId;
    const url = endpointFor(this.settings.logbookUrl).replace(/\/api\/radio$/, '/api/station_info/')
      + encodeURIComponent(String(this.settings.logbookKey).trim());
    let r;
    try {
      r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'no answer from the logbook' : `cannot reach ${new URL(url).host}`);
    }
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !Array.isArray(j)) throw new Error(j?.reason ? `${j.reason} (HTTP ${r.status})` : `station lookup failed (HTTP ${r.status})`);
    const st = j.find((x) => Number(x.station_id) === id);
    if (!st) {
      const list = j.map((x) => `${x.station_id} = ${x.station_profile_name || x.station_callsign}`).join(', ');
      throw new Error(`no station with ID ${id} in this logbook${list ? `. Stations: ${list}` : ''}`);
    }
    return [st.station_profile_name, st.station_callsign].filter(Boolean).join(', ');
  }

  // "Save & test": asks for access to the logbook's site, checks the station ID, then sends
  // the current frequency. Must run from a click. Returns { sent, station }.
  async test() {
    const url = endpointFor(this.settings.logbookUrl);
    if (!url) throw new Error('enter the logbook URL, e.g. https://log.example.com');
    if (!this.settings.logbookKey) throw new Error('enter an API key');
    if (this.stationInvalid) throw new Error('the station ID must be a number');
    const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
    if (!granted) throw new Error(`access to ${new URL(url).hostname} was not allowed`);
    const station = this.stationId ? await this.checkStation() : null;
    const s = this.state;
    if (!s) return { sent: false, station };
    await this.post(s);
    this.sentKey = this.key(s);
    this.sentAt = performance.now();
    this.failing = false;
    return { sent: true, station };
  }
}
