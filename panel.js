// WebSDR ⇄ radio sync panel.
// Holds the connection to the radio (a built-in Web Serial driver, or Hamlib through the
// native helper) and moves frequency/mode between the WebSDR tab (via content scripts)
// and the radio.
import { MODELS, findModel, createDriver, shortName } from './rigs/models.js';
import { HostSession } from './rigs/hamlib.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- settings */

const DEFAULTS = {
  rigModel: 'ts570',
  baudRate: 9600,
  stopBits: 1,
  flowControl: 'hardware',
  civAddr: '',
  pollMs: 300,
  offsetHz: 0,
  syncToRadio: true,
  syncMode: true,
  followRadio: false,
  autoConnect: true,
  lastPortInfo: null,
  hamlibMode: 'start',
  hamlibModel: '',
  hamlibName: '',
  hamlibDevice: '',
  hamlibExtra: '',
  hamlibHost: '127.0.0.1:4532',
};
let cfg = { ...DEFAULTS };

function save(key, v) {
  cfg[key] = v;
  chrome.storage.local.set({ [key]: v });
}

function fillControls() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const v = cfg[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v ?? '');
  }
  $('hamlibModelInput').value = cfg.hamlibModel ? `${cfg.hamlibModel} ${cfg.hamlibName}`.trim() : '';
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  if (!cfg.civAddr) cfg.civAddr = findModel(cfg.rigModel).civ || '';
  fillControls();
}

// Picking a radio fills in its usual serial defaults.
function applyModelDefaults(model) {
  save('baudRate', model.baud);
  save('stopBits', model.stop);
  save('flowControl', model.flow);
  save('civAddr', model.civ || '');
  fillControls();
}

function bindSettings() {
  for (const el of document.querySelectorAll('[data-key]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.key;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') v = Number(v) || 0;
      if (key === 'pollMs') v = Math.min(5000, Math.max(150, v));
      if (key === 'civAddr') v = String(v).trim().replace(/^0x/i, '').replace(/h$/i, '').toUpperCase();
      save(key, v);
      if (key === 'rigModel') {
        const m = findModel(v);
        applyModelDefaults(m);
        log(`Radio set to ${m.name}.${connected ? ' Reconnect to use it.' : ''}`);
        updateSections();
        if (m.family === 'hamlib') checkHamlibHelper();
      }
      if (key === 'hamlibMode') updateSections();
      if (key === 'followRadio' || key === 'pollMs') wake();
      if (key === 'syncToRadio' && v) queueSdrToRadio();
    });
  }
  $('hamlibModelInput').addEventListener('change', (e) => {
    const m = /^\s*(\d+)\s*(.*)$/.exec(e.target.value);
    if (!m) {
      log('Pick a model from the list (the number in front is the Hamlib model ID).', 'warn');
      return;
    }
    save('hamlibModel', m[1]);
    save('hamlibName', m[2].replace(/\s*\[[^\]]*\]$/, '').trim());
    render();
  });
}

function populateModelSelect() {
  const sel = $('rigModel');
  const groups = new Map();
  for (const m of MODELS) {
    if (!groups.has(m.group)) {
      const og = document.createElement('optgroup');
      og.label = m.group;
      groups.set(m.group, og);
      sel.appendChild(og);
    }
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    groups.get(m.group).appendChild(o);
  }
}

function currentModel() {
  return findModel(cfg.rigModel);
}

function updateSections() {
  const m = currentModel();
  const hamlib = m.family === 'hamlib';
  $('hamlibCard').hidden = !hamlib;
  for (const el of document.querySelectorAll('[data-serial]')) el.hidden = hamlib;
  for (const el of document.querySelectorAll('[data-civ]')) el.hidden = m.family !== 'icom';
  for (const el of document.querySelectorAll('[data-hamlib]')) el.hidden = el.dataset.hamlib !== cfg.hamlibMode;
  render();
}

/* ---------------------------------------------------------------- logging */

function log(text, level = '') {
  const pre = $('log');
  const line = document.createElement('div');
  if (level) line.className = level;
  line.textContent = `${new Date().toLocaleTimeString([], { hour12: false })}  ${text}`;
  pre.appendChild(line);
  while (pre.childNodes.length > 150) pre.removeChild(pre.firstChild);
  pre.scrollTop = pre.scrollHeight;
}

/* ---------------------------------------------------------------- state */

