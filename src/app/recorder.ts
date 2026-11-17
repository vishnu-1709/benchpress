// Guided raw recording of real taps, saved as a WAV on the phone, for offline analysis (tools/tap_test.py).
// Layout matches tap_test.py: one group per zone in order, separated by pauses.
import { engine } from '../engine/engine';

export function encodeWav(channels: Float32Array[], sr: number): Blob {
  const n = channels[0].length, nc = channels.length, b = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true);
  b.setUint16(22, nc, true); b.setUint32(24, sr, true); b.setUint32(28, sr * nc * 2, true); b.setUint16(32, nc * 2, true); b.setUint16(34, 16, true);
  w(36, 'data'); b.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = Math.max(-1, Math.min(1, channels[c][i])); b.setInt16(o, v * 32767, true); o += 2; }
  return new Blob([b], { type: 'audio/wav' });
}

export class Recorder {
  private chunks: Float32Array[][] = [];
  private stop: (() => void) | null = null;
  start() {
    this.chunks = [];
    this.stop = engine.on(m => { if (m.type === 'rec') this.chunks.push(m.channels); });
    engine.record(true);
  }
  async finish(): Promise<{ blob: Blob; seconds: number; channels: number }> {
    engine.record(false);
    await new Promise(r => setTimeout(r, 300)); // last chunk
    this.stop?.();
    const nc = Math.max(1, ...this.chunks.map(c => c.length));
    const total = this.chunks.reduce((s, c) => s + c[0].length, 0);
    const out = Array.from({ length: nc }, () => new Float32Array(total));
    let o = 0;
    for (const c of this.chunks) { for (let k = 0; k < nc; k++) out[k].set(c[k] ?? c[0], o); o += c[0].length; }
    return { blob: encodeWav(out, engine.sampleRate), seconds: total / engine.sampleRate, channels: nc };
  }
}
