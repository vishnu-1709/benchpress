import './ui/style.css';
declare const __APP_VERSION__: string;
import qrcode from 'qrcode-generator';
import { engine } from './engine/engine';
import { DEFAULT_CONFIG, DSP_VERSION, type FromWorklet, type Mode } from './engine/protocol';
import { PACKS, packById, renderPack } from './sounds/packs';
import { Fx } from './ui/fx';
import { Recorder } from './app/recorder';
import { Inspector } from './ui/inspect';
import { motion } from './app/motion';
import { chooseMethod, confusion, SideClassifier, type Method } from './app/sides';
import { TapClassifier } from './engine/dsp';
import { buildModel, mergeTaps, profiles, typicalTapRms, type CalTap, type TableProfile } from './app/profiles';
import {
  currentTilt, inAppBrowser, isFlat, isIOS, isMobile, keepAwake, micSupported, needsOrientationPermission,
  onTilt, secure, startOrientation, store, tiltDelta, type Tilt,
} from './app/env';

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll(s)) as T[];
const COLORS = ['#3d8bff', '#ff4d6d', '#ffc93d', '#3ddc97'];
const NAMES = ['blue', 'pink', 'yellow', 'green'];
const fx = new Fx($('#fx') as HTMLCanvasElement);
let toastTimer = 0;
function toast(msg: string, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

type Screen = 'landing' | 'desktop' | 'permission' | 'flat' | 'welcome' | 'first' | 'calibrate' | 'caldone' | 'play';
let screen: Screen = 'landing';
function show(s: Screen) {
  screen = s;
  $$('.screen').forEach(el => el.classList.toggle('active', el.dataset.screen === s));
  keepAwake(['first', 'calibrate', 'caldone', 'play'].includes(s));
  applyDrone();
}
function openOverlay(id: string) { $('#' + id).classList.remove('hidden'); if (id === 'settings') renderSettings(); }
function closeOverlay(id: string) { $('#' + id).classList.add('hidden'); }
$$('[data-open]').forEach(b => b.addEventListener('click', () => openOverlay(b.dataset.open!)));
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeOverlay(b.closest('.overlay')!.id)));
$$('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o && o.id !== 'knuckle') closeOverlay(o.id); }));

// ---------- app state ----------
const prefs = store.get('benchpress.prefs', { pack: 'drums', headphones: false, sensitivity: 6 });
const savePrefs = () => store.set('benchpress.prefs', prefs);
let profile: TableProfile | null = null;
let latencyMs: number | null = null;
let lastStats: Extract<FromWorklet, { type: 'stats' }> | null = null;
let baselineTilt: Tilt | null = null;
const loadedPacks = new Set<string>();
// sensitivity 0..10: higher = softer taps count (and more risk of noise)
// After calibration, anything much quieter than this person's normal tap on this table is ignored.
const config = () => {
  const typical = profile ? typicalTapRms(profile.zoneTaps) : null;
  const scale = Math.pow(1.4, 6 - prefs.sensitivity);           // sensitivity 6 = default
  const minLevel = typical ? 0.25 * typical * scale : DEFAULT_CONFIG.minLevel * scale;
  return { ...DEFAULT_CONFIG, threshold: 16 - prefs.sensitivity, minLevel };
};
const applyConfig = () => engine.setConfig(config());

function setMode(m: Mode) { engine.setMode(m); }
/** Play mode: sound-only tables are classified inside the audio thread (no lag); sides with motion are decided here. */
const playMode = (): Mode => ({ kind: 'play', external: !!profile?.method && profile.method !== 'sound' });

// ---------- choosing sound / motion / both for a table ----------
function decideMethod(p: TableProfile) {
  const ch = chooseMethod([...p.zoneTaps, ...p.knuckleTaps]);
  p.method = ch.method; p.soundMode = ch.soundMode; p.scores = ch.scores; p.quality = ch.scores[ch.method];
}
let sideCls: SideClassifier | null = null, mainCls: TapClassifier | null = null;
function setTable(p: TableProfile) {
  profile = p;
  const model = buildModel(p);
  engine.setModel(model); applyConfig();
  mainCls = new TapClassifier(model);
  sideCls = p.method && p.method !== 'sound' ? new SideClassifier([...p.zoneTaps, ...p.knuckleTaps], p.method, p.soundMode ?? 'raw') : null;
}
const METHOD_NAME: Record<Method, string> = { sound: 'sound', motion: 'motion', both: 'sound + motion' };
// (sound fingerprint variant per table: 'raw' levels or force-resistant 'shape', see sides.chooseMethod)

function ensurePack(id: string) {
  const p = packById(id);
  if (!loadedPacks.has(p.id)) {
    const r = renderPack(p, engine.sampleRate);
    engine.loadInstrument(p.id, r.sounds, p.choke === 'all', p.spreadMs ?? 25);
    loadedPacks.add(p.id);
  }
  return p;
}
/** The drone plays only on the play screen: anywhere else it would echo back and be heard as taps. */
function applyDrone() {
  if (!engine.running) return;
  const p = packById(prefs.pack), r = renderPack(p, engine.sampleRate);
  if (screen === 'play' && r.drone) engine.drone(r.drone, 0.12, p.droneHits ?? []); else engine.drone(null);
}
function selectPack(id: string) {
  const p = ensurePack(id);
  engine.select(p.id);
  prefs.pack = p.id; savePrefs();
  applyDrone();
  renderPads(); renderChips();
}

// ---------- engine events ----------
const listeners: ((m: FromWorklet) => void)[] = [];
engine.on(m => listeners.forEach(l => l(m)));
function once<T extends FromWorklet['type']>(type: T, timeoutMs: number): Promise<Extract<FromWorklet, { type: T }> | null> {
  return new Promise(res => {
    const l = (m: FromWorklet) => { if (m.type === type) { done(); res(m as any); } };
    const t = setTimeout(() => { done(); res(null); }, timeoutMs);
    const done = () => { clearTimeout(t); const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    listeners.push(l);
  });
}
// ?debug: keep an event log for automated tests and remote debugging
const debugLog: unknown[] = [];
if (location.search.includes('debug')) (window as any).__bp = { log: debugLog, profile: () => profile, screen: () => screen };
listeners.push(m => {
  if (debugLog.length < 2000 && m.type !== 'level') debugLog.push({ ...m, at: Math.round(performance.now()) });
  if (m.type === 'level') {
    const s = Math.min(1, Math.max(0, m.rms) * 40);
    $('#ring').style.transform = `scale(${1 + s * 0.5})`; $('#ring').style.borderColor = s > 0.3 ? '#fff' : '';
    $('#listen-dot').style.transform = `scale(${1 + s * 1.5})`;
    if (screen === 'calibrate') { const f = $('#cal-meter'); f.style.width = `${meterPos(m.rms) * 100}%`; f.classList.toggle('over', m.rms > calFloor); }
    if (m.rms < 0) { $('#listen-text').textContent = 'mic stopped — reload'; }
  }
  if (m.type === 'tap') onPlayTap(m.zone, m.knuckle, m.velocity);
  if (m.type === 'unsure') onUnsure();
  if (m.type === 'calTap') onCalTap(m.feat, m.peak, m.rms, m.frame);
  if (m.type === 'heard') onHeard(m.feat, m.peak, m.frame);
  if (m.type === 'loop') renderLoop(m.phase, m.layers);
  if (m.type === 'loopFull') toast('Loop is full');
  if (m.type === 'stats') lastStats = m;
  if (m.type === 'latency' && m.ms != null) latencyMs = m.ms;
});

// ---------- landing / gates ----------
function boot() {
  $$('.version').forEach(v => v.textContent = __APP_VERSION__);
  if (inAppBrowser) $('#inapp-warning').classList.remove('hidden');
  if (!secure) showUnsupported('This page must be opened over https:// for the microphone to work.');
  else if (!micSupported) showUnsupported('This browser can\'t do live audio. Use Chrome on Android, or Safari 15+ on iPhone.');
  const url = location.href.split('#')[0];
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  $('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  $('#qr-url').textContent = url;
  show(isMobile ? 'landing' : 'desktop');
}
function showUnsupported(msg: string) { const u = $('#unsupported'); u.textContent = msg; u.classList.remove('hidden'); ($('#try') as HTMLButtonElement).disabled = true; }
$('#laptop-anyway').addEventListener('click', () => show('landing'));
$('#copy-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied — paste it in Chrome'); } catch { toast(location.href, 4000); } });

