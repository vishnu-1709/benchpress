import { describe, it, expect } from 'vitest';
import { PACKS } from '../src/sounds/packs';

describe('sound packs', () => {
  for (const p of PACKS) {
    it(`${p.name}: 8 finite sounds, start instantly, render fast`, () => {
      const t0 = performance.now();
      const s = p.render(44100);
      const ms = performance.now() - t0;
      expect(s).toHaveLength(8);
      for (const b of s) {
        expect(b.length).toBeGreaterThan(1000);
        let peak = 0, first = -1;
        for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (!Number.isFinite(a)) throw new Error('NaN'); peak = Math.max(peak, a); if (first < 0 && a > 0.05) first = i; }
        expect(peak).toBeLessThanOrEqual(1);
        expect(peak).toBeGreaterThan(0.3);
        expect(first / 44100 * 1000).toBeLessThan(3); // no leading silence = no added lag
      }
      expect(ms).toBeLessThan(1500);
      if (p.drone) { const d = p.drone(44100); expect(d.length).toBeGreaterThan(44100); }
    });
  }
});
