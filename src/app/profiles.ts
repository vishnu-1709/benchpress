// Saved tables: one calibration profile per surface, kept only on this device.
import { DSP_VERSION, type TableModel } from '../engine/protocol';
import { rejectDistance, surfaceQuality } from '../engine/dsp';
import { store, type Tilt } from './env';

export interface CalTap { zone: number; feat: number[]; peak: number }

export interface TableProfile {
  v: 1;
  id: string;
  name: string;
  created: string;
  dspVersion: number;
  sampleRate: number;
  tilt: Tilt | null;
  zoneTaps: CalTap[];      // finger taps with their zone
  knuckleTaps: CalTap[];   // knuckle taps, 2 per zone
  quality: number;         // leave-one-out zone accuracy 0..1
}

const KEY = 'benchpress.tables.v1';
interface Saved { tables: TableProfile[]; lastId: string | null }

const MAX_PER_ZONE = 8; // keep calibration small and fresh: newest taps win

export function buildModel(p: Pick<TableProfile, 'zoneTaps' | 'knuckleTaps'>): TableModel {
  const feats = p.zoneTaps.map(t => t.feat), labels = p.zoneTaps.map(t => t.zone);
  const zonePeakMean = [0, 1, 2, 3].map(z => {
    const ps = p.zoneTaps.filter(t => t.zone === z).map(t => t.peak);
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.1;
  });
  return { zoneFeats: feats, zoneLabels: labels, knuckleFeats: p.knuckleTaps.map(t => t.feat), knuckleLabels: p.knuckleTaps.map(t => t.zone), zonePeakMean, rejectDist: rejectDistance(feats, labels) };
}

export function qualityOf(zoneTaps: CalTap[]) { return surfaceQuality(zoneTaps.map(t => t.feat), zoneTaps.map(t => t.zone)); }

/** Merge fresh taps into a profile (quick re-tune): newest taps per zone are kept. */
export function mergeTaps(old: CalTap[], fresh: CalTap[]): CalTap[] {
  const out: CalTap[] = [];
  for (let z = 0; z < 4; z++) {
    const all = [...old.filter(t => t.zone === z), ...fresh.filter(t => t.zone === z)];
    out.push(...all.slice(-MAX_PER_ZONE));
  }
  return out;
}

export const profiles = {
  all(): TableProfile[] { return store.get<Saved>(KEY, { tables: [], lastId: null }).tables.filter(t => t.dspVersion === DSP_VERSION); },
  last(): TableProfile | null {
    const s = store.get<Saved>(KEY, { tables: [], lastId: null });
    return s.tables.find(t => t.id === s.lastId && t.dspVersion === DSP_VERSION) ?? null;
  },
  save(p: TableProfile) {
    const s = store.get<Saved>(KEY, { tables: [], lastId: null });
    s.tables = [p, ...s.tables.filter(t => t.id !== p.id)].slice(0, 8);
    s.lastId = p.id; store.set(KEY, s);
  },
  use(id: string) { const s = store.get<Saved>(KEY, { tables: [], lastId: null }); s.lastId = id; store.set(KEY, s); },
  remove(id: string) {
    const s = store.get<Saved>(KEY, { tables: [], lastId: null });
    s.tables = s.tables.filter(t => t.id !== id); if (s.lastId === id) s.lastId = s.tables[0]?.id ?? null; store.set(KEY, s);
  },
  create(name: string, sampleRate: number, tilt: Tilt | null, zoneTaps: CalTap[], knuckleTaps: CalTap[] = []): TableProfile {
    return { v: 1, id: Math.random().toString(36).slice(2, 10), name, created: new Date().toISOString(), dspVersion: DSP_VERSION,
      sampleRate, tilt, zoneTaps, knuckleTaps, quality: qualityOf(zoneTaps) };
  },
};