$('#try').addEventListener('click', async () => {
  try { await engine.unlock(); } catch { /* resumed later */ }
  show('permission');
});

$('#allow').addEventListener('click', async () => {
  const err = $('#mic-error'); err.classList.add('hidden');
  try {
    if (!engine.running) await engine.startMic();
    motion.start();
    engine.setConfig(config());
    engine.setHeadphones(prefs.headphones);
    selectPack(prefs.pack);
    setMode({ kind: 'idle' });
    startFlatCheck();
  } catch (e: any) {
    err.classList.remove('hidden');
    err.textContent = e?.name === 'NotAllowedError'
      ? 'Microphone blocked. Tap the lock icon in the address bar, allow the microphone, then reload.'
      : e?.name === 'NotFoundError' ? 'No microphone found on this device.' : `Couldn't start audio: ${e?.message ?? e}`;
  }
});

// ---------- flat check ----------
let flatUnsub: (() => void) | null = null;
function startFlatCheck() {
  show('flat');
  const phone = $('#tilt-phone'), manual = $('#flat-manual'), perm = $('#orient-permission');
  let flatSince = 0, got = false;
  const begin = async () => {
    const ok = await startOrientation();
    if (!ok) { manual.classList.remove('hidden'); return; }
    flatUnsub?.();
    flatUnsub = onTilt(t => {
      got = true;
      phone.style.transform = `rotateX(${-t.beta}deg) rotateY(${t.gamma}deg)`;
      const flat = isFlat(t);
      phone.classList.toggle('ok', flat);
      if (!flat) { flatSince = 0; return; }
      if (!flatSince) flatSince = performance.now();
      if (performance.now() - flatSince > 700) afterFlat();
    });
    setTimeout(() => { if (!got) manual.classList.remove('hidden'); }, 1500);
  };
  if (needsOrientationPermission && isIOS) { perm.classList.remove('hidden'); perm.onclick = () => { perm.classList.add('hidden'); begin(); }; manual.classList.remove('hidden'); }
  else begin();
  manual.onclick = afterFlat;
}
function afterFlat() {
  if (screen !== 'flat') return;
  flatUnsub?.(); flatUnsub = null;
  baselineTilt = currentTilt();
  const saved = profiles.all();
  if (saved.length) renderWelcome(saved); else startFirstTap();
}