// Radio modes the WebSDR has an equivalent for.
const RADIO_MODE_TO_SDR = { LSB: 'LSB', USB: 'USB', CW: 'CW', 'CW-R': 'CW', FM: 'FM', AM: 'AM' };

let driver = null;
let serialPort = null;    // the Web Serial port (built-in drivers only)
let connected = false;

const radio = { hz: null, mode: null, vfo: null, tx: false, responsive: false, idText: '' };
const sdr = { tabId: null, hz: null, mode: null, host: '', title: '', kind: '' };

let pending = null;       // latest WebSDR state waiting to be written to the radio (coalesced)
let lastWriteAt = 0;      // performance.now() of our last frequency/mode write
let missedPolls = 0;
let warnedMemory = false;
let lastSdrCmdHz = null;  // frequency we last asked the WebSDR to tune to

/* ---------------------------------------------------------------- formatting */

function fmtHz(hz) {
  if (hz == null) return '—';
  const mhz = Math.floor(hz / 1e6);
  const khz = Math.floor((hz % 1e6) / 1e3);
  const tens = Math.floor((hz % 1e3) / 10);
  return `${mhz}.${String(khz).padStart(3, '0')}.${String(tens).padStart(2, '0')}`;
}

function render() {
  const model = currentModel();
  $('sdrFreq').textContent = fmtHz(sdr.hz);
  $('sdrKind').textContent = sdr.tabId == null ? 'SDR' : sdr.kind || 'SDR';
  $('sdrMode').textContent = sdr.tabId == null ? '–' : (sdr.mode || '?');
  $('sdrHost').textContent = sdr.tabId == null ? 'No SDR tab. Open a WebSDR, KiwiSDR or OpenWebRX page.' : sdr.host;
  $('sdrHost').title = sdr.title || '';

  $('radioName').textContent = shortName(driver?.model || model, cfg);
  $('radioFreq').textContent = connected ? fmtHz(radio.hz) : '—';
  // Amber when the radio is not where the SDR is (sync off, out of range, transmitting …).
  const expected = sdr.hz == null ? null : Math.round(sdr.hz + Number(cfg.offsetHz || 0));
  $('radioFreq').classList.toggle('differs', connected && radio.hz != null && expected != null && Math.abs(radio.hz - expected) > 10);
  $('radioMode').textContent = connected && radio.mode ? radio.mode + (radio.tx ? ' TX' : '') : '–';
  $('radioVfo').textContent = connected && radio.vfo ? `VFO ${radio.vfo}` : '';

  const dot = $('radioDot');
  dot.className = 'dot' + (!connected ? '' : radio.responsive ? ' ok' : ' warn');
  const via = driver?.model.family === 'hamlib' ? 'via Hamlib' : `@ ${cfg.baudRate} bd`;
  $('radioStatus').textContent = !connected
    ? 'Radio not connected'
    : radio.responsive
      ? `Connected${radio.idText ? ' · ' + radio.idText : ''} ${via}`
      : 'Connected, but the radio is not answering';

  $('connectBtn').hidden = connected;
  $('disconnectBtn').hidden = !connected;
  $('rigModel').disabled = connected;
  $('pushBtn').disabled = !connected || sdr.hz == null;
  $('pullBtn').disabled = !connected || radio.hz == null || sdr.tabId == null;
}

/* ---------------------------------------------------------------- radio state */

// Merge a full poll result or a partial unsolicited update (knob turned with
// Auto Information / CI-V transceive on).
function handleState(s) {
  const prevHz = radio.hz;
  const prevMode = radio.mode;
  if (s.hz != null) radio.hz = s.hz;
  if (s.mode) radio.mode = s.mode;
  if (s.vfo !== undefined) radio.vfo = s.vfo;
  if (s.tx !== undefined) radio.tx = s.tx;
  radio.responsive = true;
  missedPolls = 0;
  render();

  if (radio.vfo === 'MEM' && !warnedMemory) {
    warnedMemory = true;
    log('Radio is in memory mode — switch to VFO A or B for remote tuning.', 'warn');
  }

  // A change we didn't cause = someone turned the knob / pressed a mode key.
  const userChange = prevHz != null && (radio.hz !== prevHz || radio.mode !== prevMode);
  if (userChange && performance.now() - lastWriteAt > 300 && !pending && cfg.followRadio) {
    radioToSdr();
  }
}

