// Closed-loop test: the app's own output leaks back into its mic (phone speaker + table), like on a real phone.
// Without protection this runs away: every sound is heard as a new tap.
import { describe, it, expect } from 'vitest';
import { TapDetector } from '../src/engine/dsp';
import { DEFAULT_CONFIG } from '../src/engine/protocol';
import { PACKS, renderPack } from '../src/sounds/packs';
import { makeTaps } from './synthTaps';

interface Opts { leak: number; latencyMs: number; latencyKnownMs?: number; pack: string; drone?: boolean; gate: boolean }
function closedLoop(o: Opts) {
  const sr = 48000, { x, truth } = makeTaps({ sr, perZone: 6, seed: 5 });
  const det = new TapDetector(sr, DEFAULT_CONFIG);
  // 'measured' = the start-up click test found delay and leak (with some error); otherwise both are learned
  det.setEchoGate(o.gate, o.latencyKnownMs != null ? Math.round(sr * o.latencyKnownMs / 1000) : null, o.latencyKnownMs != null ? o.leak * 1.3 : null);
  const p = PACKS.find(q => q.id === o.pack)!, r = renderPack(p, sr);
  const L = Math.round(sr * o.latencyMs / 1000);
  const outHist = new Float32Array(x.length + sr);
  const voices: { b: Float32Array; pos: number; g: number; fade: number }[] = [];
  const choke = p.choke === 'all';
  let dronePos = 0; const detections: number[] = [];
  const mic = new Float32Array(128), out = new Float32Array(128);
  for (let i = 0; i + 128 <= x.length; i += 128) {
    for (let k = 0; k < 128; k++) mic[k] = x[i + k] + (i + k - L >= 0 ? o.leak * outHist[i + k - L] : 0);
    det.process(mic, on => { detections.push(on.frame); det.noteOutputStart(i, p.spreadMs ?? 25); if (choke) for (const v of voices) v.fade = Math.min(v.fade, 1440); voices.push({ b: r.sounds[(detections.length % 4) * 2], pos: 0, g: 0.8, fade: Infinity }); });
    out.fill(0);
    for (const v of voices) { const m = Math.min(128, v.b.length - v.pos); for (let k = 0; k < m; k++) { let g = v.g; if (v.fade !== Infinity) { g *= Math.max(0, v.fade) / 1440; v.fade--; } out[k] += v.b[v.pos + k] * g; } v.pos += m; if (v.fade !== Infinity && v.fade <= 0) v.pos = v.b.length; }
    for (let j = voices.length - 1; j >= 0; j--) if (voices[j].pos >= voices[j].b.length) voices.splice(j, 1);
    det.feedOutput(out);
    if (o.drone && r.drone) for (let k = 0; k < 128; k++) {
      if ((p.droneHits ?? []).some(h => Math.round(h * sr) === dronePos)) det.noteOutputStart(i + k, 30, false);
      out[k] += r.drone[dronePos] * 0.12; dronePos = (dronePos + 1) % r.drone.length; }
    outHist.set(out, i);
  }
  const real = detections.filter(f => truth.some(t => Math.abs(t.t - f) < sr * 0.01)).length;
  return { real, phantom: detections.length - real, total: truth.length, lat: det.echoDelayMs, learned: det.echoDelayLearned, rejected: det.echoesRejected };
}

describe('feedback: the phone hearing its own speaker', () => {
  it('reproduces the runaway loop without protection', () => {
    const r = closedLoop({ leak: 0.3, latencyMs: 120, pack: 'guitar', gate: false });
    expect(r.phantom).toBeGreaterThan(3);
  });
  // The hard requirement: never a runaway loop, at any speaker level, with or without a measured delay.
  for (const pack of ['drums', 'guitar', 'sitar'])
    for (const [leak, lat, known] of [[0.1, 60, 60], [0.3, 120, 120], [0.3, 150, undefined], [0.6, 200, 200]] as const) // a speaker this loud is always caught by the start-up click, so its delay is measured
      it(`${pack}: leak ${leak}, real lag ${lat} ms, measured ${known ?? 'unknown'} → at most 1 phantom tap`, () => {
        const r = closedLoop({ leak, latencyMs: lat, latencyKnownMs: known, pack, drone: pack === 'sitar', gate: true });
        expect(r.phantom).toBeLessThanOrEqual(1);
        // with a quiet speaker most taps get through; drums (short sounds) keep most taps even when loud
        if (leak <= 0.1 || pack === 'drums') expect(r.real / r.total).toBeGreaterThan(pack === 'drums' ? 0.55 : 0.6);
      });
  it('headphones mode (no leak, gate off) keeps every tap', () => {
    const r = closedLoop({ leak: 0, latencyMs: 100, pack: 'guitar', gate: false });
    expect(r.phantom).toBe(0); expect(r.real).toBe(r.total);
  });
});

describe('rhythm is not an echo', () => {
  it('steady tapping at 120 BPM eighths (250 ms) with no speaker leak keeps every tap', () => {
    const sr = 48000, x = new Float32Array(sr * 12);
    let s = 1; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    for (let i = 0; i < x.length; i++) x[i] = (r() * 2 - 1) * 0.002;
    const truth: number[] = [];
    for (let t = 0.5; t < 11.5; t += 0.25) { const i0 = Math.round(t * sr); truth.push(i0); for (let k = 0; k < 3000; k++) x[i0 + k] += 0.2 * Math.exp(-k / 400) * Math.sin(k * 0.31); }
    for (const measured of [null, Math.round(sr * 0.05)]) {
      const det = new TapDetector(sr, DEFAULT_CONFIG); det.setEchoGate(true, measured);
      const found: number[] = [];
      for (let i = 0; i + 128 <= x.length; i += 128) {
        det.process(x.subarray(i, i + 128), o => { found.push(o.frame); det.noteOutputStart(i + Math.round(sr * 0.02), 25); });
        det.feedOutput(new Float32Array(128).fill(0.05));
      }
      const real = found.filter(f => truth.some(t => Math.abs(t - f) < sr * 0.01)).length;
      expect(real).toBeGreaterThanOrEqual(truth.length - 2);
    }
  });
});
