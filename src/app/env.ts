// Environment detection and small browser helpers. Every API here is optional: fail soft.

const ua = navigator.userAgent;

export const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMobile = isIOS || isAndroid || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820);
/** In-app browsers (Instagram, Facebook, Snapchat, LinkedIn, Line...) often block or break the mic. */
export const inAppBrowser = /Instagram|FBAN|FBAV|FB_IAB|Snapchat|LinkedInApp|Line\/|MicroMessenger|; wv\)/i.test(ua);
export const micSupported = !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
export const secure = window.isSecureContext;

// ---------- screen wake lock (keeps the phone listening while it lies on the table) ----------
let lock: { release(): Promise<void> } | null = null;
let wantLock = false;
export async function keepAwake(on: boolean) {
  wantLock = on;
  try {
    if (on && !lock && 'wakeLock' in navigator) {
      lock = await (navigator as any).wakeLock.request('screen');
      (lock as any).addEventListener?.('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* not allowed right now (e.g. low battery); harmless */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantLock) keepAwake(true); });

// ---------- orientation (flat check + "phone moved") ----------
export interface Tilt { beta: number; gamma: number }
let tilt: Tilt | null = null;
let listening = false;
const tiltListeners = new Set<(t: Tilt) => void>();
function onOrient(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  tilt = { beta: e.beta, gamma: e.gamma };
  tiltListeners.forEach(l => l(tilt!));
}
export const needsOrientationPermission = typeof (window as any).DeviceOrientationEvent?.requestPermission === 'function';
export async function startOrientation(): Promise<boolean> {
  try {
    if (needsOrientationPermission) {
      const r = await (window as any).DeviceOrientationEvent.requestPermission();
      try { await (window as any).DeviceMotionEvent?.requestPermission?.(); } catch { /* motion is optional */ }
      if (r !== 'granted') return false;
    }
    if (!listening) { window.addEventListener('deviceorientation', onOrient); listening = true; }
    return true;
  } catch { return false; }
}
export const currentTilt = () => tilt;
export function onTilt(l: (t: Tilt) => void) { tiltListeners.add(l); return () => tiltListeners.delete(l); }
export const isFlat = (t: Tilt | null, tol = 12) => !!t && Math.abs(t.beta) < tol && Math.abs(t.gamma) < tol;
export const tiltDelta = (a: Tilt, b: Tilt) => Math.hypot(a.beta - b.beta, a.gamma - b.gamma);

// ---------- storage that never throws ----------
export const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  },
  set(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ } },
};
