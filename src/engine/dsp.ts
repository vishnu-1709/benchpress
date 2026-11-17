// Pure DSP core. No DOM, no Web Audio: runs in the AudioWorklet, in Node tests and anywhere else.
// Hot path (process) allocates nothing after construction.
import type { DspConfig, TableModel } from './protocol';

export const N_BANDS = 24;
export const N_FEAT = N_BANDS + 2; // bands + spectral centroid + decay ratio

export interface Onset { frame: number; peak: number; rms: number; feat: Float64Array }

/**
 * Onset detector + feature extractor working on a stream of mono blocks.
 *
 * Echo rejection (phone speaker): every sound the app plays has an attack, and that attack reaches the mic a fixed
 * delay later. The detector watches its own output for attacks, learns the delay from a histogram of
 * (mic onset - output attack) times, where echoes pile up at one value and real taps spread out, and ignores mic
 * onsets that land right on an expected echo. Until the delay is known it ignores a wide window instead.
 */
export class TapDetector {
  readonly sr: number;
  private cfg: DspConfig;
  private hop: number;
  private ringLen: number;
  private ring: Float32Array;
  total = 0; // samples seen (absolute frame counter)
  private hpA: number; private hpX = 0; private hpY = 0;
  private acc = 0; private accN = 0;
  private hist = new Float64Array(8); private hi = 0;
  noise = 1e-4;
  private lastOnset = -1e12;
  private pendingOnset = -1; private pendingDue = -1; private pendingRms = 0;
  private nfft = 1; private winN = 0; private preN = 0;
  private re: Float64Array; private im: Float64Array; private hann: Float64Array;
  private bandOf: Int16Array;
  readonly feat = new Float64Array(N_FEAT);
  lastRms = 0;

  // ---- echo rejection state (all in 1 ms frames) ----
  private gate = false;
  private outEnv = new Float32Array(1024); private outFrames = 0; private outAcc = 0; private outN = 0;
  private attacks = new Float64Array(64); private spreads = new Float32Array(64); private learnable = new Uint8Array(64); private attackN = 0; // our sound starts
  private matchedLearnable = false;
  private checked = new Uint8Array(64);
  private soundsSeen = 0;       // played sounds whose echo window has passed
  /** True once we've seen that our own sounds don't reach the mic loudly enough to matter. */
  quietSpeaker = false;
  private delayHist = new Float32Array(200);                    // 2 ms bins, 0..400 ms
  private delayMs: number | null = null; private delayLearned = false; private delayLocked = false;
  leak = 0.45;                 // mic level / output level at the echo delay: learned from identified echoes
  private echoMargin = 1.5;      // outside attack windows, a tap must be this much louder than the expected echo
  /** How many onsets were rejected as echoes (debug / tests). */
  echoesRejected = 0;
  /** Onsets dropped for being under the tap floor, and onsets accepted (debug). */
  tooQuiet = 0; onsets = 0;
  get minLevel() { return this.cfg.minLevel; }
  /** Echo delay (ms): measured or learned, null if unknown. */
  get echoDelayMs() { return this.delayMs; }
  get echoDelayLearned() { return this.delayLearned; }

  constructor(sr: number, cfg: DspConfig) {
    this.sr = sr; this.cfg = { ...cfg };
    this.hop = Math.max(1, Math.round(sr * 0.001));
    this.ringLen = Math.ceil(sr * 0.25);
    this.ring = new Float32Array(this.ringLen);
    this.hpA = Math.exp(-2 * Math.PI * 40 / sr);
    this.re = new Float64Array(0); this.im = new Float64Array(0); this.hann = new Float64Array(0); this.bandOf = new Int16Array(0);
    this.setConfig(cfg);
  }

