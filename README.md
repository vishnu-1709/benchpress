# BenchPress

**Tap the table. Make music.** Put your phone flat on a table, tap the table around it, and it plays. Four spots, finger or knuckle, harder = louder. No install, no extra hardware, nothing leaves your phone.

*Never skip bench day.*

## How it works

The phone's microphone hears each tap travelling through the table. A tap on a different spot sounds slightly different (the table's resonances mix differently), so after a 20-second calibration a small classifier can tell the spots apart. Everything runs in the browser, inside one real-time AudioWorklet: hear → classify → play, without touching the page's UI thread.

```
Mic (raw) → onset detector → 15 ms spectrum → kNN (zone + finger/knuckle) → sampler → speaker
                    ↑ output mask: ignores the app's own sounds        ↘ loop recorder
```

## v1 features

- First tap plays within ~15 s of opening the link
- Calibration as play: 5 taps on each of 4 spots, each tap already makes sound; "surface quality" score
- Velocity: tap harder, play louder
- Knuckle unlock: 2 knuckle knocks per spot → 8 sounds per instrument
- Instruments: Drums, Dhol, Guitar (4 chords), Sitar (raga Bhupali) + tanpura drone
- Loop station: record, layer across instruments, clear
- Saved tables (on-device), quick re-tune, "phone moved" detection
- Headphones mode, sensitivity, latency test, help, privacy
- Desktop QR gate, in-app-browser warning, screen wake lock

## Develop

```bash
npm install
npm run dev        # opens on your LAN; phones need HTTPS for the mic, so test on the deployed site
npm test           # DSP + sound pack unit tests (synthetic table taps)
npm run e2e        # whole app in headless Chromium with a scripted WAV as the microphone
npm run build
```

Deploys to GitHub Pages on every push to `main` (enable it once: **Settings → Pages → Source: GitHub Actions**).

Add `?debug` to the URL to expose an event log on `window.__bp`.

## Project layout

```
src/engine/protocol.ts   message contract page <-> audio thread, table model, modes
src/engine/dsp.ts        pure DSP: onset detector, features, kNN, output masking (runs in Node too)
src/engine/worklet.ts    AudioWorklet: detect, classify, sampler, drone, loop recorder, latency test
src/engine/engine.ts     page-side wrapper (mic with voice processing off, worklet setup)
src/sounds/              rendered sound packs (swap in recorded samples later, same interface)
src/app/                 environment checks, wake lock, tilt, saved table profiles
src/ui/                  styles and canvas effects
src/main.ts              screens and flow
tests/                   unit tests + synthetic tap generator
tools/tap_test.py        Gate 0: test zone separation on your own recorded taps
tools/e2e/               end-to-end browser test with a fake microphone
docs/                    plan and status
```

## Status

All logic is tested on **synthetic** taps. Real tables and real phones are the open question. See [docs/STATUS.md](docs/STATUS.md).
