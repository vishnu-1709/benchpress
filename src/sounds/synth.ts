// Offline sound rendering into plain Float32Arrays (no Web Audio needed, so it also runs in tests).
// These are placeholder sounds: recorded samples replace them later through the same pack interface.

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export class Buf {
  readonly d: Float32Array;
  constructor(readonly sr: number, sec: number) { this.d = new Float32Array(Math.ceil(sr * sec)); }
  get len() { return this.d.length; }
  /** Add a mono source rendered by fn(sample index, time) with optional start offset (s). */
  add(fn: (i: number, t: number) => number, startSec = 0, durSec = this.len / this.sr) {
    const a = Math.round(startSec * this.sr), n = Math.min(this.len - a, Math.round(durSec * this.sr));
    for (let i = 0; i < n; i++) this.d[a + i] += fn(i, i / this.sr);
    return this;
  }
  mix(src: Float32Array, gain = 1, startSec = 0) {
    const a = Math.round(startSec * this.sr);
    for (let i = 0; i < src.length && a + i < this.len; i++) this.d[a + i] += src[i] * gain;
    return this;
  }
  /** Peak-normalise to target and trim trailing silence. */
  done(peak = 0.9): Float32Array {
    let m = 1e-9; for (const v of this.d) m = Math.max(m, Math.abs(v));
    const g = peak / m; let end = this.len;
    while (end > 1 && Math.abs(this.d[end - 1] * g) < 1e-4) end--;
    const out = this.d.slice(0, end);
    for (let i = 0; i < out.length; i++) out[i] *= g;
    const fade = Math.min(out.length, Math.round(this.sr * 0.01)); // de-click tail
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
    return out;
  }
}

/** RBJ biquad, filter a buffer in place. */
export function biquad(x: Float32Array, sr: number, type: 'lp' | 'hp' | 'bp', f: number, q = 0.707) {
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}

export function noise(sr: number, sec: number, seed: number, decay: number) {
  const r = rng(seed), n = Math.ceil(sr * sec), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (r() * 2 - 1) * Math.exp(-i / sr * decay);
  return x;
}

/** Pitch sweep with exponential amplitude decay (kicks, toms, dhol bass). */
export function sweep(sr: number, f0: number, f1: number, sweepSec: number, decay: number, sec: number) {
  const x = new Float32Array(Math.ceil(sr * sec)); let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t / sweepSec);
    ph += 2 * Math.PI * f / sr; x[i] = Math.sin(ph) * Math.exp(-t * decay);
  }
  return x;
}

export function tone(sr: number, f: number, decay: number, sec: number, partials: [number, number][] = [[1, 1]]) {
  const x = new Float32Array(Math.ceil(sr * sec));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr; let v = 0;
    for (const [h, a] of partials) v += a * Math.sin(2 * Math.PI * f * h * t);
    x[i] = v * Math.exp(-t * decay) * Math.min(1, i / (sr * 0.002));
  }
  return x;
}

/** Karplus-Strong plucked string. buzz > 0 adds a sitar-like jawari rattle. */
export function pluck(sr: number, f: number, sec: number, seed: number, opts: { damp?: number; bright?: number; buzz?: number } = {}) {
  const r = rng(seed), p = Math.max(2, Math.round(sr / f)), line = new Float32Array(p);
  const bright = opts.bright ?? 0.5, damp = opts.damp ?? 0.996, buzz = opts.buzz ?? 0;
  let prev = 0;
  for (let i = 0; i < p; i++) { const w = r() * 2 - 1; prev = bright * w + (1 - bright) * prev; line[i] = prev; }
  const n = Math.ceil(sr * sec), x = new Float32Array(n); let idx = 0;
  for (let i = 0; i < n; i++) {
    const nx = (idx + 1) % p, v = (line[idx] + line[nx]) * 0.5 * damp;
    let o = line[idx];
    if (buzz > 0) { const a = Math.abs(o); o = o + buzz * Math.sign(o) * Math.max(0, a - 0.15) * 2.5 + buzz * 0.3 * Math.tanh(o * 6) * a; }
    x[i] = o; line[idx] = v; idx = nx;
  }
  return x;
}
