// Page-side wrapper around the AudioWorklet: starts audio + mic, sends messages, fans out events.
import workletUrl from './worklet.ts?worker&url';
import type { DspConfig, FromWorklet, Mode, TableModel, ToWorklet } from './protocol';

type Listener = (m: FromWorklet) => void;

export class Engine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  sampleRate = 48000;
  micSettings: MediaTrackSettings | null = null;

  /** Must be called from a user gesture (button tap) so audio may start. */
  async unlock() {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
  }

  /** Asks for the microphone with every voice-processing feature off, then starts the worklet. */
  async startMic() {
    await this.unlock();
    const ctx = this.ctx!;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } },
    });
    const track = this.stream.getAudioTracks()[0];
    this.micSettings = track.getSettings();
    await ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(ctx, 'benchpress', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.listeners.forEach(l => l(e.data));
    const src = ctx.createMediaStreamSource(this.stream);
    // the worklet reads channel 0 only; stereo mics are fine
    src.connect(this.node);
    this.node.connect(ctx.destination);
    track.addEventListener('ended', () => this.emitLocal({ type: 'level', rms: -1 }));
  }

  get running() { return !!this.node; }

  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emitLocal(m: FromWorklet) { this.listeners.forEach(l => l(m)); }

  private send(m: ToWorklet, transfer: Transferable[] = []) { this.node?.port.postMessage(m, transfer); }

  setConfig(config: DspConfig) { this.send({ type: 'config', config }); }
  setModel(model: TableModel | null) { this.send({ type: 'model', model }); }
  setMode(mode: Mode) { this.send({ type: 'mode', mode }); }
  setHeadphones(on: boolean) { this.send({ type: 'headphones', on }); }
  loadInstrument(id: string, sounds: Float32Array[], choke = false, spreadMs = 25) {
    // copies are sent (not transferred) so the page can re-send after a reload of the worklet
    this.send({ type: 'instrument', id, sounds: sounds.map(s => s.slice()), choke, spreadMs });
  }
  select(id: string) { this.send({ type: 'select', id }); }
  drone(buffer: Float32Array | null, gain = 0.35, hits: number[] = []) { this.send({ type: 'drone', buffer: buffer ? buffer.slice() : null, gain, hits }); }
  loop(cmd: 'toggle' | 'clear') { this.send({ type: 'loop', cmd }); }
  latencyTest() { this.send({ type: 'latencyTest' }); }
  preview(sound: number, gain = 0.8) { this.send({ type: 'preview', sound, gain }); }
}

export const engine = new Engine();
