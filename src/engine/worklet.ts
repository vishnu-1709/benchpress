// AudioWorklet: mic in -> detect -> classify -> play, all inside one real-time callback.
// The page only sends settings and draws the events this posts back.
import { TapDetector, TapClassifier, type Onset } from './dsp';
import { DEFAULT_CONFIG, type FromWorklet, type Mode, type ToWorklet, type LoopPhase } from './protocol';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }

const MAX_VOICES = 24;
const MAX_LOOP_EVENTS = 1024;
const MAX_LOOP_SEC = 30;

interface Voice { buf: Float32Array | null; pos: number; gain: number }

class BenchpressProcessor extends AudioWorkletProcessor {
  private det = new TapDetector(sampleRate, DEFAULT_CONFIG);
  private cls: TapClassifier | null = null;
  private mode: Mode = { kind: 'idle' };
  private kits = new Map<string, Float32Array[]>();
  private kitIds: string[] = [];          // index -> id, so loop events can store a small int
  private current = '';
  private voices: Voice[] = Array.from({ length: MAX_VOICES }, () => ({ buf: null, pos: 0, gain: 0 }));
  private drone: Float32Array | null = null; private dronePos = 0; private droneGain = 0; private droneTarget = 0;
  private headphones = false;
  private latencyFrames = Math.round(sampleRate * 0.04);
  private clsOut = { zone: 0, knuckle: false, velocity: 0, confidence: 0 };
  // loop recorder (preallocated)
  private loopPhase: LoopPhase = 'empty'; private loopStart = 0; private loopLen = 0; private layers = 0;
  private evOff = new Float64Array(MAX_LOOP_EVENTS); private evKit = new Int16Array(MAX_LOOP_EVENTS);
  private evSound = new Int16Array(MAX_LOOP_EVENTS); private evGain = new Float32Array(MAX_LOOP_EVENTS);
  private evSkip = new Uint8Array(MAX_LOOP_EVENTS); private evN = 0;
  // latency test
  private latTestAt = -1; private click: Float32Array;
  private levelEvery = Math.round(sampleRate / 30); private levelAcc = 0;
  private onTapBound = (o: Onset) => this.onTap(o);

  constructor() {
    super();
    this.click = new Float32Array(Math.round(sampleRate * 0.01));
    for (let i = 0; i < this.click.length; i++) this.click[i] = Math.exp(-i / (sampleRate * 0.0015)) * (i % 8 < 4 ? 0.9 : -0.9);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
    this.post({ type: 'ready', sampleRate });
  }

  private post(m: FromWorklet) { this.port.postMessage(m); }

  private onMessage(m: ToWorklet) {
    switch (m.type) {
      case 'config': this.det.setConfig(m.config); break;
      case 'model': this.cls = m.model ? new TapClassifier(m.model) : null; break;
      case 'instrument':
        if (!this.kits.has(m.id)) this.kitIds.push(m.id);
        this.kits.set(m.id, m.sounds); if (!this.current) this.current = m.id; break;
      case 'select': if (this.kits.has(m.id)) this.current = m.id; break;
      case 'drone':
        if (m.buffer) { this.drone = m.buffer; this.droneTarget = m.gain; } else this.droneTarget = 0; break;
      case 'mode': this.mode = m.mode; break;
      case 'headphones': this.headphones = m.on; break;
      case 'loop': m.cmd === 'clear' ? this.loopClear() : this.loopToggle(); break;
      case 'latencyTest': this.latTestAt = currentFrame + 128; break;
      case 'preview': this.startVoice(this.kits.get(this.current)?.[m.sound] ?? null, m.gain, currentFrame); break;
    }
  }

  private startVoice(buf: Float32Array | null, gain: number, frame: number) {
    if (!buf) return;
    let v = this.voices[0];
    for (const x of this.voices) { if (!x.buf) { v = x; break; } if (x.pos > v.pos) v = x; } // free or oldest
    v.buf = buf; v.pos = 0; v.gain = gain;
    if (!this.headphones) this.det.maskOutput(frame, this.latencyFrames);
  }

  private soundFor(zone: number, knuckle: boolean) { return zone * 2 + (knuckle ? 1 : 0); }

  private playSound(sound: number, velocity: number, onsetFrame: number) {
    const kit = this.kits.get(this.current); if (!kit) return;
    const gain = Math.pow(velocity, 1.4);
    this.startVoice(kit[sound], gain, currentFrame);
    if (this.loopPhase === 'recording' || this.loopPhase === 'overdub') this.loopRecord(sound, gain, onsetFrame);
  }

