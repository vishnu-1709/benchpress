# Status: v1

## Done and tested (synthetic taps, headless Chromium)

| Area | Result |
| --- | --- |
| Tap detection | 100% of taps found, 0 false triggers (unit tests at 44.1 and 48 kHz) |
| Zone, finger taps | 85–95% across synthetic tables, 5 calibration taps per zone |
| Finger vs knuckle | 99–100% |
| Zone, knuckle taps | 67–84% with 2 knuckle taps per zone (weakest point; was 28–60% without per-zone knuckle calibration) |
| Speaker feedback (closed loop: output leaks back into the mic, 60–200 ms lag) | 0 phantom taps in all 12 cases (1 in the loudest sitar case); delay learned within 1–2 ms |
| Real taps kept while sounds play, quiet speaker (leak 0.1) | drums 24/24, sitar 19/24, guitar 17/24 |
| Real taps kept, loud speaker (leak 0.3–0.6) | drums 14–20/24; guitar and sitar 4–13/24: ringing sounds drown taps, so use headphones |
| Full app flow (e2e) | landing → mic → flat → first tap → calibration → play → knuckle unlock, no errors |
| DSP cost | ~2 µs per 128-sample block (budget 2,667 µs) |

## How echo rejection works

The phone hears its own speaker through the table. Without protection, every sound becomes a new "tap" and it plays by itself.

1. The audio thread knows exactly when it starts each sound (taps, loop playback, drone plucks).
2. It learns the echo delay from a histogram of (mic onset − sound start): echoes pile up at one delay, real taps spread out. The start-up click gives a first estimate.
3. Onsets at that delay (plus the sound's attack length) are ignored.
4. Outside that window, a tap must be clearly louder than the expected echo level, learned from identified echoes.
5. If sounds keep playing and no consistent echo delay ever appears, the speaker isn't reaching the mic, and the checks relax.
6. Calibration plays only a quiet tick, and strummed or melodic instruments mute their previous note (choke).

Headphones mode switches all of this off.

## Not yet known (needs your phone and table)

- **Gate 0:** do real table taps separate into 4 zones? Record and run `tools/tap_test.py` (try `--post-ms 10` and `--post-ms 15`).
- **Gate 1:** tap-to-sound latency on real phones. Settings → Speed shows it. Under ~60 ms is fine; over ~80 ms on most phones means a native Android build.
- iPhone behaviour (silent switch, output volume while the mic is on).

## Next

1. Deploy (enable GitHub Pages), open on your phone, calibrate on a hard table.
2. Record real samples (sitar, dhol, guitar) to replace the rendered placeholder sounds: same 8-sounds-per-pack interface.
3. Device matrix + 5-stranger test (Gate 2).

Plan documents: v1 Build Plan and Product Spec (Claude Docs).
