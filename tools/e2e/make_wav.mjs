// Builds a scripted "table session" WAV for the end-to-end test: first tap, calibration, play, knuckles.
import fs from 'fs';
const sr = 48000, dur = 64, x = new Float32Array(sr * dur);
let s = 42; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
for (let i = 0; i < x.length; i++) x[i] = (rnd() * 2 - 1) * 0.003;
const modes = Array.from({ length: 18 }, () => ({ f: 150 + rnd() * 9000, d: 30 + rnd() * 250 }));
const W = Array.from({ length: 4 }, () => modes.map(() => 0.2 + rnd()));
const truth = [];
function tap(sec, z, kn = false) {
  const t = Math.round(sec * sr), force = 0.3 + 0.7 * rnd(), n = Math.round(sr * 0.12);
  modes.forEach((m, mi) => {
    const w = W[z][mi] * (1 + (rnd() * 2 - 1) * 0.25) * force * (m.f > 2500 ? (kn ? 1.6 : 0.45) : 1), ph = rnd() * 6.28, d = m.d * (kn ? 1.3 : 1);
    for (let k = 0; k < n; k++) x[t + k] += w * 0.08 * Math.exp(-k / sr * d) * Math.sin(2 * Math.PI * m.f * k / sr + ph);
  });
  truth.push({ sec, z, kn });
}
tap(6, 1);                                                      // first tap
for (let z = 0; z < 4; z++) for (let i = 0; i < 8; i++) tap(9 + z * 4.4 + i * 0.45, z); // calibration: 8 per area
const play = []; for (let i = 0; i < 40; i++) { const z = Math.floor(rnd() * 4); play.push(z); tap(29 + i * 0.45, z); }
for (let i = 0; i < 8; i++) tap(48.5 + i * 0.6, Math.floor(i / 2), true); // knuckle unlock: 2 per zone
for (let i = 0; i < 16; i++) tap(54.5 + i * 0.45, i % 4, i % 2 === 1); // mixed finger/knuckle
const b = Buffer.alloc(44 + x.length * 2);
b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
fs.mkdirSync('tools/e2e/out', { recursive: true });
fs.writeFileSync('tools/e2e/out/session.wav', b); fs.writeFileSync('tools/e2e/out/truth.json', JSON.stringify(truth));
console.log('session.wav', dur, 's,', truth.length, 'taps');
