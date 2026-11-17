// "See your taps": shows what the app hears.
// 1. Fingerprint map: every tap's 26-number fingerprint squeezed to 2D (PCA). Close dots = similar sound.
// 2. Bars: the last tap's sound spectrum vs each area's average.
// 3. Direction readouts: gyroscope rocking and two-mic level difference per tap.
import { N_BANDS } from '../engine/dsp';
import type { CalTap } from '../app/profiles';

const COLORS = ['#3d8bff', '#ff4d6d', '#ffc93d', '#3ddc97'];

/** Top-2 principal components of standardised rows (power iteration; small data). */
export function pca2(rows: number[][]) {
  const n = rows.length, d = rows[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  rows.forEach(r => r.forEach((v, j) => mu[j] += v / n));
  rows.forEach(r => r.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) + 1e-6;
  const Z = rows.map(r => r.map((v, j) => (v - mu[j]) / sd[j]));
  const C = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) / n));
  const pcs: number[][] = [];
  for (let c = 0; c < 2; c++) {
    let v = Array.from({ length: d }, (_, i) => Math.sin(i + 1 + c));
    for (let it = 0; it < 80; it++) {
      let w = C.map(row => row.reduce((s, x, j) => s + x * v[j], 0));
      for (const p of pcs) { const dot = w.reduce((s, x, j) => s + x * p[j], 0); w = w.map((x, j) => x - dot * p[j]); }
      const norm = Math.hypot(...w) || 1; v = w.map(x => x / norm);
    }
    pcs.push(v);
  }
  const project = (r: number[]) => pcs.map(p => r.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * p[j], 0)) as [number, number];
  return { project };
}

export interface LiveTap { feat: number[]; zone: number; knuckle: boolean; confidence: number; dist: number; micDb: number | null; gyro: { x: number; y: number; z: number } | null }

export class Inspector {
  private live: LiveTap[] = [];
  private proj: ((r: number[]) => [number, number]) | null = null;
  private calPts: { p: [number, number]; zone: number; knuckle: boolean }[] = [];
  private bounds = { x0: -1, x1: 1, y0: -1, y1: 1 };
  private zoneMeans: number[][] = [];
  // gyroscope ring (timestamps in ms, rotation rate deg/s)
  private gyro: { t: number; x: number; y: number; z: number }[] = [];
  private gyroEvents = 0; private gyroSince = performance.now();

  constructor(private map: HTMLCanvasElement, private bars: HTMLCanvasElement, private readout: HTMLElement) {
    window.addEventListener('devicemotion', e => {
      const r = e.rotationRate; if (!r) return;
      this.gyroEvents++;
      this.gyro.push({ t: performance.now(), x: r.beta ?? 0, y: r.gamma ?? 0, z: r.alpha ?? 0 });
      if (this.gyro.length > 400) this.gyro.splice(0, 100);
    });
  }

  get gyroRate() { const s = (performance.now() - this.gyroSince) / 1000; return s > 0.5 ? this.gyroEvents / s : 0; }

  setCalibration(zoneTaps: CalTap[], knuckleTaps: CalTap[]) {
    const all = [...zoneTaps, ...knuckleTaps];
    this.live = []; this.calPts = [];
    if (all.length < 4) { this.proj = null; this.draw(); return; }
    this.proj = pca2(all.map(t => t.feat)).project;
    this.calPts = [...zoneTaps.map(t => ({ p: this.proj!(t.feat), zone: t.zone, knuckle: false })), ...knuckleTaps.map(t => ({ p: this.proj!(t.feat), zone: t.zone, knuckle: true }))];
    const xs = this.calPts.map(c => c.p[0]), ys = this.calPts.map(c => c.p[1]);
    const pad = (a: number, b: number) => (b - a) * 0.25 + 0.5;
    this.bounds = { x0: Math.min(...xs) - pad(Math.min(...xs), Math.max(...xs)), x1: Math.max(...xs) + pad(Math.min(...xs), Math.max(...xs)),
      y0: Math.min(...ys) - pad(Math.min(...ys), Math.max(...ys)), y1: Math.max(...ys) + pad(Math.min(...ys), Math.max(...ys)) };
    this.zoneMeans = [0, 1, 2, 3].map(z => {
      const f = zoneTaps.filter(t => t.zone === z).map(t => t.feat);
      return f.length ? f[0].map((_, j) => f.reduce((s, r) => s + r[j], 0) / f.length) : [];
    });
    this.draw();
  }

