import { describe, it, expect } from 'vitest';
import { TapDetector, TapClassifier, surfaceQuality, rejectDistance } from '../src/engine/dsp';
import { DEFAULT_CONFIG, type TableModel } from '../src/engine/protocol';
import { makeTaps } from './synthTaps';

function detect(x: Float32Array, sr: number) {
  const det = new TapDetector(sr, DEFAULT_CONFIG);
  const taps: { frame: number; peak: number; feat: number[] }[] = [];
  for (let i = 0; i + 128 <= x.length; i += 128) {
    det.process(x.subarray(i, i + 128), o => taps.push({ frame: o.frame, peak: o.peak, feat: Array.from(o.feat) }));
  }
  return taps;
}

for (const sr of [44100, 48000]) describe(`DSP at ${sr} Hz`, () => {
  const { x, truth } = makeTaps({ sr, perZone: 25, knuckle: true, seed: 7 });
  const taps = detect(x, sr);
  const matched = taps.map(tp => ({ tp, tr: truth.find(v => Math.abs(v.t - tp.frame) < sr * 0.01) }));

  it('finds every tap with no false triggers', () => {
    expect(matched.filter(m => m.tr).length).toBe(truth.length);
    expect(matched.filter(m => !m.tr).length).toBe(0);
  });

  it('classifies zone and finger/knuckle from 5 calibration taps per zone', () => {
    const fingers = matched.filter(m => m.tr && !m.tr.knuckle), knuckles = matched.filter(m => m.tr?.knuckle);
    const cal = [0, 1, 2, 3].flatMap(z => fingers.filter(m => m.tr!.zone === z).slice(0, 5));
    const calK = [0, 1, 2, 3].flatMap(z => knuckles.filter(m => m.tr!.zone === z).slice(0, 2));
    const feats = cal.map(m => m.tp.feat), labels = cal.map(m => m.tr!.zone);
    const peaks = [0, 1, 2, 3].map(z => { const p = cal.filter(m => m.tr!.zone === z).map(m => m.tp.peak); return p.reduce((a, b) => a + b, 0) / p.length; });
    const model: TableModel = { zoneFeats: feats, zoneLabels: labels, knuckleFeats: calK.map(m => m.tp.feat), knuckleLabels: calK.map(m => m.tr!.zone), zonePeakMean: peaks, rejectDist: rejectDistance(feats, labels) };
    expect(surfaceQuality(feats, labels)).toBeGreaterThan(0.75);
    const c = new TapClassifier(model), out = { zone: 0, knuckle: false, velocity: 0, confidence: 0 };
    const testF = fingers.filter(m => !cal.includes(m)), testK = knuckles.filter(m => !calK.includes(m));
    const zoneAcc = testF.filter(m => c.classify(m.tp.feat, m.tp.peak, out).zone === m.tr!.zone).length / testF.length;
    const typeAcc = [...testF, ...testK].filter(m => c.classify(m.tp.feat, m.tp.peak, out).knuckle === m.tr!.knuckle).length / (testF.length + testK.length);
    const knZoneAcc = testK.filter(m => c.classify(m.tp.feat, m.tp.peak, out).zone === m.tr!.zone).length / testK.length;
    expect(zoneAcc).toBeGreaterThan(0.85);
    expect(knZoneAcc).toBeGreaterThan(0.65); // 2 knuckle calibration taps per zone
    expect(typeAcc).toBeGreaterThan(0.9);
  });

  it('tap strength follows force', () => {
    const f = matched.filter(m => m.tr && !m.tr.knuckle);
    const a = f.map(m => m.tp.peak), b = f.map(m => m.tr!.force);
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    const r = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0));
    expect(r).toBeGreaterThan(0.7);
  });
});
