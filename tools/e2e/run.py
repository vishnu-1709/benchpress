"""End-to-end test: the real app in headless Chromium, a scripted WAV as the microphone.
Usage: npm run build && npx vite preview --port 4173 &  then  python3 tools/e2e/run.py
"""
import json, time, sys, os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
truth = json.load(open(os.path.join(OUT, 'truth.json')))
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/?debug'

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                f'--use-file-for-fake-audio-capture={OUT}/session.wav%noloop', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(**p.devices['Pixel 7'])
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(URL); pg.wait_for_timeout(800)
    pg.screenshot(path=f'{OUT}/1-landing.png')
    pg.click('#try'); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/2-permission.png')
    pg.click('#allow'); t0 = time.time()
    pg.wait_for_selector('#flat-manual:not(.hidden)', timeout=5000)
    pg.screenshot(path=f'{OUT}/3-flat.png')
    pg.click('#flat-manual')
    pg.wait_for_timeout(2500); pg.screenshot(path=f'{OUT}/4-first.png')
    pg.wait_for_selector('[data-screen="calibrate"].active', timeout=10000)
    pg.wait_for_timeout(2500); pg.screenshot(path=f'{OUT}/5-calibrate.png')
    pg.wait_for_selector('[data-screen="caldone"].active', timeout=20000)
    pg.screenshot(path=f'{OUT}/6-caldone.png')
    quality = pg.inner_text('#quality-text')
    pg.click('#go-play')
    pg.wait_for_timeout(int(max(0, 30 - (time.time() - t0)) * 1000)); pg.screenshot(path=f'{OUT}/7-play.png')
    pg.wait_for_timeout(int(max(0, 44.2 - (time.time() - t0)) * 1000))
    pg.click('#open-settings'); pg.wait_for_timeout(200); pg.screenshot(path=f'{OUT}/8-settings.png')
    pg.click('#reknuckle')
    pg.wait_for_timeout(int(max(0, 59 - (time.time() - t0)) * 1000))
    pg.screenshot(path=f'{OUT}/9-knuckle-play.png')
    log = pg.evaluate('window.__bp.log'); prof = pg.evaluate('window.__bp.profile()')
    b.close()

taps = [e for e in log if e['type'] in ('tap', 'unsure')]
cal = [e for e in log if e['type'] == 'calTap']
play_truth = [t for t in truth if 26 <= t['sec'] < 45]
mixed_truth = [t for t in truth if t['sec'] >= 51.5]
# play taps: tap/unsure events from the 2nd one (1st = first-tap) until the knuckle calibration taps
play_events = [e for e in taps[1:]][:len(play_truth)]
zone_ok = sum(1 for e, t in zip(play_events, play_truth) if e['type'] == 'tap' and e['zone'] == t['z'])
mixed_events = taps[1 + len(play_truth):]
mz = sum(1 for e, t in zip(mixed_events, mixed_truth) if e['type'] == 'tap' and e['zone'] == t['z'])
mk = sum(1 for e, t in zip(mixed_events, mixed_truth) if e['type'] == 'tap' and e['knuckle'] == t['kn'])
print(f'calibration taps captured: {len(cal)} (expected 28 = 20 zone + 8 knuckle)')
print(f'calibration quality shown: {quality}')
print(f'play: {len(play_events)} events for {len(play_truth)} taps, zone correct {zone_ok}/{len(play_truth)}')
print(f'mixed: {len(mixed_events)} events for {len(mixed_truth)} taps, zone {mz}/{len(mixed_truth)}, finger/knuckle {mk}/{len(mixed_truth)}')
print(f'profile saved: {prof and prof["name"]}, zone taps {prof and len(prof["zoneTaps"])}, knuckle taps {prof and len(prof["knuckleTaps"])}')
print('errors:', errs)
