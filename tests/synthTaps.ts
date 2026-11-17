// Synthetic table taps: shared resonances, zone-dependent mixing (multipath), finger vs knuckle excitation.
export interface TruthTap { t: number; zone: number; knuckle: boolean; force: number }
export function makeTaps(o: { sr?: number; perZone?: number; knuckle?: boolean; seed?: number; noise?: number } = {}) {
  const sr = o.sr ?? 48000, perZone = o.perZone ?? 25, noiseAmp = o.noise ?? 0.003;
  let s = o.seed ?? 1; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const modes = Array.from({ length: 18 }, () => ({ f: 150 + rnd() * 9000, d: 30 + rnd() * 250 }));
  const W = Array.from({ length: 4 }, () => modes.map(() => 0.2 + rnd()));
  const order: [number, boolean][] = [];
  for (const kn of o.knuckle ? [false, true] : [false]) for (let z = 0; z < 4; z++) for (let i = 0; i < perZone; i++) order.push([z, kn]);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let t = Math.round(sr * 0.5);
  const x = new Float32Array(t + order.length * Math.round(sr * 0.35) + sr);
  for (let i = 0; i < x.length; i++) x[i] = (rnd() * 2 - 1) * noiseAmp;
  const truth: TruthTap[] = [];
  for (const [z, kn] of order) {
    const force = 0.2 + 0.8 * rnd(), n = Math.round(sr * 0.12);
    modes.forEach((m, mi) => {
      const w = W[z][mi] * (1 + (rnd() * 2 - 1) * 0.25) * force * (m.f > 2500 ? (kn ? 1.6 : 0.45) : 1), ph = rnd() * 6.28, d = m.d * (kn ? 1.3 : 1);
      for (let k = 0; k < n; k++) x[t + k] += w * 0.08 * Math.exp(-k / sr * d) * Math.sin(2 * Math.PI * m.f * k / sr + ph);
    });
    truth.push({ t, zone: z, knuckle: kn, force });
    t += Math.round(sr * (0.25 + rnd() * 0.2));
  }
  return { x, truth, sr };
}
