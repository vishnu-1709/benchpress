"""End-to-end test: the real app in headless Chromium, a scripted WAV as the microphone.
Usage: npm run build && npx vite preview --port 4173 &  then  python3 tools/e2e/run.py
"""
import json, time, sys, os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
truth = json.load(open(os.path.join(OUT, 'truth.json')))
MOTION = '--motion' in sys.argv
URL = 'http://localhost:4173/?debug'

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
    if MOTION:
        # fake motion sensor, 100 readings/s: the phone rocks towards the tapped side for ~40 ms
        pg.evaluate('''(truth) => {
          const start = performance.now() + 120;  // fake mic starts a little after the click
          window.__motionStart = start;
          const dir = [[-1, 0], [0, 1], [1, 0], [0, -1]];
          setInterval(() => {
            const now = performance.now() - start; let rx = 0, ry = 0;
            for (const t of truth) { const d = now - t.sec * 1000; if (d > 0 && d < 30) { const k = 6 * (0.6 + 0.4 * Math.sin(t.sec * 7)); rx += dir[t.z][1] * k; ry += dir[t.z][0] * k; } }
            const n = () => (Math.random() - 0.5) * 0.6;
            window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: n(), beta: rx + n(), gamma: ry + n() }, acceleration: { x: ry * 0.05 + n(), y: rx * 0.05 + n(), z: n() }, interval: 10 }));
          }, 10);
        }''', truth)
    pg.wait_for_selector('#flat-manual:not(.hidden)', timeout=5000)
    pg.screenshot(path=f'{OUT}/3-flat.png')
    pg.click('#flat-manual')
    pg.wait_for_timeout(2500); pg.screenshot(path=f'{OUT}/4-first.png')
    pg.wait_for_selector('[data-screen="calibrate"].active', timeout=10000)
    pg.wait_for_timeout(2500); pg.screenshot(path=f'{OUT}/5-calibrate.png')
    pg.wait_for_selector('[data-screen="caldone"].active', timeout=30000)
    pg.screenshot(path=f'{OUT}/6-caldone.png')
    quality = pg.inner_text('#quality-text'); method_text = pg.inner_text('#method-text')
    pg.click('#go-play')
    pg.wait_for_timeout(int(max(0, 33 - (time.time() - t0)) * 1000)); pg.screenshot(path=f'{OUT}/7-play.png')
    pg.wait_for_timeout(int(max(0, 47.2 - (time.time() - t0)) * 1000))
    pg.click('#open-settings'); pg.wait_for_timeout(200); pg.screenshot(path=f'{OUT}/8-settings.png')

    pg.click('#reknuckle')
    pg.wait_for_timeout(int(max(0, 62 - (time.time() - t0)) * 1000))
    pg.screenshot(path=f'{OUT}/9-knuckle-play.png')
    log = pg.evaluate('window.__bp.log'); prof = pg.evaluate('window.__bp.profile()')
    mstart = pg.evaluate('window.__motionStart || 0')
    pg.click('#open-settings'); pg.wait_for_timeout(200); pg.click('#open-inspect'); pg.wait_for_timeout(1000)
    pg.screenshot(path=f'{OUT}/10-inspect.png', full_page=True)
    b.close()

taps = [e for e in log if e['type'] in ('tap', 'unsure')]
cal = [e for e in log if e['type'] == 'calTap']
# events carry audio frame numbers; the first tap event is the scripted first tap at 6.0 s
sr_ctx = next((e['sampleRate'] for e in log if e['type'] == 'ready'), 44100)
t0 = taps[0]['frame']
sec = lambda e: 6.0 + (e['frame'] - t0) / sr_ctx
def match(truth_part):
    # the fake mic can slip by tens of ms under load: match each tap to the nearest event within 120 ms,
    # tracking the running slip so later taps stay aligned
    out, slip, used = [], 0.0, set()
    for t in truth_part:
        cands = [e for e in taps if id(e) not in used and abs(sec(e) - slip - t['sec']) < 0.12]
        e = min(cands, key=lambda e: abs(sec(e) - slip - t['sec']), default=None)
        if e: used.add(id(e)); slip = 0.7 * slip + 0.3 * (sec(e) - t['sec'])
        out.append((t, e))
    return out
play = match([t for t in truth if 29 <= t['sec'] < 48])
mixed = match([t for t in truth if t['sec'] >= 54.5])
det = lambda m: sum(1 for t, e in m if e)
zok = lambda m: sum(1 for t, e in m if e and e['type'] == 'tap' and e['zone'] == t['z'])
kok = lambda m: sum(1 for t, e in m if e and e['type'] == 'tap' and e['knuckle'] == t['kn'])
matched = {id(e) for m in (play, mixed) for _, e in m if e}
phantom = sum(1 for e in taps[1:] if id(e) not in matched and not any(abs(sec(e) - t['sec']) < 0.15 for t in truth))
print(f'calibration taps captured: {len(cal)} (expected 40 = 32 zone + 8 knuckle)')
print(f'calibration quality shown: {quality} · {method_text}')
print(f'play: detected {det(play)}/{len(play)}, zone correct {zok(play)}/{len(play)}')
print(f'mixed finger/knuckle: detected {det(mixed)}/{len(mixed)}, zone {zok(mixed)}/{len(mixed)}, finger/knuckle {kok(mixed)}/{len(mixed)}')
print(f'phantom taps: {phantom}')
print(f'profile saved: {prof and prof["name"]}, zone taps {prof and len(prof["zoneTaps"])}, knuckle taps {prof and len(prof["knuckleTaps"])}')
print('errors:', errs)
json.dump({'log': log, 'mstart': mstart if MOTION else 0}, open(f'{OUT}/log.json', 'w'))