// ---------- welcome back ----------
function tableItem(t: TableProfile, actions: [string, () => void, boolean?][]) {
  const el = document.createElement('div'); el.className = 'item';
  const info = document.createElement('div');
  info.innerHTML = `<b></b><span></span>`;
  info.querySelector('b')!.textContent = t.name;
  info.querySelector('span')!.textContent = `${Math.round(t.quality * 100)}% match · ${t.knuckleTaps.length ? '8 sounds' : '4 sounds'} · ${new Date(t.created).toLocaleDateString()}`;
  el.appendChild(info);
  const btns = document.createElement('div'); btns.className = 'row-buttons';
  for (const [label, fn, ghost] of actions) { const b = document.createElement('button'); b.className = 'small' + (ghost ? ' ghost' : ''); b.textContent = label; b.onclick = fn; btns.appendChild(b); }
  el.appendChild(btns); return el;
}
function renderWelcome(saved: TableProfile[]) {
  const list = $('#table-list'); list.innerHTML = '';
  for (const t of saved) list.appendChild(tableItem(t, [['Play', () => useProfile(t)]]));
  show('welcome');
}
$('#new-table').addEventListener('click', startFirstTap);
function useProfile(t: TableProfile) {
  profiles.use(t.id); if (!t.method) decideMethod(t);
  if (t.motionOffset != null && !motion.offsetLearned) { motion.offset = t.motionOffset; motion.offsetLearned = true; }
  setTable(t);
  enterPlay();
  showBanner('Phone in a new spot? A quick re-tune helps.', 'Re-tune', () => startCalibration('quick'));
}

// ---------- first tap ----------
async function startFirstTap() {
  show('first');
  $('#first-title').textContent = 'Checking the speaker…';
  $('#first-sub').textContent = 'One click, so I know how fast your phone is.';
  setMode({ kind: 'idle' });
  engine.latencyTest();
  const r = await once('latency', 1500);
  if (r?.ms != null) latencyMs = r.ms;
  if (r && r.leak > 0.35 && !prefs.headphones)
    toast('The mic can hear your speaker. Headphones work best, or turn the volume down.', 5000);
  $('#first-title').textContent = 'Tap the table near me.';
  $('#first-sub').textContent = 'Go on — hit it.';
  setMode({ kind: 'first' });
}
function onFirstTap(vel: number) {
  const ring = $('#ring').getBoundingClientRect();
  fx.burst(ring.left + ring.width / 2, ring.top + ring.height / 2, '#ffffff', vel);
  setMode({ kind: 'idle' });
  $('#first-title').textContent = 'There it is.';
  $('#first-sub').textContent = 'Now let\'s teach it the four sides.';
  setTimeout(() => startCalibration('full'), 1100);
}