async function pollRadio() {
  try {
    const s = await driver.poll();
    if (s.hz == null) throw new Error('no frequency in answer');
    handleState(s);
  } catch (e) {
    if (e.fatal) throw e;
    if (++missedPolls === 3) {
      radio.responsive = false;
      render();
      log(`Radio stopped answering (${e.message}). Check power, cable, baud rate, flow control.`, 'warn');
    }
  }
}

async function applyToRadio({ hz: sdrHz, mode }) {
  const hz = Math.round(sdrHz + Number(cfg.offsetHz || 0));
  if (hz < driver.minHz || hz > driver.maxHz) {
    log(`${fmtHz(hz)} is outside the ${shortName(driver.model, cfg)} range — not sent.`, 'warn');
    return;
  }
  if (radio.tx) {
    log('Radio is transmitting — retune skipped.', 'warn');
    return;
  }
  let did = false;
  const curMode = RADIO_MODE_TO_SDR[radio.mode] || radio.mode;
  if (cfg.syncMode && mode && driver.canSetMode(mode) && curMode !== mode) {
    await driver.setMode(mode);
    radio.mode = mode;
    did = true;
  }
  if (hz !== radio.hz) {
    await driver.setFreq(hz, { ...radio });
    radio.hz = hz;
    did = true;
  }
  if (did) {
    lastWriteAt = performance.now();
    render();
  }
}

function radioToSdr() {
  if (sdr.tabId == null || radio.hz == null) return;
  const cmd = { hz: radio.hz - Number(cfg.offsetHz || 0) };
  if (cfg.syncMode && RADIO_MODE_TO_SDR[radio.mode]) cmd.mode = RADIO_MODE_TO_SDR[radio.mode];
  lastSdrCmdHz = cmd.hz;
  chrome.tabs.sendMessage(sdr.tabId, { type: 'websdr-cmd', cmd }).catch(() => {
    log('SDR tab is gone or not reachable.', 'warn');
  });
}

/* ---------------------------------------------------------------- I/O scheduler
   All radio traffic goes through this single loop, so writes and polls never
   interleave and a poll answer always reflects every write before it. */

let kick = null;
function wake() {
  if (kick) { const k = kick; kick = null; k(); }
}
function sleepOrWake(ms) {
  return new Promise((r) => {
    const t = setTimeout(() => { kick = null; r(); }, Math.max(0, ms));
    kick = () => { clearTimeout(t); r(); };
  });
}

async function ioLoop() {
  let nextPoll = 0;
  while (connected) {
    try {
      if (pending) {
        const p = pending;
        pending = null;
        await applyToRadio(p);
        continue;
      }
      const now = performance.now();
      if (now >= nextPoll) {
        await pollRadio();
        nextPoll = performance.now() + (cfg.followRadio ? cfg.pollMs : Math.max(cfg.pollMs, 1000));
        continue;
      }
      await sleepOrWake(nextPoll - now);
    } catch (e) {
      if (!connected) break;
      log(e.message, 'err');
      if (e.fatal) { await disconnect(); break; }
      await sleepOrWake(500);
    }
  }
}

function queueSdrToRadio() {
  if (!connected || !cfg.syncToRadio || sdr.hz == null) return;
  pending = { hz: sdr.hz, mode: sdr.mode };
  wake();
}

/* ---------------------------------------------------------------- connect / disconnect */

let connecting = false;

async function pickSerialPort(prompt) {
  if (!('serial' in navigator)) {
    log('Web Serial is not available here. Use Chrome/Edge ≥ 116, or open the panel in a separate window.', 'err');
    return null;
  }
  if (prompt) {
    const t0 = performance.now();
    try {
      return await navigator.serial.requestPort();
    } catch (e) {
      if (e.name === 'NotFoundError' && performance.now() - t0 < 400) {
        // Rejected faster than any human could cancel → Chrome never showed the
        // chooser (it is suppressed in the side panel). Pick in a real tab.
        openPortPicker();
      } else if (e.name === 'NotFoundError') {
        log('No port selected.');
      } else {
        log(`Port selection failed: ${e.name}: ${e.message}`, 'err');
        if (e.name === 'SecurityError' || e.name === 'NotAllowedError') openPortPicker();
      }
      return null;
    }
  }
  const ports = await navigator.serial.getPorts();
  const want = cfg.lastPortInfo;
  const p = ports.find((x) => {
    const i = x.getInfo();
    return want && i.usbVendorId === want.usbVendorId && i.usbProductId === want.usbProductId;
  }) || (ports.length === 1 ? ports[0] : null);
  if (!p && (cfg.lastPortInfo || ports.length)) {
    log('Previously used serial port not found. Click Connect radio… to pick one.', 'warn');
  }
  return p;
}