  /** Peak rotation per axis in the window around a tap that the page heard `ageMs` ago. */
  gyroAround(ageMs: number) {
    const now = performance.now(), t0 = now - ageMs - 60, t1 = now;
    const w = this.gyro.filter(g => g.t >= t0 && g.t <= t1);
    if (!w.length) return null;
    const pk = (k: 'x' | 'y' | 'z') => w.reduce((m, g) => Math.abs(g[k]) > Math.abs(m) ? g[k] : m, 0);
    return { x: pk('x'), y: pk('y'), z: pk('z') };
  }

  addTap(t: LiveTap) { this.live.push(t); if (this.live.length > 30) this.live.shift(); this.draw(); }

  private draw() {
    this.drawMap(); this.drawBars(); this.drawReadout();
  }

  private sizeCanvas(c: HTMLCanvasElement) {
    const dpr = Math.min(2, devicePixelRatio || 1), r = c.getBoundingClientRect();
    c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr);
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w: r.width, h: r.height };
  }

  private drawMap() {
    const { g, w, h } = this.sizeCanvas(this.map);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#2a2a35'; g.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (!this.proj) { g.fillStyle = '#8b8b98'; g.font = '13px sans-serif'; g.fillText('Calibrate first to see your areas.', 14, 24); return; }
    const { x0, x1, y0, y1 } = this.bounds;
    const X = (v: number) => 12 + (v - x0) / (x1 - x0) * (w - 24), Y = (v: number) => h - 12 - (v - y0) / (y1 - y0) * (h - 24);
    for (const c of this.calPts) {
      g.globalAlpha = 0.85; g.fillStyle = COLORS[c.zone] ?? '#fff';
      if (c.knuckle) { g.fillRect(X(c.p[0]) - 4, Y(c.p[1]) - 4, 8, 8); }
      else { g.beginPath(); g.arc(X(c.p[0]), Y(c.p[1]), 5, 0, 7); g.fill(); }
    }
    this.live.forEach((t, i) => {
      const p = this.proj!(t.feat), last = i === this.live.length - 1;
      g.globalAlpha = last ? 1 : 0.25 + 0.5 * i / this.live.length;
      g.strokeStyle = t.zone >= 0 ? COLORS[t.zone] : '#ffffff'; g.lineWidth = last ? 3 : 1.5;
      g.beginPath(); g.arc(X(p[0]), Y(p[1]), last ? 10 : 6, 0, 7); g.stroke();
      if (last) { g.fillStyle = '#fff'; g.beginPath(); g.arc(X(p[0]), Y(p[1]), 3, 0, 7); g.fill(); }
    });
    g.globalAlpha = 1;
  }

  private drawBars() {
    const { g, w, h } = this.sizeCanvas(this.bars);
    g.clearRect(0, 0, w, h);
    const last = this.live[this.live.length - 1];
    const lo = -12, hi = 0, bw = (w - 20) / N_BANDS;
    const Y = (v: number) => h - 14 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (h - 24);
    this.zoneMeans.forEach((m, z) => {
      if (!m.length) return;
      g.strokeStyle = COLORS[z]; g.globalAlpha = 0.8; g.lineWidth = 1.5; g.beginPath();
      for (let b = 0; b < N_BANDS; b++) { const x = 10 + b * bw + bw / 2; b ? g.lineTo(x, Y(m[b])) : g.moveTo(x, Y(m[b])); }
      g.stroke();
    });
    g.globalAlpha = 1;
    if (last) {
      g.fillStyle = 'rgba(255,255,255,.75)';
      for (let b = 0; b < N_BANDS; b++) { const y = Y(last.feat[b]); g.fillRect(10 + b * bw + 1, y, bw - 2, h - 14 - y); }
    }
    g.fillStyle = '#8b8b98'; g.font = '10px sans-serif'; g.fillText('low', 10, h - 2); g.fillText('high pitch', w - 56, h - 2);
  }

  private drawReadout() {
    const t = this.live[this.live.length - 1];
    const rate = this.gyroRate;
    const lines = [
      t ? `Last tap → ${t.zone >= 0 ? ['blue', 'pink', 'yellow', 'green'][t.zone] : 'no match'}${t.knuckle ? ' (knuckle)' : ''} · confidence ${Math.round(t.confidence * 100)}% · distance ${t.dist.toFixed(2)}` : 'Tap the table…',
      t?.micDb != null ? `Two mics: bottom vs top level ${t.micDb >= 0 ? '+' : ''}${t.micDb.toFixed(1)} dB` : 'Two mics: only one microphone available',
      rate > 0 ? `Gyroscope: ${rate.toFixed(0)} readings/s${t?.gyro ? ` · last tap rocked x ${t.gyro.x.toFixed(1)}, y ${t.gyro.y.toFixed(1)}, z ${t.gyro.z.toFixed(1)} °/s` : ''}` : 'Gyroscope: no readings in this browser',
    ];
    this.readout.textContent = lines.join('\n');
  }
}