// ---------- calibration ----------
type CalKind = 'full' | 'quick';
let cal: { kind: CalKind; zone: number; per: number; taps: CalTap[] } | null = null;
let lastCalAt = 0;
let calFloor = 0;
async function startCalibration(kind: CalKind) {
  hideBanner();
  cal = null; setMode({ kind: 'idle' });
  show('calibrate');
  // 1 s quiet check: learn the room's background so only real taps count
  $('#cal-title').innerHTML = 'Hands off the table…';
  $('#cal-sub').textContent = 'Listening to the room for a second.';
  $('#cal-dots').innerHTML = '';
  $$('#cal-map b').forEach(b => b.classList.remove('now', 'done'));
  const levels: number[] = [];
  const stop = engine.on(m => { if (m.type === 'level' && m.rms >= 0) levels.push(m.rms); });
  await new Promise(r => setTimeout(r, 1000));
  stop();
  levels.sort((a, b) => a - b);
  const room = levels.length ? levels[Math.floor(levels.length * 0.95)] : 0;
  calFloor = Math.max(DEFAULT_CONFIG.minLevel, 5 * room);
  engine.setConfig({ ...config(), minLevel: kind === 'full' ? calFloor : Math.max(calFloor, config().minLevel) });
  $('#cal-floor').style.left = `${meterPos(calFloor) * 100}%`;
  $('#cal-title').innerHTML = 'Tap along the <span id="cal-color">blue</span> side.';
  $('#cal-sub').textContent = kind === 'full'
    ? 'Spread 8 taps along that side of the phone, a hand away. Mix soft and firm, one tap at a time.'
    : 'Three taps along each side.';
  cal = { kind, zone: 0, per: kind === 'full' ? 8 : 3, taps: [] };
  setCalZone(0);
}
/** Level meter position, log scale from -80 dB to 0 dB. */
const meterPos = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-4)) + 80) / 80));
function setCalZone(z: number) {
  if (!cal) return;
  cal.zone = z;
  const c = $('#cal-color'); c.textContent = NAMES[z]; c.style.color = COLORS[z];
  $$('#cal-map b').forEach(b => { const bz = +b.dataset.z!; b.classList.toggle('now', bz === z); b.classList.toggle('done', bz < z); });
  renderDots('#cal-dots', cal.per, 0, COLORS[z]);
  setMode({ kind: 'calibrate', zone: z });
}
function renderDots(sel: string, n: number, filled: number, col: string) {
  const d = $(sel); d.innerHTML = '';
  for (let i = 0; i < n; i++) { const s = document.createElement('span'); if (i < filled) s.style.background = col; d.appendChild(s); }
}
const pendingMotion: Promise<unknown>[] = [];
/** Remember when this tap happened (page clock); motion features are cut out once the clock shift is known. */
function withMotion(tap: CalTap, frame: number) {
  tap.at = engine.frameToPerf(frame);
  pendingMotion.push(new Promise(r => setTimeout(r, 250))); // let late motion readings arrive
}
/** Learn the audio→motion clock shift from these taps (if possible) and attach motion features to all of them. */
function attachMotion(taps: CalTap[]) {
  const times = taps.map(t => t.at).filter((t): t is number => t != null);
  // learn the clock shift from a full calibration (16+ taps); smaller sets reuse it
  if (motion.usable && (times.length >= 16 || (!motion.offsetLearned && times.length >= 8))) motion.learnOffset(times);
  for (const t of taps) t.motion = t.at != null && motion.usable && motion.offsetLearned ? motion.featuresAround(t.at) : null;
  if (debugLog.length < 2000 && location.search.includes('debug')) debugLog.push({ type: 'motionDbg', offset: motion.offset, learned: motion.offsetLearned, rate: motion.rate });
}
function onCalTap(feat: number[], peak: number, rms: number, frame: number) {
  if (knuckleCal) return onKnuckleTap(feat, peak, rms, frame);
  if (!cal || screen !== 'calibrate') return;
  const z = cal.zone, now = performance.now();
  // only deliberate taps: not too close together, not much quieter than the taps so far
  if (now - lastCalAt < 250) return;
  const peaks = cal.taps.map(t => t.peak).sort((a, b) => a - b);
  if (peaks.length >= 2 && peak < 0.3 * peaks[Math.floor(peaks.length / 2)]) return;
  lastCalAt = now;
  const tap: CalTap = { zone: z, feat, peak, rms }; cal.taps.push(tap); withMotion(tap, frame);
  const n = cal.taps.filter(t => t.zone === z).length;
  renderDots('#cal-dots', cal.per, n, COLORS[z]);
  const dot = document.querySelector(`#cal-map b[data-z="${z}"]`)!.getBoundingClientRect();
  fx.burst(dot.left + dot.width / 2, dot.top + dot.height / 2, COLORS[z], 0.6);
  if (n >= cal.per) {
    setMode({ kind: 'idle' });
    if (z < 3) setTimeout(() => setCalZone(z + 1), 350); else setTimeout(finishCalibration, 350);
  }
}
$('#cal-cancel').addEventListener('click', () => { cal = null; profile ? enterPlay() : show('landing'); });

