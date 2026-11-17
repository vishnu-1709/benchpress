// Message contract between the page (main thread) and the audio thread (AudioWorklet).
// Keep this file the single source of truth: both sides import these types.

export const DSP_VERSION = 4;

export interface DspConfig {
  postMs: number;        // feature window after onset (ms); each ms is a ms of lag
  threshold: number;     // onset threshold, multiple of the noise floor
  rise: number;          // energy must rise this many times vs 5 ms earlier
  refractoryMs: number;  // ignore re-triggers within this window
  minLevel: number;      // absolute floor (RMS): quieter sounds are never taps
}

export const DEFAULT_CONFIG: DspConfig = { postMs: 15, threshold: 10, rise: 4, refractoryMs: 60, minLevel: 0.0004 };

/** A trained table model: what calibration produced. */
export interface TableModel {
  zoneFeats: number[][];   // calibration feature vectors (finger taps)
  zoneLabels: number[];    // 0..3
  knuckleFeats: number[][];// knuckle calibration vectors (may be empty)
  knuckleLabels: number[]; // zone of each knuckle calibration tap
  zonePeakMean: number[];  // mean peak per zone, for velocity normalisation
  rejectDist: number;      // normalised distance beyond which a tap matches nothing
}

export type Mode =
  | { kind: 'idle' }                       // listening, no sound (setup screens)
  | { kind: 'first' }                      // first-tap screen: any tap plays a sound
  | { kind: 'calibrate'; zone: number }    // collect finger taps for one zone
  | { kind: 'calibrateKnuckle'; zone: number } // collect knuckle taps for one zone
  | { kind: 'play' }
  | { kind: 'inspect' };                    // like play, but silent and reports every tap's fingerprint

export type ToWorklet =
  | { type: 'config'; config: DspConfig }
  | { type: 'model'; model: TableModel | null }
  | { type: 'instrument'; id: string; sounds: Float32Array[]; choke: boolean; spreadMs: number } // 8 buffers: index = zone*2 + knuckle
  | { type: 'select'; id: string }
  | { type: 'drone'; buffer: Float32Array | null; gain: number; hits: number[] } // hits: pluck times (s) in the loop
  | { type: 'mode'; mode: Mode }
  | { type: 'headphones'; on: boolean }
  | { type: 'loop'; cmd: 'toggle' | 'clear' }
  | { type: 'latencyTest' }
  | { type: 'preview'; sound: number; gain: number }
  | { type: 'record'; on: boolean };

export type LoopPhase = 'empty' | 'recording' | 'playing' | 'overdub';

export type FromWorklet =
  | { type: 'ready'; sampleRate: number }
  | { type: 'tap'; zone: number; knuckle: boolean; velocity: number; confidence: number; frame: number }
  | { type: 'unsure'; frame: number; velocity: number }
  | { type: 'calTap'; feat: number[]; peak: number; rms: number; frame: number }
  | { type: 'level'; rms: number }
  | { type: 'loop'; phase: LoopPhase; lengthSec: number; layers: number }
  | { type: 'latency'; ms: number | null; leak: number }
  | { type: 'loopFull' }
  | { type: 'stats'; echoDelayMs: number | null; echoLearned: boolean; quietSpeaker: boolean; leak: number; echoesRejected: number; tooQuiet: number; noise: number; minLevel: number; onsets: number }
  | { type: 'rec'; channels: Float32Array[] }
  | { type: 'inspect'; feat: number[]; peak: number; zone: number; knuckle: boolean; confidence: number; dist: number; micDb: number | null; frame: number };            // raw mic chunk while recording (both channels)
