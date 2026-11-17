// Combines sound fingerprint and motion (how the phone rocks) to tell sides apart.
// Which signal to trust is decided per table and phone from the calibration taps themselves.
import { Knn, N_FEAT, shapeFeatures, SHAPE_DIM } from '../engine/dsp';
import { MOTION_DIM } from './motion';

export type Method = 'sound' | 'motion' | 'both';
export interface SideTap { zone: number; feat: number[]; motion?: number[] | null }


/**
 * Direction of the jolt only: rotation (x, y, z) and acceleration (x, y, z) each scaled to length 1.
 * A soft and a hard tap on the same side then look alike; how hard you tapped only sets the volume.
 */
export function motionDirection(m: number[]): number[] {
  const unit = (a: number[]) => { const n = Math.hypot(...a); return n > 1e-6 ? a.map(v => v / n) : a.map(() => 0); };
  return [...unit(m.slice(0, 3)), ...unit(m.slice(3, 6))];
}

export type SoundMode = 'raw' | 'shape';
const soundVec = (f: number[], sm: SoundMode) => sm === 'shape' ? Array.from(shapeFeatures(f)) : f;

export function vectorOf(t: { feat: number[]; motion?: number[] | null }, m: Method, sm: SoundMode = 'raw'): number[] | null {
  if (m === 'sound') return soundVec(t.feat, sm);
  if (!t.motion) return null;
  const dir = motionDirection(t.motion);
  return m === 'motion' ? dir : [...soundVec(t.feat, sm), ...dir];
}
const weightsOf = (m: Method, sm: SoundMode = 'raw') => {
  const ns = sm === 'shape' ? SHAPE_DIM : N_FEAT;
  return m === 'both' ? [...Array(ns).fill(1), ...Array(MOTION_DIM).fill(Math.sqrt(ns / MOTION_DIM))] : undefined;
};
/** Size of the jolt (rotation part): soft taps barely move the phone, so their direction is mostly noise. */
export const joltSize = (m: number[]) => Math.hypot(m[0], m[1], m[2]);

/** Leave-one-out accuracy of one method on calibration taps (taps lacking motion are skipped for motion methods). */
export function looAccuracy(taps: SideTap[], m: Method, sm: SoundMode = 'raw'): { acc: number; n: number } {
  const usable = taps.map(t => ({ t, v: vectorOf(t, m, sm) })).filter(x => x.v) as { t: SideTap; v: number[] }[];
  if (usable.length < 8 || new Set(usable.map(u => u.t.zone)).size < 2) return { acc: 0, n: usable.length };
  const knn = new Knn(usable.map(u => u.v), usable.map(u => u.t.zone), 3, weightsOf(m, sm)), o = { dist: 0, conf: 0 };
  let ok = 0; usable.forEach((u, i) => { if (knn.predict(u.v, o, i) === u.t.zone) ok++; });
  return { acc: ok / usable.length, n: usable.length };
}

/** Leave-one-out confusion for one method: per-side accuracy and the most mixed-up pair. */
export function confusion(taps: SideTap[], m: Method, sm: SoundMode = 'raw') {
  const usable = taps.map(t => ({ t, v: vectorOf(t, m, sm) })).filter(x => x.v) as { t: SideTap; v: number[] }[];
  const M = Array.from({ length: 4 }, () => Array(4).fill(0));
  if (usable.length >= 8) {
    const knn = new Knn(usable.map(u => u.v), usable.map(u => u.t.zone), 3, weightsOf(m, sm)), o = { dist: 0, conf: 0 };
    usable.forEach((u, i) => { M[u.t.zone][knn.predict(u.v, o, i)]++; });
  }
  const perSide = M.map((row, z) => { const n = row.reduce((a, b) => a + b, 0); return n ? row[z] / n : 0; });
  let worst = { a: 0, b: 1, n: 0 };
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (M[a][b] + M[b][a] > worst.n) worst = { a, b, n: M[a][b] + M[b][a] };
  return { perSide, worst: worst.n ? worst : null };
}

export interface MethodChoice { method: Method; soundMode: SoundMode; scores: Record<Method, number> }

/**
 * Picks the method. Motion-based methods add ~50 ms of lag in a browser, so they must clearly win (by 8 points)
 * and need motion on most calibration taps.
 */
export function chooseMethod(taps: SideTap[]): MethodChoice {
  const withMotion = taps.filter(t => t.motion).length;
  // which sound fingerprint holds up on this table: absolute levels, or the force-resistant shape (needs a clear win)
  const raw = looAccuracy(taps, 'sound', 'raw').acc, shape = looAccuracy(taps, 'sound', 'shape').acc;
  const soundMode: SoundMode = shape >= raw + 0 ? 'shape' : 'raw';
  const scores = { sound: Math.max(raw, soundMode === 'shape' ? shape : raw), motion: 0, both: 0 } as Record<Method, number>;
  if (withMotion >= taps.length * 0.8) { scores.motion = looAccuracy(taps, 'motion').acc; scores.both = looAccuracy(taps, 'both', soundMode).acc; }
  let method: Method = 'sound';
  const bestMotion = scores.both >= scores.motion ? 'both' : 'motion';
  if (scores[bestMotion] >= scores.sound + 0.08) method = bestMotion;
  return { method, soundMode, scores };
}

/** Zone classifier for the chosen method. */
export class SideClassifier {
  private knn: Knn; private o = { dist: 0, conf: 0 }; private minJolt = 0;
  constructor(taps: SideTap[], readonly method: Method, readonly soundMode: SoundMode = 'raw') {
    const usable = taps.map(t => ({ z: t.zone, v: vectorOf(t, method, soundMode), j: t.motion ? joltSize(t.motion) : 0 })).filter(x => x.v) as { z: number; v: number[]; j: number }[];
    this.knn = new Knn(usable.map(u => u.v), usable.map(u => u.z), 3, weightsOf(method, soundMode));
    const js = usable.map(u => u.j).sort((a, b) => a - b);
    this.minJolt = js.length ? 0.3 * js[Math.floor(js.length / 2)] : 0;
  }
  /** Returns zone and confidence, or null if the needed data is missing or the jolt is too weak to trust. */
  classify(feat: number[], motionFeat: number[] | null) {
    if (this.method !== 'sound' && motionFeat && joltSize(motionFeat) < this.minJolt) return null; // too soft: let sound decide
    const v = vectorOf({ feat, motion: motionFeat }, this.method, this.soundMode);
    if (!v) return null;
    const zone = this.knn.predict(v, this.o);
    return { zone, confidence: this.o.conf, dist: this.o.dist };
  }
}
