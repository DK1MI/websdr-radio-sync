// Radios with a built-in driver, plus the Hamlib catch-all.
// baud/stop/flow are only defaults applied when the model is picked; they must match
// the radio's CAT menu. flow: 'hardware' = RTS/CTS, 'none' = RTS+DTR held high,
// 'none-low' = RTS+DTR held low (avoids keying radios that use them for PTT/CW).
import { KenwoodDriver } from './kenwood.js';
import { YaesuDriver } from './yaesu.js';
import { YaesuLegacyDriver } from './yaesu-legacy.js';
import { IcomDriver } from './icom.js';
import { HamlibDriver } from './hamlib.js';

const M = 1e6;

const kw = (id, name, maxHz, baud = 9600, stop = 1, flow = 'hardware') =>
  ({ id, name, group: 'Kenwood', family: 'kenwood', maxHz, baud, stop, flow });
const kc = (group, id, name, maxHz, baud, flow = 'none-low') =>
  ({ id, name, group, family: 'kenwood', maxHz, baud, stop: 1, flow });
const ya = (id, name, digits, maxHz) =>
  ({ id, name, group: 'Yaesu', family: 'yaesu', digits, maxHz, baud: 4800, stop: 1, flow: 'none' });
const yl = (id, name, extra = {}) =>
  ({ id, name, group: 'Yaesu (FT-817 family)', family: 'yaesu-legacy', maxHz: 470 * M, baud: 4800, stop: 2, flow: 'none-low', ...extra });
const ic = (id, name, civ, maxHz, baud = 19200, extra = {}) =>
  ({ id, name, group: 'Icom', family: 'icom', civ, maxHz, baud, stop: 1, flow: 'none-low', ...extra });
const xg = (id, name, civ, maxHz) =>
  ({ id, name, group: 'Xiegu (CI-V)', family: 'icom', civ, maxHz, baud: 19200, stop: 1, flow: 'none-low' });