async function finishCalibration() {
  if (!cal) return;
  await Promise.all(pendingMotion.splice(0));
  attachMotion(cal.kind === 'quick' && profile ? [...profile.zoneTaps.filter(t => t.at && !t.motion), ...cal.taps] : cal.taps);
  if (cal.kind === 'quick' && profile) {
    profile.zoneTaps = mergeTaps(profile.zoneTaps, cal.taps);
    decideMethod(profile); profile.tilt = currentTilt();
    profiles.save(profile); setTable(profile);
    cal = null; enterPlay(); toast(`Re-tuned · ${Math.round(profile.quality * 100)}% using ${METHOD_NAME[profile.method ?? 'sound']}`);
    return;
  }
  const draft = profiles.create('draft', engine.sampleRate, null, cal.taps, profile?.knuckleTaps ?? []);
  decideMethod(draft);
  const q = draft.quality, sc = draft.scores!;
  const cf = confusion([...draft.zoneTaps, ...draft.knuckleTaps], draft.method!, draft.soundMode ?? 'raw');
  const SIDE = ['left (blue)', 'top (pink)', 'right (yellow)', 'bottom (green)'];
  const per = cf.perSide.map((a, z) => `${SIDE[z].split(' ')[0]} ${Math.round(a * 100)}%`).join(' · ');
  const worst = cf.worst && cf.worst.n >= 2 ? ` Most mixed up: ${SIDE[cf.worst.a]} ↔ ${SIDE[cf.worst.b]}.` : '';
  // perfectly even pacing can confuse the motion clock sync
  const gaps = cal.taps.slice(1).map((t, i) => (t.at ?? 0) - (cal!.taps[i].at ?? 0)).filter(g => g > 0 && g < 2000);
  const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / Math.max(1, gaps.length)) / (mean || 1);
  const pacing = draft.method !== 'sound' && cv < 0.12 ? ' Tip: tap at an uneven pace when calibrating.' : '';
  const shapeNote = draft.soundMode === 'shape' ? ' Your taps changed with force, so I compare sound shape, not loudness.' : '';
  $('#side-text').textContent = `${per}.${worst}${shapeNote}${pacing}`;
  $('#method-text').textContent = motion.usable
    ? `Sound ${Math.round(sc.sound * 100)}% · Motion ${Math.round(sc.motion * 100)}% · Both ${Math.round(sc.both * 100)}% → using ${METHOD_NAME[draft.method!]}${draft.method !== 'sound' ? ` (sides add about ${motion.lagMs} ms of lag${motion.lagMs > 120 ? ': your browser delivers motion late' : ''})` : ''}`
    : `Sound ${Math.round(sc.sound * 100)}% · motion sensor: ${Math.round(motion.rate)} readings/s (too few for sides)`;
  ($('#quality-fill') as HTMLElement).style.width = `${Math.round(q * 100)}%`;
  $('#quality-text').textContent = `${Math.round(q * 100)}% match`;
  $('#done-title').textContent = q >= 0.8 ? 'You\'re an instrument now.' : 'Close. Some sides get mixed up.';
  $('#quality-tip').textContent = q >= 0.8
    ? 'Every side is clear enough. Keep the phone where it is.'
    : 'Tap firmly, a bit further from the phone, on a hard table. Redo calibration to try again. You can still play.';
  const n = profiles.all().length;
  ($('#table-name') as HTMLInputElement).value = n ? `Table ${n + 1}` : 'My table';
  show('caldone');
}
$('#go-play').addEventListener('click', () => {
  if (!cal) return;
  const name = ($('#table-name') as HTMLInputElement).value.trim() || 'My table';
  const p = profiles.create(name, engine.sampleRate, currentTilt(), cal.taps, profile?.knuckleTaps ?? []);
  p.motionOffset = motion.offsetLearned ? motion.offset : undefined;
  decideMethod(p); profiles.save(p); setTable(p);
  cal = null; enterPlay();
});
$('#redo-cal').addEventListener('click', () => startCalibration('full'));

// ---------- knuckle unlock: 2 knuckle taps on each colour ----------
const KN_PER = 2;
let knuckleCal: CalTap[] | null = null, knZone = 0;
function startKnuckle() {
  hideBanner(); knuckleCal = []; setKnZone(0);
  openOverlay('knuckle');
}
function setKnZone(z: number) {
  knZone = z;
  const c = $('#kn-color'); c.textContent = NAMES[z]; c.style.color = COLORS[z];
  renderDots('#kn-dots', KN_PER, 0, COLORS[z]);
  setMode({ kind: 'calibrateKnuckle', zone: z });
}
async function onKnuckleTap(feat: number[], peak: number, rms: number, frame: number) {
  if (!knuckleCal || !profile) return;
  const now = performance.now(); if (now - lastCalAt < 250) return; lastCalAt = now;
  const kt: CalTap = { zone: knZone, feat, peak, rms }; knuckleCal.push(kt); withMotion(kt, frame);
  const n = knuckleCal.filter(t => t.zone === knZone).length;
  renderDots('#kn-dots', KN_PER, n, COLORS[knZone]);
  fx.burst(innerWidth / 2, innerHeight * 0.4, COLORS[knZone], 0.7, true);
  if (n < KN_PER) return;
  if (knZone < 3) { setMode({ kind: 'idle' }); setTimeout(() => setKnZone(knZone + 1), 300); return; }
  const kn = knuckleCal; knuckleCal = null;
  await Promise.all(pendingMotion.splice(0));
  attachMotion(kn);
  profile.knuckleTaps = kn; decideMethod(profile);
  profiles.save(profile); setTable(profile);
  closeOverlay('knuckle'); setMode(playMode()); renderPads();
  toast('Knuckle sounds unlocked: 8 sounds now');
}
$('#kn-cancel').addEventListener('click', () => { knuckleCal = null; closeOverlay('knuckle'); setMode(playMode()); });

