// Spots of outdoor activations (POTA, SOTA, WWFF, WWBOTA, IOTA …) from Spothole
// (https://spothole.app, an aggregator by M0TRT): fetching, band/mode classification, filtering.
//
// Spothole's conditions of use (https://spothole.app/help/usage/clients#terms): identify the
// client (the browser sends this extension's chrome-extension:// origin with every request),
// poll sensibly (Spothole itself polls POTA every two minutes), and make one request for
// everything, filtering on the client side.

const SPOTS_URL = 'https://spothole.app/api/v3/spots?' + new URLSearchParams({
  needs_activity: 'true',   // only spots that belong to an activity such as POTA or SOTA
  dedupe: 'true',           // latest spot per callsign
  allow_qrt: 'false',
  fields: 'id,dx_call,freq,mode,mode_type,band,activities,activity_refs,dx_qth,comment,de_call,time',
});
const TIMEOUT_MS = 15000;
export const REFRESH_MS = 120000;

// [name, lowHz, highHz]
export const BANDS = [
  ['160m', 1.8e6, 2.0e6], ['80m', 3.5e6, 4.0e6], ['60m', 5.25e6, 5.45e6], ['40m', 7.0e6, 7.3e6],
  ['30m', 10.1e6, 10.15e6], ['20m', 14.0e6, 14.35e6], ['17m', 18.068e6, 18.168e6], ['15m', 21.0e6, 21.45e6],
  ['12m', 24.89e6, 24.99e6], ['10m', 28.0e6, 29.7e6], ['6m', 50e6, 54e6], ['4m', 70e6, 71e6],
  ['2m', 144e6, 148e6], ['70cm', 420e6, 450e6],
];

export const MODE_GROUPS = ['CW', 'SSB', 'DATA', 'FM', 'AM'];

const DATA_MODES = /^(FT8|FT4|JS8|RTTY|PSK|BPSK|QPSK|MFSK|OLIVIA|CONTESTI|DOMINO|THOR|HELL|SSTV|VARA|DATA|DIGI|DIG|PKT|Q65|JT\d*|WSPR|MSK144|FST4|FSK|JTTY)/;

export function bandOf(hz) {
  const b = BANDS.find(([, lo, hi]) => hz >= lo && hz <= hi);
  return b ? b[0] : 'other';
}

export function modeGroup(mode) {
  const m = String(mode || '').toUpperCase().trim();
  if (m === 'CW') return 'CW';
  if (m === 'SSB' || m === 'USB' || m === 'LSB' || m === 'PHONE') return 'SSB';
  if (m === 'FM' || m === 'AM') return m;
  if (DATA_MODES.test(m)) return 'DATA';
  return 'other';
}

// Mode to tune the SDR and radio to. SSB follows the usual convention: LSB below 10 MHz,
// except on 60 m. Data modes run on USB. Unknown modes leave the mode alone (null).
export function tuneMode(group, hz) {
  if (group === 'SSB') return hz < 10e6 && bandOf(hz) !== '60m' ? 'LSB' : 'USB';
  if (group === 'DATA') return 'USB';
  if (group === 'CW' || group === 'FM' || group === 'AM') return group;
  return null;
}

// "SOTA G/LD-001", "POTA ES-2051, ES-0112", or just the activity names without references.
export function refsLabel(spot) {
  if (!spot.refs.length) return spot.activities.join(', ');
  const byActivity = new Map();
  for (const r of spot.refs) {
    if (!byActivity.has(r.activity)) byActivity.set(r.activity, []);
    byActivity.get(r.activity).push(r.id);
  }
  return [...byActivity].map(([a, ids]) => `${a} ${ids.join(', ')}`).join(' · ');
}

// Fetches the current spots and returns them newest first, with derived fields.
export async function fetchSpots() {
  let r;
  try {
    r = await fetch(SPOTS_URL, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'spothole.app did not answer' : 'cannot reach spothole.app');
  }
  if (!r.ok) throw new Error(`spothole.app answered HTTP ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error('unexpected answer from spothole.app');
  const spots = [];
  for (const s of list) {
    const hz = Math.round(Number(s.freq));
    if (!Number.isFinite(hz) || hz <= 0 || !s.dx_call) continue;
    const mode = String(s.mode || s.mode_type || '').toUpperCase();
    const refs = (Array.isArray(s.activity_refs) ? s.activity_refs : [])
      .filter((x) => x && x.id && x.activity)
      .map((x) => ({ activity: String(x.activity), id: String(x.id), name: String(x.name || '') }));
    spots.push({
      id: String(s.id || ''),
      call: String(s.dx_call),
      hz,
      mode,
      group: modeGroup(mode),
      band: bandOf(hz),
      activities: (Array.isArray(s.activities) ? s.activities : []).map(String),
      refs,
      location: String(s.dx_qth || ''),
      comments: String(s.comment || ''),
      spotter: String(s.de_call || ''),
      time: Number(s.time) > 0 ? Number(s.time) * 1000 : 0,
    });
  }
  spots.sort((a, b) => b.time - a.time);
  return spots;
}

// Activities in the current spots, most frequent first.
export function activitiesIn(spots) {
  const n = new Map();
  for (const s of spots) for (const a of s.activities) n.set(a, (n.get(a) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
}

export function filterSpots(spots, { band, mode, activity }) {
  return spots.filter((s) =>
    (!band || s.band === band) &&
    (!mode || s.group === mode) &&
    (!activity || s.activities.includes(activity)));
}