  setConfig(cfg: DspConfig) {
    this.cfg = { ...cfg };
    this.preN = Math.round(this.sr * 0.001);
    this.winN = this.preN + Math.round(this.sr * cfg.postMs / 1000);
    this.nfft = 1; while (this.nfft < this.winN) this.nfft <<= 1;
    this.re = new Float64Array(this.nfft); this.im = new Float64Array(this.nfft);
    this.hann = new Float64Array(this.winN);
    for (let i = 0; i < this.winN; i++) this.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.winN - 1));
    // map FFT bins to log-spaced bands (80 Hz .. 16 kHz), -1 = unused
    const lo = 80, hi = Math.min(16000, this.sr / 2 - 1);
    this.bandOf = new Int16Array(this.nfft / 2).fill(-1);
    for (let k = 1; k < this.nfft / 2; k++) {
      const f = k * this.sr / this.nfft;
      if (f < lo || f >= hi) continue;
      this.bandOf[k] = Math.min(N_BANDS - 1, Math.floor(Math.log(f / lo) / Math.log(hi / lo) * N_BANDS));
    }
  }

  /** Echo rejection on (phone speaker) or off (headphones). measuredDelayFrames: from the click test, if it worked. */
  setEchoGate(on: boolean, measuredDelayFrames: number | null = null, measuredLeak: number | null = null) {
    this.gate = on;
    // a measured delay (click into silence) is trusted: rhythmic tapping must not re-teach it
    if (measuredDelayFrames != null) { this.delayMs = measuredDelayFrames * 1000 / this.sr; this.delayLearned = true; this.delayLocked = true; }
    if (measuredLeak != null) this.leak = Math.max(0.02, measuredLeak);
    if (measuredLeak != null && measuredLeak < 0.05) this.quietSpeaker = true;
  }

  /**
   * The app is starting a sound at sample `frame`. spreadMs: how long its attacks last (a strum's 6 strings ~100 ms).
   * Echoes of it will be ignored; the delay to its echo is learned from these events.
   */
  noteOutputStart(frame: number, spreadMs = 20, inLevel = true) {
    const f = Math.floor(frame / this.hop), k = this.attackN & 63;
    this.attacks[k] = f; this.spreads[k] = spreadMs; this.learnable[k] = inLevel ? 1 : 0; this.checked[k] = 0; this.attackN++;
  }

  /** Feed every output block right after rendering it, so the detector knows what it will hear back. */
  feedOutput(block: Float32Array) {
    for (let i = 0; i < block.length; i++) {
      this.outAcc += block[i] * block[i]; this.outN++;
      if (this.outN === this.hop) {
        const v = Math.sqrt(this.outAcc / this.hop), f = this.outFrames;
        this.outEnv[f & 1023] = v; this.outFrames++; this.outAcc = 0; this.outN = 0;
      }
    }
  }

  /** Is ms-frame f where an echo of our own output would land? Also feeds the delay histogram. */
  private isEcho(f: number, learn: boolean): boolean {
    let echo = false; this.matchedLearnable = false;
    const n = Math.min(this.attackN, 64);
    for (let i = 0; i < n; i++) {
      const k = (this.attackN - 1 - i) & 63, d = f - this.attacks[k];
      if (d < 0 || d > 500) continue;
      // echoes on phones come back within ~170 ms; longer gaps are more likely the rhythm of real taps
      if (learn && !this.delayLocked && d < 170) this.delayHist[Math.floor(d / 2)] += 1;
      if (this.delayMs == null) { if (!this.quietSpeaker && d >= 5 && d <= 150 + this.spreads[k]) echo = true; } // unknown: wide (matches the learnable echo range)
      else if (d >= this.delayMs - 10 && d <= this.delayMs + 15 + this.spreads[k]) { echo = true; if (this.learnable[k] && Math.abs(d - this.delayMs) <= 8) this.matchedLearnable = true; }
    }
    if (learn && !this.delayLocked) this.updateDelay();
    return echo;
  }

  /**
   * Echoes always come back at the same delay; taps come at random times. If several sounds have played and no
   * consistent delay has appeared in the histogram, our speaker isn't reaching the mic: relax.
   */
  private checkSilentEchoes(f: number) {
    const n = Math.min(this.attackN, 64);
    for (let i = 0; i < n; i++) {
      const k = (this.attackN - 1 - i) & 63;
      if (this.checked[k] || !this.learnable[k] || f - this.attacks[k] < 400) continue;
      this.checked[k] = 1; this.soundsSeen++;
      if (!this.delayLearned && this.soundsSeen >= 8) { this.quietSpeaker = true; this.leak = Math.max(0.03, this.leak * 0.8); }
    }
    if (this.delayLearned) this.quietSpeaker = false;
  }

  /** Loudest own output that could be arriving at the mic now (ms-frame f). */
  private echoLevel(f: number): number {
    let a: number, b: number;
    if (this.delayMs == null) { a = f - 350; b = f - 3; } else { a = f - this.delayMs - 8; b = f - this.delayMs + 8; }
    a = Math.max(a, this.outFrames - 1000, 0); b = Math.min(b, this.outFrames - 1);
    let m = 0; for (let j = a; j <= b; j++) { const v = this.outEnv[j & 1023]; if (v > m) m = v; }
    return m;
  }

  private updateDelay() {
    let best = 0, bestI = -1, sum = 0;
    for (let i = 0; i < 200; i++) {
      const v = this.delayHist[i] + 0.5 * ((this.delayHist[i - 1] ?? 0) + (this.delayHist[i + 1] ?? 0));
      sum += this.delayHist[i]; if (v > best) { best = v; bestI = i; }
    }
    // echoes stack in one bin; taps spread over all of them
    if (bestI >= 0 && best >= 5 && best > 10 * sum / 200) { this.delayMs = bestI * 2 + 1; this.delayLearned = true; }
    if (sum > 400) for (let i = 0; i < 200; i++) this.delayHist[i] *= 0.5;   // keep adapting
  }

  /** Feed one block. Calls onTap for every completed onset (feature vector is reused: copy it if kept). */
  process(block: Float32Array, onTap: (o: Onset) => void) {
    const { threshold, rise, refractoryMs, minLevel } = this.cfg;
    let blockPow = 0;
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = this.hpA * (this.hpY + x - this.hpX); this.hpX = x; this.hpY = y;
      this.ring[this.total % this.ringLen] = y; this.total++;
      this.acc += y * y; this.accN++; blockPow += y * y;
      if (this.accN === this.hop) {
        const rms = Math.sqrt(this.acc / this.hop); this.acc = 0; this.accN = 0;
        this.hist[this.hi & 7] = rms; this.hi++;
        const past = this.hist[(this.hi - 6) & 7];
        // noise floor: falls fast, rises slowly (about 2x per 7 s) so ringing sounds don't drown out taps
        this.noise = rms < this.noise ? 0.9 * this.noise + 0.1 * rms : this.noise * 1.0001;
        if (this.hi < 50) { this.noise = Math.max(this.noise, rms); continue; }
        if (this.gate) this.checkSilentEchoes(this.hi - 1);
        const since = (this.total - this.lastOnset) * 1000 / this.sr;
        // while our own sound rings, a tap only adds to it: ask for a smaller jump
        const ringing = this.gate && this.outEnv[(this.outFrames - 1) & 1023] > 0.003;
        const needRise = ringing ? Math.min(rise, 3) : rise;
        const looksLikeOnset = this.pendingOnset < 0 && rms > this.noise * threshold && rms > past * needRise && since > refractoryMs;
        if (looksLikeOnset && rms <= minLevel) { this.tooQuiet++; this.lastOnset = this.total; continue; }
        if (looksLikeOnset) {
          this.lastOnset = this.total;
          if (this.gate) {
            const f = this.hi - 1, lvl = this.echoLevel(f);
            if (this.isEcho(f, true)) {
              // a known echo: learn how loud our echoes are at the mic
              if (this.matchedLearnable && lvl > 0.01) {
                const r = Math.min(1.5, rms / lvl); this.leak = r > this.leak ? 0.5 * (this.leak + r) : 0.95 * this.leak + 0.05 * r;
              }
              this.echoesRejected++; continue;
            }
            if (rms < this.echoMargin * this.leak * lvl) { this.echoesRejected++; continue; } // not louder than our own echo
          }
          this.pendingOnset = this.total - this.hop; this.pendingRms = rms; this.onsets++;
          this.pendingDue = this.pendingOnset + this.winN - this.preN;
        }
      }
      if (this.pendingOnset >= 0 && this.total >= this.pendingDue) {
        const peak = this.extract(this.pendingOnset);
        onTap({ frame: this.pendingOnset, peak, rms: this.pendingRms, feat: this.feat });
        this.pendingOnset = -1;
      }
    }
    this.lastRms = Math.sqrt(blockPow / Math.max(1, block.length));
  }

  private extract(onset: number): number {
    const start = onset - this.preN, re = this.re, im = this.im, n = this.nfft;
    let peak = 0, early = 0, late = 0;
    const half = this.winN >> 1;
    for (let i = 0; i < n; i++) {
      if (i < this.winN) {
        const v = this.ring[((start + i) % this.ringLen + this.ringLen) % this.ringLen];
        const a = v < 0 ? -v : v; if (a > peak) peak = a;
        if (i < half) early += v * v; else late += v * v;
        re[i] = v * this.hann[i];
      } else re[i] = 0;
      im[i] = 0;
    }
    fft(re, im);
    const f = this.feat; f.fill(0);
    let tot = 1e-20, cen = 0;
    for (let k = 1; k < n / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k]; tot += p; cen += k * p;
      const b = this.bandOf[k]; if (b >= 0) f[b] += p;
    }
    for (let b = 0; b < N_BANDS; b++) f[b] = Math.log(f[b] / tot + 1e-9);
    f[N_BANDS] = (cen / tot) * this.sr / n / 1000;               // centroid in kHz
    f[N_BANDS + 1] = Math.log((late + 1e-12) / (early + 1e-12)); // how fast it dies
    return peak;
  }
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** k-nearest-neighbour classifier on standardised features. Predict allocates nothing. */
export class Knn {
  private Z: Float64Array; private labels: Int32Array; private mu: Float64Array; private sd: Float64Array;
  readonly n: number; readonly d: number; readonly nClasses: number;
  private bestD = new Float64Array(3); private bestL = new Int32Array(3); private votes: Int32Array;
  private w: Float64Array;
  /** weights: optional per-dimension importance, applied after standardising (used to balance sound vs motion). */
  constructor(X: ArrayLike<number>[], y: number[], public k = 3, weights?: number[]) {
    this.n = X.length; this.d = X[0]?.length ?? N_FEAT;
    this.nClasses = Math.max(1, ...y) + 1; this.votes = new Int32Array(this.nClasses);
    this.mu = new Float64Array(this.d); this.sd = new Float64Array(this.d);
    for (const r of X) for (let j = 0; j < this.d; j++) this.mu[j] += r[j] / this.n;
    for (const r of X) for (let j = 0; j < this.d; j++) this.sd[j] += (r[j] - this.mu[j]) ** 2 / this.n;
    for (let j = 0; j < this.d; j++) this.sd[j] = Math.sqrt(this.sd[j]) + 1e-3;
    this.w = new Float64Array(this.d).fill(1); if (weights) for (let j = 0; j < this.d; j++) this.w[j] = weights[j] ?? 1;
    this.Z = new Float64Array(this.n * this.d); this.labels = Int32Array.from(y);
    X.forEach((r, i) => { for (let j = 0; j < this.d; j++) this.Z[i * this.d + j] = (r[j] - this.mu[j]) / this.sd[j] * this.w[j]; });
    this.k = Math.min(k, this.n);
  }
  /** Returns label; writes nearest distance (per-dimension RMS) and vote share into out. */
  predict(x: ArrayLike<number>, out: { dist: number; conf: number }, skip = -1): number {
    const k = this.k; this.bestD.fill(Infinity); this.bestL.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (i === skip) continue;
      let s = 0; const o = i * this.d;
      for (let j = 0; j < this.d; j++) { const z = (x[j] - this.mu[j]) / this.sd[j] * this.w[j] - this.Z[o + j]; s += z * z; }
      if (s < this.bestD[k - 1]) {
        let p = k - 1; while (p > 0 && this.bestD[p - 1] > s) { this.bestD[p] = this.bestD[p - 1]; this.bestL[p] = this.bestL[p - 1]; p--; }
        this.bestD[p] = s; this.bestL[p] = this.labels[i];
      }
    }
    this.votes.fill(0); let best = 0;
    for (let i = 0; i < k; i++) if (this.bestL[i] >= 0) { this.votes[this.bestL[i]]++; }
    for (let c = 1; c < this.nClasses; c++) if (this.votes[c] > this.votes[best] ||
      (this.votes[c] === this.votes[best] && this.firstIndexOf(c) < this.firstIndexOf(best))) best = c;
    out.dist = Math.sqrt(this.bestD[0] / this.d); out.conf = this.votes[best] / k;
    return best;
  }
  private firstIndexOf(c: number) { for (let i = 0; i < this.k; i++) if (this.bestL[i] === c) return i; return 99; }
}