async function connect({ prompt }) {
  if (connected) return;
  if (connecting) {
    if (prompt) log('Still connecting…');
    return;
  }
  connecting = true;
  try {
    await connectInner(prompt);
  } finally {
    connecting = false;
  }
}

async function connectInner(prompt) {
  const model = currentModel();
  const hamlib = model.family === 'hamlib';
  let port = null;
  if (!hamlib) {
    port = await pickSerialPort(prompt);
    if (!port) return;
  } else if (!prompt && !cfg.hamlibModel && cfg.hamlibMode === 'start') {
    return; // nothing configured yet; don't nag on panel open
  }

  const d = createDriver(model, { port, cfg: { ...cfg }, log, onState: handleState });
  try {
    await d.open();
  } catch (e) {
    log(`Could not open ${hamlib ? 'Hamlib' : 'port'}: ${e.message}`, 'err');
    if (e.hostMissing) checkHamlibHelper();
    else if (!hamlib) log('Is another program (flrig, WSJT-X, Hamlib…) using it? On Linux your user needs to be in the "uucp" (Arch) or "dialout" (Debian/Ubuntu) group.', 'warn');
    try { await d.close(); } catch (_) {}
    return;
  }

  driver = d;
  serialPort = port;
  connected = true;
  radio.hz = radio.mode = radio.vfo = null;
  radio.tx = false;
  radio.responsive = false;
  radio.idText = '';
  missedPolls = 0;
  warnedMemory = false;

  if (port) {
    const info = port.getInfo();
    save('lastPortInfo', { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId });
    log(`${model.name}: port open (${cfg.baudRate} 8N${cfg.stopBits}, flow: ${cfg.flowControl}).`);
  }
  render();

  try {
    radio.idText = await d.identify();
    radio.responsive = true;
    log(`Radio answered${radio.idText ? ': ' + radio.idText : ''}.`);
  } catch (e) {
    if (e.fatal) { log(e.message, 'err'); await disconnect(); return; }
    log(`No answer from the radio (${e.message}). Check baud rate, stop bits, cable${model.family === 'icom' ? ', CI-V address' : ''}. Will keep trying.`, 'warn');
  }
  render();

  ioLoop();
  queueSdrToRadio();
}

async function disconnect() {
  if (!driver) return;
  connected = false;
  wake();
  const d = driver;
  driver = null;
  serialPort = null;
  try { await d.close(); } catch (_) {}
  radio.responsive = false;
  log('Disconnected.');
  render();
}

navigator.serial?.addEventListener('disconnect', (e) => {
  if (serialPort && e.target === serialPort) {
    log('Serial adapter was unplugged.', 'err');
    disconnect();
  }
});

function openPortPicker() {
  log('Chrome did not show the port chooser here. A tab opens to pick the port.');
  // A normal tab, not a popup window: Chrome on Linux also suppresses the chooser in popup windows.
  chrome.tabs.create({ url: chrome.runtime.getURL('pick-port.html'), active: true });
}

/* ---------------------------------------------------------------- Hamlib helper */

let hamlibChecked = false;

