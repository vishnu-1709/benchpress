// Motion sensing for side detection. A tap rocks and jolts the phone towards / away from the side it came from.
// We keep a short history of devicemotion readings and, for each tap, extract signed peaks around the tap time.

export const MOTION_DIM = 6; // rotation x, y, z (deg/s) + acceleration x, y, z (m/s²), each the signed peak after baseline

interface Sample { t: number; v: Float64Array }

export class Motion {
  private buf: Sample[] = [];
  private count = 0; private since = performance.now();
  private started = false;

  start() {
    if (this.started) return; this.started = true;
    window.addEventListener('devicemotion', e => {
      const r = e.rotationRate, a = e.acceleration ?? e.accelerationIncludingGravity;
      if (!r && !a) return;
      const v = new Float64Array(MOTION_DIM);
      v[0] = r?.beta ?? 0; v[1] = r?.gamma ?? 0; v[2] = r?.alpha ?? 0;
      v[3] = a?.x ?? 0; v[4] = a?.y ?? 0; v[5] = a?.z ?? 0;
      // event.timeStamp shares performance.now()'s clock in current browsers
      this.buf.push({ t: e.timeStamp || performance.now(), v }); this.count++;
      if (this.buf.length > 9000) this.buf.splice(0, 1000); // ~90 s at 100 readings/s: a whole calibration
    });
  }

  /**
   * Audio and motion clocks are out of step by an unknown, fixed amount (input buffering, sensor batching).
   * Learned from calibration taps: the shift at which motion spikes line up with the taps.
   */
  offset = 0; offsetLearned = false;

  learnOffset(tapTimes: number[]): boolean {
    if (tapTimes.length < 8) return false;
    const mag = (s: Sample) => Math.abs(s.v[0]) + Math.abs(s.v[1]) + Math.abs(s.v[2]);
    const scoreAt = (off: number) => {
      let sum = 0;
      for (const t of tapTimes) {
        let pk = 0; for (const s of this.buf) { if (s.t < t + off - 15) continue; if (s.t > t + off + 25) break; pk = Math.max(pk, mag(s)); }
        sum += pk;
      }
      return sum / tapTimes.length;
    };
    const offs: number[] = [], scores: number[] = [];
    for (let off = -1000; off <= 1000; off += 5) { offs.push(off); scores.push(scoreAt(off)); }
    const best = scores.indexOf(Math.max(...scores));
    const median = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)];
    if (!(scores[best] > 2 * median && scores[best] > 0.5)) return false; // no clear spike pattern
    this.offset = offs[best]; this.offsetLearned = true;
    return true;
  }

  /** Readings per second over the last few seconds. */
  get rate() {
    const now = performance.now(), recent = this.buf.filter(s => now - s.t < 3000);
    if (recent.length < 3) { const s = (now - this.since) / 1000; return s > 1 ? this.count / s : 0; }
    return (recent.length - 1) / ((recent[recent.length - 1].t - recent[0].t) / 1000 || 1);
  }

  /** Enough readings to be worth trying for sides (a tap jolt lasts tens of ms). */
  get usable() { return this.rate >= 40; }

  /**
   * Signed peak per channel in [t - pre, t + post] after removing the median of the 300 ms before.
   * Returns null if there are too few readings in the window.
   */
  featuresAround(tap: number, pre = 25, post = 35): number[] | null {
    const t = tap + this.offset;
    const win = this.buf.filter(s => s.t >= t - pre && s.t <= t + post);
    if (win.length < 2) return null;
    const base = this.buf.filter(s => s.t >= t - 340 && s.t < t - pre);
    const med = Array.from({ length: MOTION_DIM }, (_, k) => {
      const v = base.map(s => s.v[k]).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    });
    return Array.from({ length: MOTION_DIM }, (_, k) =>
      win.reduce((m, s) => { const d = s.v[k] - med[k]; return Math.abs(d) > Math.abs(m) ? d : m; }, 0));
  }

  /** Waits until readings covering t + post have arrived (or a timeout), then extracts features. */
  /** Extra wait (ms) after a tap before its motion readings are in: the cost of using motion. */
  get lagMs() { return Math.max(0, Math.round(this.offset + 50)); }

  async featuresAfter(tap: number, post = 35, timeoutMs?: number): Promise<number[] | null> {
    const deadline = performance.now() + (timeoutMs ?? Math.min(800, Math.max(90, this.offset + post + 40)));
    while (performance.now() < deadline) {
      const last = this.buf[this.buf.length - 1];
      if (last && last.t >= tap + this.offset + post) break;
      await new Promise(r => setTimeout(r, 5));
    }
    return this.featuresAround(tap, 25, post);
  }
}

export const motion = new Motion();
