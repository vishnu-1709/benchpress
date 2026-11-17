// Instrument packs. Each pack maps 4 zones x {finger, knuckle} to 8 sounds (index = zone*2 + knuckle).
// Sounds are rendered at load time; swap `render` for recorded .m4a files later without touching the engine.
import { Buf, biquad, midiHz, noise, pluck, sweep, tone } from './synth';

export interface Pack {
  id: string;
  name: string;
  blurb: string;
  finger: [string, string, string, string];   // labels for zones: left, top, right, bottom
  knuckle: [string, string, string, string];
  render(sr: number): Float32Array[];
  drone?(sr: number): Float32Array;
  /** 'all': a new sound fades out the previous one (strummed chords, melody notes). */
  choke?: 'all' | 'none';
  /** How long a sound's attacks last (ms): a strum's strings arrive over ~100 ms. */
  spreadMs?: number;
  /** Times (s) of the plucks inside the drone loop. */
  droneHits?: number[];
}

const bp = (x: Float32Array, sr: number, f: number, q: number) => biquad(x, sr, 'bp', f, q);
const hp = (x: Float32Array, sr: number, f: number) => biquad(x, sr, 'hp', f);
const lp = (x: Float32Array, sr: number, f: number) => biquad(x, sr, 'lp', f);

function drums(sr: number): Float32Array[] {
  const kick = new Buf(sr, 0.6).mix(sweep(sr, 160, 46, 0.035, 7, 0.6)).mix(hp(noise(sr, 0.01, 1, 400), sr, 2000), 0.3).done();
  const snare = new Buf(sr, 0.35).mix(hp(noise(sr, 0.35, 2, 16), sr, 1200), 0.8).mix(tone(sr, 190, 28, 0.2, [[1, 1], [1.6, 0.4]]), 0.6).done(0.8);
  const hat = new Buf(sr, 0.12).mix(hp(noise(sr, 0.12, 3, 55), sr, 7500)).done(0.55);
  const clap = new Buf(sr, 0.35);
  [0, 0.011, 0.023].forEach((s, i) => clap.mix(bp(noise(sr, 0.3, 4 + i, i === 2 ? 14 : 90), sr, 1400, 1.2), 1, s));
  const tom = new Buf(sr, 0.7).mix(sweep(sr, 170, 98, 0.06, 6, 0.7)).done(0.85);
  const rim = new Buf(sr, 0.12).mix(tone(sr, 1650, 90, 0.1, [[1, 1], [2.4, 0.5]])).mix(bp(noise(sr, 0.05, 6, 120), sr, 3200, 3), 0.8).done(0.7);
  const ohat = new Buf(sr, 0.7).mix(hp(noise(sr, 0.7, 7, 7), sr, 6500)).done(0.5);
  const crash = new Buf(sr, 2.2).mix(hp(noise(sr, 2.2, 8, 2.2), sr, 4200)).mix(bp(noise(sr, 1.2, 9, 4), sr, 9000, 2), 0.6).done(0.55);
  return [kick, tom, snare, rim, hat, ohat, clap.done(0.8), crash];
}

function dhol(sr: number): Float32Array[] {
  const dhum = () => sweep(sr, 100, 54, 0.08, 4.5, 1.0);
  const ta = () => new Buf(sr, 0.25).mix(bp(noise(sr, 0.1, 11, 70), sr, 2400, 4)).mix(tone(sr, 420, 22, 0.25, [[1, 1], [2.3, 0.3]]), 0.7).d;
  const Dhum = new Buf(sr, 1).mix(dhum()).done();
  const Ta = new Buf(sr, 0.25).mix(ta()).done(0.8);
  const Tin = new Buf(sr, 0.6).mix(tone(sr, 620, 9, 0.6, [[1, 1], [2.76, 0.35], [5.4, 0.1]])).done(0.75);
  const Dha = new Buf(sr, 1).mix(dhum(), 0.9).mix(ta(), 0.7).done();
  const Ge = new Buf(sr, 0.6).mix(sweep(sr, 72, 108, 0.12, 6, 0.6)).done();
  const Na = new Buf(sr, 0.5).mix(tone(sr, 880, 13, 0.5, [[1, 1], [2.7, 0.3]])).mix(bp(noise(sr, 0.03, 12, 150), sr, 3000, 4), 0.5).done(0.75);
  const Ke = new Buf(sr, 0.08).mix(bp(noise(sr, 0.08, 13, 85), sr, 1800, 5)).done(0.7);
  const Dhin = new Buf(sr, 1).mix(dhum(), 0.8).mix(tone(sr, 660, 5, 1, [[1, 1], [2.76, 0.3]]), 0.6).done();
  return [Dhum, Ge, Ta, Na, Tin, Ke, Dha, Dhin];
}

