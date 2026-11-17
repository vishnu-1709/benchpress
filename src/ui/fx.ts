// Canvas effects: ripples and particles. Pure decoration; never on the audio path.

interface Ripple { x: number; y: number; r: number; max: number; a: number; col: string; w: number; sq: boolean }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; col: string; sz: number; sq: boolean }

export class Fx {
  private ctx: CanvasRenderingContext2D;
  private ripples: Ripple[] = [];
  private parts: Particle[] = [];
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private running = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * this.dpr); canvas.height = Math.max(1, r.height * this.dpr);
    };
    new ResizeObserver(resize).observe(canvas); resize();
  }

  /** x, y in CSS pixels relative to the canvas. */
  burst(x: number, y: number, col: string, vel: number, square = false) {
    const d = this.dpr; x *= d; y *= d;
    this.ripples.push({ x, y, r: 8 * d, max: (90 + 260 * vel) * d, a: 1, col, w: (2 + 6 * vel) * d, sq: square });
    if (square) this.ripples.push({ x, y, r: 4 * d, max: (60 + 140 * vel) * d, a: 1, col: '#ffffff', w: 2 * d, sq: true });
    const n = Math.round(10 + 28 * vel);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (1.5 + Math.random() * 7 * vel) * d;
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, col, sz: (1.5 + Math.random() * 3) * d, sq: square });
    }
    this.start();
  }

  /** Faint grey ring: "heard you, not sure where". */
  doubt(x: number, y: number) {
    const d = this.dpr;
    this.ripples.push({ x: x * d, y: y * d, r: 10 * d, max: 70 * d, a: 0.5, col: '#8b8b98', w: 1.5 * d, sq: false });
    this.start();
  }

  private start() { if (!this.running) { this.running = true; requestAnimationFrame(this.frame); } }

  private frame = () => {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    this.ripples = this.ripples.filter(r => r.a > 0.02);
    for (const r of this.ripples) {
      r.r += (r.max - r.r) * 0.12; r.a *= 0.92;
      c.globalAlpha = r.a; c.strokeStyle = r.col; c.lineWidth = r.w; c.beginPath();
      if (r.sq) { c.save(); c.translate(r.x, r.y); c.rotate(Math.PI / 4); c.rect(-r.r * 0.8, -r.r * 0.8, r.r * 1.6, r.r * 1.6); c.restore(); }
      else c.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      c.stroke();
      if (!r.sq) { const g = c.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.r); g.addColorStop(0, r.col + '44'); g.addColorStop(1, r.col + '00'); c.fillStyle = g; c.fill(); }
    }
    this.parts = this.parts.filter(p => p.life > 0.02);
    for (const p of this.parts) {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.95; p.vy *= 0.95; p.life *= 0.94;
      c.globalAlpha = p.life; c.fillStyle = p.col;
      if (p.sq) c.fillRect(p.x - p.sz, p.y - p.sz, p.sz * 2, p.sz * 2); else { c.beginPath(); c.arc(p.x, p.y, p.sz, 0, Math.PI * 2); c.fill(); }
    }
    c.globalAlpha = 1;
    if (this.ripples.length || this.parts.length) requestAnimationFrame(this.frame); else this.running = false;
  };
}
