import rsaAp from './rsa-ap.js';
import pycAp from './pyc-ap.js';
import nativeAp from './native-ap.js';
import { nativeAx, pycAx } from './axillary.js';
import { rsaCt, nativeCt, pycCt } from './ct.js';
import { nativeY } from './yview.js';

export const PROTOCOLS = {
  'rsa-ap': rsaAp, 'pyc-ap': pycAp, 'native-ap': nativeAp, 'native-ax': nativeAx, 'pyc-ax': pycAx, 'native-y': nativeY,
  'rsa-ct': rsaCt, 'native-ct': nativeCt, 'pyc-ct': pycCt,
};

export const IMPLANTS = [
  { id: 'reverse', label: 'Reverse replacement', blurb: 'Lateralisation, distalisation, glenosphere tilt and overhang, notching, stem fit.' },
  { id: 'pyc', label: 'Pyrocarbon hemiarthroplasty', blurb: 'Overstuffing, head centring, glenoid erosion, tuberosity, stem fit.' },
  { id: 'native', label: 'Native shoulder', blurb: 'Cuff and arthritis indices, glenoid version and wear, muscles — and anatomic versus reverse.' },
];

/** Protocol for an implant type, modality ('xray' | 'ct') and radiographic view ('ap' | 'axillary' | 'y'). */
export function protocolFor(implant, modality, view = 'ap') {
  if (modality === 'ct') return PROTOCOLS[{ reverse: 'rsa-ct', pyc: 'pyc-ct', native: 'native-ct' }[implant]];
  if (view === 'axillary' && implant !== 'reverse') return PROTOCOLS[implant === 'pyc' ? 'pyc-ax' : 'native-ax'];
  if (view === 'y' && implant === 'native') return PROTOCOLS['native-y'];
  return PROTOCOLS[{ reverse: 'rsa-ap', pyc: 'pyc-ap', native: 'native-ap' }[implant]];
}

export function viewsFor(implant) {
  return implant === 'reverse' ? ['ap'] : implant === 'native' ? ['ap', 'axillary', 'y'] : ['ap', 'axillary'];
}

export const VIEW_LABEL = { ap: 'AP (Grashey)', axillary: 'Axillary', y: 'Scapular Y' };