const CHORDS_FINGER = [[48, 55, 60, 64, 67, 72], [43, 47, 50, 55, 59, 67], [45, 52, 57, 60, 64, 69], [41, 48, 53, 57, 60, 65]]; // C G Am F
const CHORDS_KNUCKLE = [[48, 55, 59, 64, 67, 71], [43, 47, 50, 53, 59, 67], [45, 52, 55, 60, 64, 67], [41, 48, 52, 57, 60, 64]]; // Cmaj7 G7 Am7 Fmaj7
function guitar(sr: number): Float32Array[] {
  const strum = (notes: number[], seed: number) => {
    const b = new Buf(sr, 2.6);
    notes.forEach((m, i) => b.mix(pluck(sr, midiHz(m), 2.4, seed + i, { damp: 0.9975, bright: 0.55 }), 0.8 - i * 0.04, i * 0.018));
    lp(b.d, sr, 4500);
    return b.done(0.85);
  };
  const out: Float32Array[] = [];
  for (let z = 0; z < 4; z++) { out.push(strum(CHORDS_FINGER[z], 100 + z * 10)); out.push(strum(CHORDS_KNUCKLE[z], 200 + z * 10)); }
  return out;
}

// Raga Bhupali (major pentatonic, Sa = C#): finger = Sa Re Ga Pa, knuckle = Dha Sa' Re' Ga'
const SITAR_FINGER = [61, 63, 65, 68], SITAR_KNUCKLE = [70, 73, 75, 77];
function sitar(sr: number): Float32Array[] {
  const note = (m: number, seed: number) => {
    const b = new Buf(sr, 2.8)
      .mix(pluck(sr, midiHz(m), 2.8, seed, { damp: 0.9988, bright: 0.9, buzz: 0.35 }))
      .mix(pluck(sr, midiHz(m + 12), 2.0, seed + 50, { damp: 0.998, bright: 0.9, buzz: 0.2 }), 0.18);
    lp(b.d, sr, 6000);
    return b.done(0.85);
  };
  const out: Float32Array[] = [];
  for (let z = 0; z < 4; z++) { out.push(note(SITAR_FINGER[z], 300 + z)); out.push(note(SITAR_KNUCKLE[z], 400 + z)); }
  return out;
}

/** Tanpura: Pa Sa' Sa' Sa cycle, rendered as a seamless loop (tails wrap around). */
function tanpura(sr: number): Float32Array {
  const cycle = 4.4, len = Math.round(sr * cycle), loop = new Float32Array(len);
  [56, 61, 61, 49].forEach((m, k) => {
    const s = pluck(sr, midiHz(m), 6, 500 + k, { damp: 0.9994, bright: 0.8, buzz: 0.25 });
    const at = Math.round(k * 1.1 * sr);
    for (let i = 0; i < s.length; i++) loop[(at + i) % len] += s[i] * 0.6;
  });
  lp(loop, sr, 3000);
  let m = 1e-9; for (const v of loop) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < len; i++) loop[i] *= 0.8 / m;
  return loop;
}

export const PACKS: Pack[] = [
  { id: 'drums', name: 'Drums', blurb: 'Kick, snare, hats, clap', finger: ['Kick', 'Snare', 'Hat', 'Clap'], knuckle: ['Tom', 'Rim', 'Open hat', 'Crash'], render: drums },
  { id: 'dhol', name: 'Dhol', blurb: 'Bols on a dhol', finger: ['Dhum', 'Ta', 'Tin', 'Dha'], knuckle: ['Ge', 'Na', 'Ke', 'Dhin'], render: dhol },
  { id: 'guitar', name: 'Guitar', blurb: 'Four chords, every pop song', finger: ['C', 'G', 'Am', 'F'], knuckle: ['Cmaj7', 'G7', 'Am7', 'Fmaj7'], render: guitar, choke: 'all', spreadMs: 110 },
  { id: 'sitar', name: 'Sitar', blurb: 'Raga Bhupali over a tanpura', finger: ['Sa', 'Re', 'Ga', 'Pa'], knuckle: ['Dha', "Sa'", "Re'", "Ga'"], render: sitar, drone: tanpura, choke: 'all', spreadMs: 40, droneHits: [0, 1.1, 2.2, 3.3] },
];

export const packById = (id: string) => PACKS.find(p => p.id === id) ?? PACKS[0];

const cache = new Map<string, { sounds: Float32Array[]; drone?: Float32Array }>();
/** Renders (once) and returns a pack's sounds at the given sample rate. */
export function renderPack(p: Pack, sr: number) {
  const key = p.id + '@' + sr;
  let c = cache.get(key);
  if (!c) { c = { sounds: p.render(sr), drone: p.drone?.(sr) }; cache.set(key, c); }
  return c;
}