async function checkHamlibHelper() {
  const status = $('hamlibStatus');
  const s = new HostSession();
  try {
    s.connect();
    const hello = await s.call('hello', {}, 3000);
    $('hamlibInstall').hidden = true;
    $('hamlibForm').hidden = false;
    if (!hello.rigctld) {
      status.textContent = 'Helper installed, but rigctld was not found. Install Hamlib (Arch: pacman -S hamlib).';
      return;
    }
    status.textContent = `Helper OK · ${hello.rigctld}`;
    if (!hamlibChecked) {
      const [models, ports] = await Promise.all([s.call('list-models', {}, 10000), s.call('list-ports', {}, 3000)]);
      fillDatalist('hamlibModels', models.models.map((m) => [`${m.id} ${m.mfg} ${m.model}${m.status && m.status !== 'Stable' ? ` [${m.status}]` : ''}`, '']));
      fillDatalist('hamlibPorts', ports.ports.map((p) => [p.path, p.label]));
      if (!cfg.hamlibDevice && ports.ports.length) {
        save('hamlibDevice', ports.ports[0].path);
        fillControls();
      }
      hamlibChecked = true;
      status.textContent += ` · ${models.models.length} model${models.models.length === 1 ? '' : 's'}`;
    }
  } catch (e) {
    if (e.hostMissing) {
      status.textContent = 'The Hamlib helper is not installed yet.';
      // The unpacked build has a fixed ID (manifest "key"); store builds need theirs passed.
      $('installCmd').textContent = chrome.runtime.id === 'kpaeajaipgjalgohpjfejkccajdpoiij'
        ? './native/install.sh'
        : `./native/install.sh ${chrome.runtime.id}`;
      $('hamlibInstall').hidden = false;
      $('hamlibForm').hidden = true;
    } else {
      status.textContent = `Helper problem: ${e.message}`;
    }
  } finally {
    s.disconnect();
  }
}

function fillDatalist(id, items) {
  const dl = $(id);
  dl.textContent = '';
  for (const [value, label] of items) {
    const o = document.createElement('option');
    o.value = value;
    if (label) o.label = label;
    dl.appendChild(o);
  }
}

$('copyInstallBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('installCmd').textContent).then(() => log('Install command copied.'));
});
$('recheckBtn').addEventListener('click', () => checkHamlibHelper());
$('hamlibDevice').addEventListener('focus', () => { hamlibChecked = false; checkHamlibHelper(); }, { once: false });

/* ---------------------------------------------------------------- SDR tabs (WebSDR, KiwiSDR, OpenWebRX) */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'port-granted') {
    save('lastPortInfo', msg.info);
    log('Port access granted. Connecting…');
    connect({ prompt: false });
    return;
  }
  if (!msg || msg.type !== 'websdr-state' || !sender.tab) return;
  const tab = sender.tab;
  const active = msg.kind === 'initial' || msg.kind === 'change';

  if (sdr.tabId !== tab.id) {
    // Follow whichever WebSDR tab the user is actually looking at.
    if (!(sdr.tabId == null || (tab.active && active))) return;
    sdr.tabId = tab.id;
    log(`Following ${msg.sdr || 'SDR'} tab: ${msg.host}`);
  }

  sdr.hz = msg.hz;
  sdr.mode = msg.mode;
  sdr.host = msg.host;
  sdr.kind = msg.sdr || 'SDR';
  sdr.title = msg.title;
  render();

  if (msg.kind === 'applied' && lastSdrCmdHz != null) {
    if (Math.abs(msg.hz - lastSdrCmdHz) > 50) {
      log(`This ${sdr.kind || 'SDR'} does not cover ${fmtHz(lastSdrCmdHz)}${sdr.kind.startsWith('OpenWebRX') ? ' in its current profile (pick another band/profile on the page)' : ''} — left unchanged.`, 'warn');
    }
    lastSdrCmdHz = null;
  }

  if (active) queueSdrToRadio();
});

function askTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'websdr-cmd', cmd: { get: true } }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ tabId }) => askTab(tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sdr.tabId) {
    sdr.tabId = null;
    sdr.hz = sdr.mode = null;
    sdr.host = '';
    render();
  }
});

/* ---------------------------------------------------------------- UI wiring */

$('connectBtn').addEventListener('click', () => connect({ prompt: true }));
$('disconnectBtn').addEventListener('click', () => disconnect());
$('pushBtn').addEventListener('click', () => {
  if (!connected || sdr.hz == null) return;
  pending = { hz: sdr.hz, mode: sdr.mode };
  wake();
});
$('pullBtn').addEventListener('click', () => radioToSdr());
$('popoutBtn').addEventListener('click', async () => {
  await disconnect();
  chrome.windows.create({ url: chrome.runtime.getURL('panel.html'), type: 'popup', width: 380, height: 760 });
  window.close();
});
window.addEventListener('pagehide', () => { if (driver) disconnect(); });

(async function init() {
  populateModelSelect();
  await loadSettings();
  bindSettings();
  updateSections();
  if (currentModel().family === 'hamlib') checkHamlibHelper();
  const tabs = await chrome.tabs.query({ active: true });
  for (const t of tabs) askTab(t.id);
  if (cfg.autoConnect) connect({ prompt: false });
})();