export const MODELS = [
  kw('ts50', 'Kenwood TS-50S', 30 * M, 4800, 2),
  kw('ts140', 'Kenwood TS-140S', 30 * M, 4800, 2),
  kw('ts440', 'Kenwood TS-440S', 30 * M, 4800, 2),
  kw('ts450', 'Kenwood TS-450S', 30 * M, 4800, 2),
  kw('ts480', 'Kenwood TS-480SAT/HX', 60 * M),
  kw('ts570', 'Kenwood TS-570D/S', 60 * M),
  kw('ts590', 'Kenwood TS-590S/SG', 60 * M),
  kw('ts680', 'Kenwood TS-680S', 60 * M, 4800, 2),
  kw('ts690', 'Kenwood TS-690S', 60 * M, 4800, 2),
  kw('ts850', 'Kenwood TS-850S', 30 * M, 4800, 2),
  kw('ts870', 'Kenwood TS-870S', 60 * M),
  kw('ts890', 'Kenwood TS-890S', 60 * M, 115200),
  kw('ts950', 'Kenwood TS-950S/SDX', 30 * M, 4800, 2),
  kw('ts990', 'Kenwood TS-990S', 60 * M, 115200),
  kw('ts2000', 'Kenwood TS-2000', 1300 * M),
  kw('ts711', 'Kenwood TS-711/811', 450 * M, 4800, 2),

  kc('Elecraft', 'k2', 'Elecraft K2', 30 * M, 4800),
  kc('Elecraft', 'k3', 'Elecraft K3/K3S', 60 * M, 38400),
  kc('Elecraft', 'k4', 'Elecraft K4', 60 * M, 38400),
  kc('Elecraft', 'kx2', 'Elecraft KX2', 60 * M, 38400),
  kc('Elecraft', 'kx3', 'Elecraft KX3', 60 * M, 38400),

  kc('Kenwood-compatible', 'flex', 'FlexRadio (SmartSDR CAT)', 60 * M, 9600),
  kc('Kenwood-compatible', 'qrplabs', 'QRP Labs QDX/QMX/QCX', 60 * M, 9600),
  kc('Kenwood-compatible', 'trusdx', 'truSDX / uSDX', 60 * M, 38400),
  kc('Kenwood-compatible', 'tx500', 'Lab599 TX-500', 60 * M, 9600),
  kc('Kenwood-compatible', 'sdrconsole', 'SDR software (TS-2000 emulation)', 2000 * M, 9600),
  kc('Kenwood-compatible', 'kenwood-generic', 'Other Kenwood-compatible', 2000 * M, 9600),

  ya('ft450', 'Yaesu FT-450/450D', 8, 56 * M),
  ya('ft710', 'Yaesu FT-710', 9, 56 * M),
  ya('ft891', 'Yaesu FT-891', 9, 56 * M),
  ya('ft950', 'Yaesu FT-950', 8, 56 * M),
  ya('ft991', 'Yaesu FT-991/991A', 9, 470 * M),
  ya('ft2000', 'Yaesu FT-2000', 8, 60 * M),
  ya('ftdx10', 'Yaesu FTDX10', 9, 56 * M),
  ya('ftdx101', 'Yaesu FTDX101D/MP', 9, 75 * M),
  ya('ftdx1200', 'Yaesu FTDX1200', 8, 56 * M),
  ya('ftdx3000', 'Yaesu FTDX3000', 8, 56 * M),
  ya('ftdx5000', 'Yaesu FTDX5000', 8, 60 * M),

  yl('ft817', 'Yaesu FT-817/818'),
  yl('ft857', 'Yaesu FT-857'),
  yl('ft897', 'Yaesu FT-897'),
  yl('ft847', 'Yaesu FT-847', { baud: 57600, catOn: true, noTxStatus: true }),

  ic('ic705', 'Icom IC-705', 'A4', 470 * M),
  ic('ic706', 'Icom IC-706', '48', 148 * M, 9600),
  ic('ic706mk2', 'Icom IC-706MkII', '4E', 148 * M, 9600),
  ic('ic706mk2g', 'Icom IC-706MkIIG', '58', 450 * M, 9600),
  ic('ic718', 'Icom IC-718', '5E', 30 * M, 9600),
  ic('ic735', 'Icom IC-735', '04', 30 * M, 1200, { freqBytes: 4 }),
  ic('ic746', 'Icom IC-746', '56', 148 * M, 9600),
  ic('ic746pro', 'Icom IC-746PRO', '66', 148 * M),
  ic('ic756pro2', 'Icom IC-756PROII', '64', 60 * M),
  ic('ic756pro3', 'Icom IC-756PROIII', '6E', 60 * M),
  ic('ic910', 'Icom IC-910H', '60', 1300 * M),
  ic('ic7000', 'Icom IC-7000', '70', 470 * M),
  ic('ic7100', 'Icom IC-7100', '88', 470 * M),
  ic('ic7200', 'Icom IC-7200', '76', 60 * M),
  ic('ic7300', 'Icom IC-7300', '94', 75 * M),
  ic('ic7410', 'Icom IC-7410', '80', 60 * M),
  ic('ic7600', 'Icom IC-7600', '7A', 60 * M),
  ic('ic7610', 'Icom IC-7610', '98', 75 * M),
  ic('ic7700', 'Icom IC-7700', '74', 60 * M),
  ic('ic7800', 'Icom IC-7800', '6A', 60 * M),
  ic('ic7851', 'Icom IC-7851', '8E', 60 * M),
  ic('ic9100', 'Icom IC-9100', '7C', 1300 * M),
  ic('ic9700', 'Icom IC-9700', 'A2', 1300 * M),
  ic('icr75', 'Icom IC-R75', '5A', 60 * M),
  ic('icr8600', 'Icom IC-R8600', '96', 3000 * M),
  ic('icom-generic', 'Other Icom CI-V (set address)', '94', 3000 * M),

  xg('g90', 'Xiegu G90', '88', 30 * M),
  xg('x6100', 'Xiegu X6100', '70', 60 * M),
  xg('x5105', 'Xiegu X5105', '70', 60 * M),

  { id: 'hamlib', name: 'Hamlib (rigctld): any supported radio', group: 'Hamlib', family: 'hamlib', baud: 9600, stop: 1, flow: 'none' },
];

const DRIVERS = {
  kenwood: KenwoodDriver,
  yaesu: YaesuDriver,
  'yaesu-legacy': YaesuLegacyDriver,
  icom: IcomDriver,
  hamlib: HamlibDriver,
};

export function findModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === 'ts570');
}

export function createDriver(model, opts) {
  return new DRIVERS[model.family]({ model, ...opts });
}

// Short display name for the radio card header.
export function shortName(model, cfg) {
  if (model.family === 'hamlib') return cfg.hamlibName || 'Hamlib';
  return model.name.replace(/\s*\(.*\)$/, '').replace(/^(Kenwood|Icom|Yaesu|Elecraft|Xiegu) /, '');
}
