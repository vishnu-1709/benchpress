// Side detection: synthetic taps where sound barely separates areas but motion carries direction.
import { describe, it, expect } from 'vitest';
import { chooseMethod, SideClassifier, type SideTap } from '../src/app/sides';
import { N_FEAT } from '../src/engine/dsp';

function rnd(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

/** soundSep: how different areas sound (0 = identical). motionSep: how clearly the phone rocks per side (0 = no info). */
/** The table (how each area sounds) is fixed by tableSeed; seed varies the individual taps. */
function taps(n: number, soundSep: number, motionSep: number, seed: number, motion = true, tableSeed = 1): SideTap[] {
  const r = rnd(seed), rc = rnd(tableSeed), out: SideTap[] = [];
  const dir = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // left, top, right, bottom → rotation axes
  const soundCentre = Array.from({ length: 4 }, () => Array.from({ length: N_FEAT }, () => gauss(rc)));
  for (let z = 0; z < 4; z++) for (let i = 0; i < n; i++) {
    const force = 0.5 + r();
    out.push({ zone: z,
      feat: soundCentre[z].map(c => c * soundSep + gauss(r)),
      motion: motion ? [dir[z][1] * motionSep * force + gauss(r) * 0.5, dir[z][0] * motionSep * force + gauss(r) * 0.5, gauss(r) * 0.5,
        dir[z][0] * motionSep * 0.3 * force + gauss(r) * 0.5, dir[z][1] * motionSep * 0.3 * force + gauss(r) * 0.5, gauss(r)] : null });
  }
  return out;
}
const acc = (c: SideClassifier, test: SideTap[]) => test.filter(t => c.classify(t.feat, t.motion ?? null)?.zone === t.zone).length / test.length;

describe('sides: sound + motion', () => {
  it('sound alike, motion clear → picks motion/both and gets sides right', () => {
    const cal = taps(8, 0.15, 3, 1), test = taps(25, 0.15, 3, 2);
    const ch = chooseMethod(cal);
    expect(ch.method).not.toBe('sound');
    expect(ch.scores.sound).toBeLessThan(0.5);
    expect(acc(new SideClassifier(cal, ch.method), test)).toBeGreaterThan(0.85);
  });
  it('sound clear, motion useless → stays with sound (no added lag)', () => {
    const cal = taps(8, 2, 0, 3);
    expect(chooseMethod(cal).method).toBe('sound');
  });
  it('no motion readings at all → sound', () => {
    const cal = taps(8, 0.5, 0, 4, false);
    const ch = chooseMethod(cal);
    expect(ch.method).toBe('sound'); expect(ch.scores.motion).toBe(0);
  });
  it('both weak → the chosen method is close to the best of the three', () => {
    for (const seed of [5, 7, 9]) {
      const cal = taps(8, 0.6, 1.2, seed), test = taps(25, 0.6, 1.2, seed + 100);
      const all = (['sound', 'motion', 'both'] as const).map(m => acc(new SideClassifier(cal, m), test));
      const chosen = acc(new SideClassifier(cal, chooseMethod(cal).method), test);
      expect(chosen).toBeGreaterThanOrEqual(Math.max(...all) - 0.16); // may keep sound to avoid lag when the gain is small
    }
  });
});