  private onTap(o: Onset) {
    // latency test: the first onset after our click is the click itself
    if (this.latTestAt > 0 && currentFrame > this.latTestAt) {
      const d = o.frame - this.latTestAt;
      if (d > 0 && d < sampleRate * 0.5) {
        this.latencyFrames = d; this.latTestAt = -1;
        this.post({ type: 'latency', ms: d / sampleRate * 1000, leak: Math.min(1, o.peak / 0.9) });
        return;
      }
    }
    const mode = this.mode;
    if (mode.kind === 'idle') return;
    if (mode.kind === 'first') { this.playSound(2, Math.min(1, 0.4 + o.peak * 4), o.frame); this.post({ type: 'tap', zone: -1, knuckle: false, velocity: 0.8, confidence: 1, frame: o.frame }); return; }
    if (mode.kind === 'calibrate' || mode.kind === 'calibrateKnuckle') {
      this.playSound(this.soundFor(mode.zone, mode.kind === 'calibrateKnuckle'), 0.8, o.frame);
      this.post({ type: 'calTap', feat: Array.from(o.feat), peak: o.peak, frame: o.frame });
      return;
    }
    if (!this.cls) return;
    const r = this.cls.classify(o.feat, o.peak, this.clsOut);
    if (r.zone < 0) { this.post({ type: 'unsure', frame: o.frame, velocity: r.velocity }); return; }
    this.playSound(this.soundFor(r.zone, r.knuckle), r.velocity, o.frame);
    this.post({ type: 'tap', zone: r.zone, knuckle: r.knuckle, velocity: r.velocity, confidence: r.confidence, frame: o.frame });
  }

  // ---------- loop recorder ----------
  private loopToggle() {
    const now = currentFrame;
    if (this.loopPhase === 'empty') { this.evN = 0; this.loopStart = now; this.loopPhase = 'recording'; this.layers = 1; }
    else if (this.loopPhase === 'recording') {
      this.loopLen = now - this.loopStart;
      if (this.loopLen < sampleRate * 0.5 || this.evN === 0) { this.loopClear(); return; }
      this.loopStart = now; this.loopPhase = 'playing';
    } else if (this.loopPhase === 'playing') { this.loopPhase = 'overdub'; this.layers++; }
    else if (this.loopPhase === 'overdub') this.loopPhase = 'playing';
    this.postLoop();
  }
  private loopClear() { this.loopPhase = 'empty'; this.evN = 0; this.layers = 0; this.loopLen = 0; this.postLoop(); }
  private postLoop() { this.post({ type: 'loop', phase: this.loopPhase, lengthSec: this.loopLen / sampleRate, layers: this.layers }); }
  private loopRecord(sound: number, gain: number, onsetFrame: number) {
    if (this.evN >= MAX_LOOP_EVENTS) { this.post({ type: 'loopFull' }); return; }
    const i = this.evN++;
    if (this.loopPhase === 'recording') {
      this.evOff[i] = Math.max(0, onsetFrame - this.loopStart); this.evSkip[i] = 0;
      if (onsetFrame - this.loopStart > sampleRate * MAX_LOOP_SEC) this.loopToggle();
    } else {
      this.evOff[i] = ((onsetFrame - this.loopStart) % this.loopLen + this.loopLen) % this.loopLen;
      this.evSkip[i] = 1; // already heard live this time round
    }
    this.evKit[i] = this.kitIds.indexOf(this.current); this.evSound[i] = sound; this.evGain[i] = gain;
  }
  private loopTick(from: number, n: number) {
    if (this.loopPhase !== 'playing' && this.loopPhase !== 'overdub') return;
    const L = this.loopLen, a = ((from - this.loopStart) % L + L) % L, b = a + n;
    for (let i = 0; i < this.evN; i++) {
      const t = this.evOff[i];
      if ((t >= a && t < b) || (b > L && t < b - L)) {
        if (this.evSkip[i]) { this.evSkip[i] = 0; continue; }
        const kit = this.kits.get(this.kitIds[this.evKit[i]]);
        if (kit) this.startVoice(kit[this.evSound[i]], this.evGain[i], from);
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const out = outputs[0][0];
    const n = out.length;
    if (input) this.det.process(input, this.onTapBound);
    this.loopTick(currentFrame, n);
    if (this.latTestAt > 0 && currentFrame <= this.latTestAt && this.latTestAt < currentFrame + n) {
      const v = this.voices[0]; v.buf = this.click; v.pos = 0; v.gain = 1; // no mask: we want to hear it
    }
    if (this.latTestAt > 0 && currentFrame - this.latTestAt > sampleRate * 0.6) { this.latTestAt = -1; this.post({ type: 'latency', ms: null, leak: 0 }); }
    out.fill(0);
    for (const v of this.voices) {
      const b = v.buf; if (!b) continue;
      const m = Math.min(n, b.length - v.pos), g = v.gain;
      for (let i = 0; i < m; i++) out[i] += b[v.pos + i] * g;
      v.pos += m; if (v.pos >= b.length) v.buf = null;
    }
    if (this.drone && (this.droneGain > 0 || this.droneTarget > 0)) {
      const d = this.drone, step = 1 / (sampleRate * 0.8);
      for (let i = 0; i < n; i++) {
        this.droneGain += this.droneGain < this.droneTarget ? Math.min(step, this.droneTarget - this.droneGain) : -Math.min(step, this.droneGain - this.droneTarget);
        out[i] += d[this.dronePos] * this.droneGain; this.dronePos = (this.dronePos + 1) % d.length;
      }
    }
    for (let i = 0; i < n; i++) { const x = out[i]; out[i] = x > 1 ? 1 : x < -1 ? -1 : x; } // hard safety clip
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.levelAcc += n;
    if (this.levelAcc >= this.levelEvery) { this.levelAcc = 0; this.post({ type: 'level', rms: this.det.lastRms }); }
    return true;
  }
}

registerProcessor('benchpress', BenchpressProcessor);