/** Leave-one-out accuracy of the zone model: the "surface quality" score after calibration. */
export function surfaceQuality(feats: number[][], labels: number[]): number {
  if (feats.length < 6) return 0;
  const knn = new Knn(feats, labels, 3), out = { dist: 0, conf: 0 };
  let ok = 0;
  feats.forEach((f, i) => { if (knn.predict(f, out, i) === labels[i]) ok++; });
  return ok / feats.length;
}

/** Distance threshold for "this tap matches no zone": generous multiple of typical nearest-neighbour distance. */
export function rejectDistance(feats: number[][], labels: number[]): number {
  const knn = new Knn(feats, labels, 3), out = { dist: 0, conf: 0 };
  const ds = feats.map((f, i) => { knn.predict(f, out, i); return out.dist; }).sort((a, b) => a - b);
  const median = ds[Math.floor(ds.length / 2)] ?? 1;
  return Math.max(1.5, median * 3.5);
}

/** Classifies taps with a trained table model. Knuckle calibration taps carry their zone, so they teach both models. */
export class TapClassifier {
  private zone: Knn; private type: Knn | null; private peaks: number[]; private reject: number;
  private o = { dist: 0, conf: 0 };
  /** distance of the last classified tap to its nearest calibration tap (debug / inspect) */
  lastDist = 0;
  constructor(m: TableModel) {
    this.zone = new Knn([...m.zoneFeats, ...m.knuckleFeats], [...m.zoneLabels, ...m.knuckleLabels], 3);
    this.type = m.knuckleFeats.length >= 3
      ? new Knn([...m.zoneFeats, ...m.knuckleFeats], [...m.zoneFeats.map(() => 0), ...m.knuckleFeats.map(() => 1)], 3)
      : null;
    this.peaks = m.zonePeakMean; this.reject = m.rejectDist;
  }
  /** zone -1 = heard a tap but it matches nothing. */
  classify(feat: ArrayLike<number>, peak: number, out: { zone: number; knuckle: boolean; velocity: number; confidence: number }) {
    out.knuckle = this.type ? this.type.predict(feat, this.o) === 1 : false;
    const z = this.zone.predict(feat, this.o);
    this.lastDist = this.o.dist;
    const far = this.o.dist > this.reject;
    out.confidence = far ? 0 : this.o.conf;
    out.zone = far ? -1 : z;
    const ref = this.peaks[Math.max(0, z)] || peak;
    out.velocity = Math.max(0.12, Math.min(1, (out.knuckle ? 0.5 : 0.65) * peak / ref));
    return out;
  }
}
