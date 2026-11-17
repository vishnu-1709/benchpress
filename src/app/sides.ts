// Combines sound fingerprint and motion (how the phone rocks) to tell sides apart.
// Which signal to trust is decided per table and phone from the calibration taps themselves.
import { Knn, N_FEAT } from '../engine/dsp';
import { MOTION_DIM } from './motion';

export type Method = 'sound' | 'motion' | 'both';
export interface SideTap { zone: number; feat: number[]; motion?: number[] | null }

const MOTION_W = Math.sqrt(N_FEAT / MOTION_DIM); // so sound and motion weigh about the same in 'both'

export function vectorOf(t: { feat: number[]; motion?: number[] | null }, m: Method): number[] | null {
  if (m === 'sound') return t.feat;
  if (!t.motion) return null;
  return m === 'motion' ? t.motion : [...t.feat, ...t.motion];
}
const weightsOf = (m: Method) => m === 'both' ? [...Array(N_FEAT).fill(1), ...Array(MOTION_DIM).fill(MOTION_W)] : undefined;

/** Leave-one-out accuracy of one method on calibration taps (taps lacking motion are skipped for motion methods). */
export function looAccuracy(taps: SideTap[], m: Method): { acc: number; n: number } {
  const usable = taps.map(t => ({ t, v: vectorOf(t, m) })).filter(x => x.v) as { t: SideTap; v: number[] }[];
  if (usable.length < 8 || new Set(usable.map(u => u.t.zone)).size < 2) return { acc: 0, n: usable.length };
  const knn = new Knn(usable.map(u => u.v), usable.map(u => u.t.zone), 3, weightsOf(m)), o = { dist: 0, conf: 0 };
  let ok = 0; usable.forEach((u, i) => { if (knn.predict(u.v, o, i) === u.t.zone) ok++; });
  return { acc: ok / usable.length, n: usable.length };
}

export interface MethodChoice { method: Method; scores: Record<Method, number> }

/**
 * Picks the method. Motion-based methods add ~50 ms of lag in a browser, so they must clearly win (by 8 points)
 * and need motion on most calibration taps.
 */
export function chooseMethod(taps: SideTap[]): MethodChoice {
  const withMotion = taps.filter(t => t.motion).length;
  const scores = { sound: looAccuracy(taps, 'sound').acc, motion: 0, both: 0 } as Record<Method, number>;
  if (withMotion >= taps.length * 0.8) { scores.motion = looAccuracy(taps, 'motion').acc; scores.both = looAccuracy(taps, 'both').acc; }
  let method: Method = 'sound';
  const bestMotion = scores.both >= scores.motion ? 'both' : 'motion';
  if (scores[bestMotion] >= scores.sound + 0.08) method = bestMotion;
  return { method, scores };
}

/** Zone classifier for the chosen method. */
export class SideClassifier {
  private knn: Knn; private o = { dist: 0, conf: 0 };
  constructor(taps: SideTap[], readonly method: Method) {
    const usable = taps.map(t => ({ z: t.zone, v: vectorOf(t, method) })).filter(x => x.v) as { z: number; v: number[] }[];
    this.knn = new Knn(usable.map(u => u.v), usable.map(u => u.z), 3, weightsOf(method));
  }
  /** Returns zone and confidence, or null if the needed data is missing (e.g. no motion readings). */
  classify(feat: number[], motionFeat: number[] | null) {
    const v = vectorOf({ feat, motion: motionFeat }, this.method);
    if (!v) return null;
    const zone = this.knn.predict(v, this.o);
    return { zone, confidence: this.o.conf, dist: this.o.dist };
  }
}
