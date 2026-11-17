# Status: v1

## Done and tested (synthetic taps, headless Chromium)

| Area | Result |
| --- | --- |
| Tap detection | 100% of taps found, 0 false triggers (unit tests at 44.1 and 48 kHz) |
| Zone, finger taps | 85–95% across synthetic tables, 5 calibration taps per zone |
| Finger vs knuckle | 99–100% |
| Zone, knuckle taps | 67–84% with 2 knuckle taps per zone (weakest point; was 28–60% without per-zone knuckle calibration) |
| Own-sound masking | 0 phantom taps from loop playback; ≥85% of real taps kept at moderate volume |
| Full app flow (e2e) | landing → mic → flat → first tap → calibration → play → knuckle unlock, no errors |
| DSP cost | ~2 µs per 128-sample block (budget 2,667 µs) |

## Not yet known (needs your phone and table)

- **Gate 0:** do real table taps separate into 4 zones? Record and run `tools/tap_test.py` (try `--post-ms 10` and `--post-ms 15`).
- **Gate 1:** tap-to-sound latency on real phones. Settings → Speed shows it. Under ~60 ms is fine; over ~80 ms on most phones means a native Android build.
- iPhone behaviour (silent switch, output volume while the mic is on).

## Next

1. Deploy (enable GitHub Pages), open on your phone, calibrate on a hard table.
2. Record real samples (sitar, dhol, guitar) to replace the rendered placeholder sounds: same 8-sounds-per-pack interface.
3. Device matrix + 5-stranger test (Gate 2).

Plan documents: v1 Build Plan and Product Spec (Claude Docs).