// ---------- play ----------
let playTaps = 0, playSince = 0, unsureTimes: number[] = [], wasLifted = false, tiltUnsub: (() => void) | null = null;
function enterPlay() {
  show('play'); renderPads(); renderChips();
  if (!store.get('benchpress.areaHint', false)) { store.set('benchpress.areaHint', true); toast('Tap on the sides you calibrated', 4000); }
  setMode(playMode());
  playTaps = 0; playSince = performance.now(); baselineTilt = currentTilt();
  tiltUnsub?.();
  tiltUnsub = onTilt(t => {
    if (screen !== 'play') return;
    if (!isFlat(t, 25)) { wasLifted = true; return; }
    if (wasLifted && baselineTilt && isFlat(t) && tiltDelta(t, baselineTilt) > 3) {
      wasLifted = false; baselineTilt = t;
      showBanner('Phone moved? Re-tune in 8 seconds.', 'Re-tune', () => startCalibration('quick'));
    } else if (wasLifted && isFlat(t)) wasLifted = false;
  });
}
function renderPads() {
  const p = packById(prefs.pack), kn = !!profile?.knuckleTaps.length;
  $$('.pad').forEach(el => {
    const z = +el.dataset.z!;
    el.querySelector('.pf')!.textContent = p.finger[z];
    el.querySelector('.pk')!.textContent = kn ? `✊ ${p.knuckle[z]}` : '';
  });
}
function renderChips() {
  const box = $('#instruments'); box.innerHTML = '';
  for (const p of PACKS) {
    const b = document.createElement('button'); b.className = 'chip' + (p.id === prefs.pack ? ' on' : '');
    b.textContent = p.name; b.title = p.blurb;
    b.onclick = () => { if (p.id === prefs.pack) return; b.textContent = '…'; setTimeout(() => { selectPack(p.id); toast(p.drone ? `${p.name} + tanpura drone` : p.name); }, 20); };
    box.appendChild(b);
  }
}
function padCenter(z: number) { const r = document.querySelector(`.pad[data-z="${z}"]`)!.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function flashPad(z: number, vel: number, kn: boolean) {
  const el = document.querySelector(`.pad[data-z="${z}"]`) as HTMLElement;
  el.classList.add('hit'); el.style.transform = `translate(-50%,-50%) scale(${1 + 0.14 * vel})${kn ? ' rotate(5deg)' : ''}`;
  setTimeout(() => { el.classList.remove('hit'); el.style.transform = ''; }, 90);
  const [x, y] = padCenter(z); fx.burst(x, y, COLORS[z], vel, kn);
}
function onPlayTap(zone: number, knuckle: boolean, vel: number) {
  if (screen === 'first') return onFirstTap(vel);
  if (screen !== 'play' || zone < 0) return;
  flashPad(zone, vel, knuckle);
  playTaps++;
  if (profile && !profile.knuckleTaps.length && playTaps === 24 && performance.now() - playSince > 15000)
    showBanner('New: knock with a knuckle for 4 more sounds.', 'Try it', startKnuckle);
}
/** Sides with motion: wait for the motion readings around the tap, decide the side, then play. */
async function onHeard(feat: number[], peak: number, frame: number) {
  if (screen !== 'play' || !mainCls) return;
  const tapAt = engine.frameToPerf(frame);
  const mf = sideCls ? await motion.featuresAfter(tapAt) : null;
  const base = mainCls.classify(feat, peak, { zone: 0, knuckle: false, velocity: 0, confidence: 0 });
  const side = sideCls?.classify(feat, mf);
  const zone = side ? (side.confidence < 0.5 ? -1 : side.zone) : base.zone; // unclear → play nothing
  if (zone < 0) { if (debugLog.length < 2000 && location.search.includes('debug')) debugLog.push({ type: 'unsure', frame, at: Math.round(performance.now()) }); return onUnsure(); }
  engine.play(zone * 2 + (base.knuckle ? 1 : 0), base.velocity, frame);
  if (debugLog.length < 2000 && location.search.includes('debug')) debugLog.push({ type: 'tap', zone, knuckle: base.knuckle, velocity: base.velocity, confidence: side?.confidence ?? base.confidence, frame, via: sideCls?.method, at: Math.round(performance.now()) });
  onPlayTap(zone, base.knuckle, base.velocity);
}
function onUnsure() {
  if (screen !== 'play') return;
  fx.doubt(innerWidth / 2, innerHeight * 0.45);
  const now = performance.now(); unsureTimes = unsureTimes.filter(t => now - t < 10000); unsureTimes.push(now);
  if (unsureTimes.length >= 4) { unsureTimes = []; showBanner('Not sure where that was. Tap closer to your spots, or re-tune.', 'Re-tune', () => startCalibration('quick')); }
}
$$('.pad').forEach(el => el.addEventListener('pointerdown', e => {
  // touching the screen also plays: handy on laptops and for showing people the sounds
  const z = +el.dataset.z!, kn = !!profile?.knuckleTaps.length && (e.shiftKey || e.button === 2);
  engine.preview(z * 2 + (kn ? 1 : 0), 0.8); flashPad(z, 0.8, kn);
}));

// banner
let bannerFn: (() => void) | null = null;
function showBanner(text: string, action: string, fn: () => void) {
  $('#banner-text').textContent = text; $('#banner-action').textContent = action; bannerFn = fn; $('#banner').classList.remove('hidden');
}
function hideBanner() { $('#banner').classList.add('hidden'); bannerFn = null; }
$('#banner-action').addEventListener('click', () => { const f = bannerFn; hideBanner(); f?.(); });
$('#banner-close').addEventListener('click', hideBanner);

// loop
$('#loop-btn').addEventListener('click', () => engine.loop('toggle'));
$('#loop-clear').addEventListener('click', () => engine.loop('clear'));
function renderLoop(phase: string, layers: number) {
  const b = $('#loop-btn'), t = $('#loop-text');
  b.classList.toggle('recording', phase === 'recording' || phase === 'overdub');
  b.classList.toggle('playing', phase === 'playing' || phase === 'overdub');
  t.textContent = phase === 'empty' ? 'Loop: tap ● to record'
    : phase === 'recording' ? 'Recording… tap ● to close the loop'
    : phase === 'overdub' ? `Adding layer ${layers}… tap ● to stop`
    : `Looping · ${layers} layer${layers > 1 ? 's' : ''}. ● adds a layer`;
}

// ---------- settings ----------
const sens = $('#sens') as HTMLInputElement, hp = $('#headphones') as HTMLInputElement;
sens.value = String(prefs.sensitivity); hp.checked = prefs.headphones;
sens.addEventListener('input', () => { prefs.sensitivity = +sens.value; savePrefs(); applyConfig(); });
hp.addEventListener('change', () => { prefs.headphones = hp.checked; savePrefs(); engine.setHeadphones(hp.checked); });
$('#latency-test').addEventListener('click', async () => {
  $('#latency-val').textContent = '…'; setMode({ kind: 'idle' }); engine.latencyTest();
  const r = await once('latency', 1500); if (r?.ms != null) latencyMs = r.ms;
  setMode(playMode()); renderLatency();
});
function renderLatency() {
  const v = $('#latency-val');
  if (latencyMs == null) { v.textContent = 'not measured'; return; }
  const total = Math.round(latencyMs + DEFAULT_CONFIG.postMs);
  v.textContent = `${total} ms ${total < 45 ? '· great' : total < 80 ? '· ok' : '· slow (Bluetooth?)'}`;
}
$('#retune').addEventListener('click', () => { closeOverlay('settings'); if (profile) startCalibration('quick'); else startCalibration('full'); });
$('#recalibrate').addEventListener('click', () => { closeOverlay('settings'); startCalibration('full'); });
$('#reknuckle').addEventListener('click', () => { closeOverlay('settings'); if (profile) startKnuckle(); });
function renderSettings() {
  renderLatency();
  const list = $('#settings-tables'); list.innerHTML = '';
  for (const t of profiles.all()) {
    const current = t.id === profile?.id;
    list.appendChild(tableItem(t, current ? [['In use', () => {}, true]] : [
      ['Use', () => { closeOverlay('settings'); useProfile(t); }],
      ['Delete', () => { profiles.remove(t.id); renderSettings(); }, true],
    ]));
  }
  if (!list.children.length) list.innerHTML = '<p class="fine">No saved tables yet.</p>';
  const s = engine.micSettings;
  $('#debug').textContent = [
    `version: ${__APP_VERSION__} · sample rate: ${engine.sampleRate} Hz · dsp v${DSP_VERSION}`,
    `mic: ${s ? `echoCancel=${s.echoCancellation} noiseSupp=${s.noiseSuppression} autoGain=${s.autoGainControl} ch=${s.channelCount}` : '—'}`,
    `output latency: ${engine.ctx ? `base ${Math.round((engine.ctx.baseLatency || 0) * 1000)} ms, out ${Math.round(((engine.ctx as any).outputLatency || 0) * 1000)} ms` : '—'}`,
    `round trip: ${latencyMs == null ? '—' : Math.round(latencyMs) + ' ms'}`,
    `table: ${profile ? `${profile.name}, ${profile.zoneTaps.length} taps, ${Math.round(profile.quality * 100)}%` : '—'}`,
    `tap floor: ${config().minLevel.toFixed(4)} (typical tap ${(profile && typicalTapRms(profile.zoneTaps))?.toFixed(4) ?? '—'})`,
    `engine: ${lastStats ? `onsets ${lastStats.onsets}, echoes ignored ${lastStats.echoesRejected}, too quiet ${lastStats.tooQuiet}, echo delay ${lastStats.echoDelayMs == null ? '?' : Math.round(lastStats.echoDelayMs) + ' ms' + (lastStats.echoLearned ? ' (learned)' : '')}, speaker ${lastStats.quietSpeaker ? 'not heard' : 'heard'}, leak ${lastStats.leak.toFixed(2)}, noise ${lastStats.noise.toFixed(4)}, floor ${lastStats.minLevel.toFixed(4)}` : '—'}`,
    `motion: ${Math.round(motion.rate)} readings/s, clock shift ${motion.offsetLearned ? motion.offset + ' ms' : 'not learned'} · table method: ${profile?.method ?? '—'} ${profile?.scores ? JSON.stringify(Object.fromEntries(Object.entries(profile.scores).map(([k, v]) => [k, Math.round(v * 100)]))) : ''}`,
    `tilt: ${JSON.stringify(currentTilt())}`, `iOS: ${isIOS} · UA: ${navigator.userAgent}`,
  ].join('\n');
}
$('#open-settings').addEventListener('click', () => openOverlay('settings'));

// ---------- see your taps ----------
let inspector: Inspector | null = null;
$('#open-inspect').addEventListener('click', () => {
  closeOverlay('settings'); openOverlay('inspect');
  inspector ??= new Inspector($('#inspect-map') as HTMLCanvasElement, $('#inspect-bars') as HTMLCanvasElement, $('#inspect-readout'));
  requestAnimationFrame(() => inspector!.setCalibration(profile?.zoneTaps ?? [], profile?.knuckleTaps ?? []));
  setMode({ kind: 'inspect' });
});
$('#inspect-clear').addEventListener('click', () => inspector?.setCalibration(profile?.zoneTaps ?? [], profile?.knuckleTaps ?? []));
listeners.push(m => {
  if (m.type !== 'inspect' || !inspector || $('#inspect').classList.contains('hidden')) return;
  inspector.addTap({ feat: m.feat, zone: m.zone, knuckle: m.knuckle, confidence: m.confidence, dist: m.dist, micDb: m.micDb, gyro: inspector.gyroAround(DEFAULT_CONFIG.postMs + 40) });
  if (m.zone >= 0) { const [x, y] = [innerWidth / 2, 60]; fx.burst(x, y, COLORS[m.zone], 0.5, m.knuckle); }
});
// closing the inspector returns to normal play
new MutationObserver(() => { if ($('#inspect').classList.contains('hidden') && screen === 'play') setMode(playMode()); })
  .observe($('#inspect'), { attributes: true, attributeFilter: ['class'] });

// ---------- guided recording for analysis ----------
const REC_GROUPS: { zone: number; knuckle: boolean }[] = [0, 1, 2, 3].map(z => ({ zone: z, knuckle: false })).concat([{ zone: 0, knuckle: true }]);
const REC_PER = 10;
let rec: { recorder: Recorder; group: number; n: number; lastAt: number; busy: boolean } | null = null;
$('#open-recorder').addEventListener('click', () => {
  closeOverlay('settings'); openOverlay('recorder');
  $('#rec-title').textContent = 'Record your taps';
  $('#rec-sub').textContent = '10 taps on each spot, then 10 knuckle knocks on blue. Use the same spots you calibrated. The phone stays on the table.';
  $('#rec-start').classList.remove('hidden'); $('#rec-save').classList.add('hidden'); $('#rec-info').classList.add('hidden'); $('#rec-dots').innerHTML = '';
});
$('#rec-cancel').addEventListener('click', async () => { if (rec) { await rec.recorder.finish(); rec = null; } closeOverlay('recorder'); setMode({ kind: screen === 'play' ? 'play' : 'idle' }); });
$('#rec-start').addEventListener('click', async () => {
  $('#rec-start').classList.add('hidden');
  setMode({ kind: 'idle' }); engine.loop('clear');
  rec = { recorder: new Recorder(), group: 0, n: 0, lastAt: 0, busy: true };
  rec.recorder.start();
  await recPause('Hands off the table…', 2000);
  recGroup(0);
});
function recPause(text: string, ms: number) {
  if (rec) rec.busy = true;
  setMode({ kind: 'idle' }); $('#rec-title').textContent = text; $('#rec-sub').textContent = 'Recording silence between spots helps me split your taps.';
  return new Promise(r => setTimeout(r, ms));
}
function recGroup(g: number) {
  if (!rec) return;
  const G = REC_GROUPS[g]; rec.group = g; rec.n = 0; rec.busy = false;
  $('#rec-title').innerHTML = `${G.knuckle ? 'Knock' : 'Tap'} <span style="color:${COLORS[G.zone]}">${NAMES[G.zone]}</span> ${REC_PER} times${G.knuckle ? ' with a knuckle' : ''}.`;
  $('#rec-sub').textContent = `Spot ${g + 1} of ${REC_GROUPS.length}. Mix soft and firm taps, like you'd play.`;
  renderDots('#rec-dots', REC_PER, 0, COLORS[G.zone]);
  setMode({ kind: 'calibrate', zone: G.zone }); // silent; we only count taps here
}
listeners.push(async m => {
  if (m.type === 'level' && rec) $('#rec-meter').style.width = `${meterPos(m.rms) * 100}%`;
  if (m.type !== 'calTap' || !rec || rec.busy) return;
  const now = performance.now(); if (now - rec.lastAt < 200) return; rec.lastAt = now;
  rec.n++; renderDots('#rec-dots', REC_PER, rec.n, COLORS[REC_GROUPS[rec.group].zone]);
  if (rec.n < REC_PER) return;
  if (rec.group < REC_GROUPS.length - 1) { await recPause('Stop. Hands off…', 2500); recGroup(rec.group + 1); return; }
  await recPause('Done. Saving…', 1500);
  const r = await rec.recorder.finish(); rec = null;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const a = $('#rec-save') as HTMLAnchorElement;
  a.href = URL.createObjectURL(r.blob); a.download = `benchpress-taps-${stamp}.wav`; a.classList.remove('hidden');
  $('#rec-title').textContent = 'Recorded.';
  $('#rec-sub').textContent = 'Save it, then send the file to Claude in the chat.';
  const info = $('#rec-info'); info.classList.remove('hidden');
  info.textContent = `${r.seconds.toFixed(0)} s · ${(engine.micSettings?.channelCount ?? 1) >= 2 ? '2 microphones' : '1 microphone'} · ${engine.sampleRate} Hz · ${(r.blob.size / 1e6).toFixed(1)} MB · order: blue, pink, yellow, green, knuckle on blue`;
  setMode({ kind: screen === 'play' ? 'play' : 'idle' });
});

// keep audio alive across tab switches
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') engine.ctx?.resume(); });

boot();
