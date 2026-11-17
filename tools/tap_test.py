"""
Week-1 feasibility test: can a phone mic tell table tap zones apart?

HOW TO RECORD
1. Phone flat on a hard table, no case. Mark zones (e.g. L, R, T, B) ~15-20 cm away.
2. Start ONE recording (WAV, 48 kHz if your recorder allows; m4a also works).
3. Tap zone 1 N times (~0.5 s apart), PAUSE 3 s, tap zone 2 N times, pause, ... in the
   same order you pass to --zones. Keep the same tap style (fingertip / nail / pen).
4. Copy the file to your PC and run:

   pip install numpy scipy librosa scikit-learn matplotlib
   python tap_test.py taps.wav --zones L R T B --taps 25
   python tap_test.py taps.wav --zones L R T B --taps 25 --post-ms 10   # test shorter window = less lag

OUTPUT
- detected taps per group (check they match what you did)
- cross-validated accuracy for kNN and logistic regression
- "calibration test": train on first 10 taps per zone, test on the rest (realistic app case)
- confusion matrix
- tap_onsets.png  (check every tap was detected, no false hits)
- tap_spectra.png (average spectrum per zone - visible differences = good sign)
- tap_features.csv
"""
import argparse
import sys

import numpy as np
import librosa
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.signal import butter, sosfilt
from sklearn.neighbors import KNeighborsClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.metrics import confusion_matrix, accuracy_score

PRE_MS, POST_MS = 2, 25          # feature window around each onset
REFRACTORY_MS = 80               # ignore re-triggers within this time
N_BANDS = 40


def detect_onsets(x, sr, k):
    """Energy-envelope onset detector on a high-passed signal (removes hum/rumble)."""
    sos = butter(4, 40, "highpass", fs=sr, output="sos")
    y = sosfilt(sos, x)
    hop = max(1, int(sr * 0.001))                      # 1 ms frames
    n = len(y) // hop
    env = np.sqrt(np.mean(y[: n * hop].reshape(n, hop) ** 2, axis=1))
    med = np.median(env)
    mad = np.median(np.abs(env - med)) + 1e-12
    thr = med + k * mad
    onsets, last = [], -10**9
    for i in range(1, n):
        if env[i] > thr and env[i - 1] <= thr and (i - last) * 1000 * hop / sr > REFRACTORY_MS:
            onsets.append(i * hop)
            last = i
    return np.array(onsets, dtype=int), env, thr, hop


def group_by_gaps(onsets, sr, gap_s):
    groups, cur = [], [onsets[0]]
    for a, b in zip(onsets[:-1], onsets[1:]):
        if (b - a) / sr > gap_s:
            groups.append(cur)
            cur = []
        cur.append(b)
    groups.append(cur)
    return groups


def features(chans, sr, onset):
    a = onset - int(sr * PRE_MS / 1000)
    b = onset + int(sr * POST_MS / 1000)
    edges = np.geomspace(60, min(20000, sr / 2 - 1), N_BANDS + 1)
    feats, peaks = [], []
    for ch in chans:
        seg = ch[max(0, a):b]
        seg = np.pad(seg, (0, max(0, (b - a) - len(seg))))
        win = seg * np.hanning(len(seg))
        spec = np.abs(np.fft.rfft(win, n=4096)) ** 2
        freqs = np.fft.rfftfreq(4096, 1 / sr)
        bands = np.array([spec[(freqs >= lo) & (freqs < hi)].sum() for lo, hi in zip(edges[:-1], edges[1:])])
        bands = np.log(bands / (bands.sum() + 1e-20) + 1e-12)   # shape only, loudness-independent
        env = np.abs(seg)
        peak = env.max() + 1e-12
        decay = np.argmax(env < peak * 0.1 * (np.arange(len(env)) > np.argmax(env))) / sr * 1000
        centroid = (freqs * spec).sum() / (spec.sum() + 1e-20)
        feats.extend(bands)
        feats.extend([decay, centroid / 1000])
        peaks.append(peak)
    if len(chans) == 2:   # stereo bonus: level difference + time lag between mics
        s0 = chans[0][max(0, a):b]
        s1 = chans[1][max(0, a):b]
        cc = np.correlate(s0, s1, "full")
        lag = (np.argmax(cc) - (len(s1) - 1)) / sr * 1e6       # microseconds
        feats.extend([20 * np.log10(peaks[0] / peaks[1]), lag])
    return np.array(feats), max(peaks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--zones", nargs="+", required=True, help="zone names in the order you tapped them")
    ap.add_argument("--taps", type=int, default=25, help="taps per zone (for sanity check)")
    ap.add_argument("--gap", type=float, default=1.5, help="pause (s) that separates zone groups")
    ap.add_argument("--k", type=float, default=12, help="onset threshold (higher = fewer detections)")
    ap.add_argument("--post-ms", type=float, default=15, help="feature window after onset in ms (shorter = less lag); try 5, 10, 15, 25")
    ap.add_argument("--calib", type=int, default=10, help="taps per zone used as 'calibration' in realistic test")
    args = ap.parse_args()
    global POST_MS
    POST_MS = args.post_ms

    x, sr = librosa.load(args.audio, sr=None, mono=False)
    chans = [x] if x.ndim == 1 else [c for c in x]
    mono = np.mean(chans, axis=0)
    print(f"Loaded {args.audio}: {sr} Hz, {len(chans)} channel(s), {len(mono)/sr:.1f} s")
    if sr < 44100:
        print("WARNING: sample rate below 44.1 kHz - record at 48 kHz if possible.")

    onsets, env, thr, hop = detect_onsets(mono, sr, args.k)
    if len(onsets) == 0:
        sys.exit("No taps detected. Lower --k.")
    groups = group_by_gaps(onsets, sr, args.gap)

    print(f"\nDetected {len(onsets)} taps in {len(groups)} groups: {[len(g) for g in groups]}")
    if len(groups) != len(args.zones):
        print(f"ERROR: expected {len(args.zones)} groups (one per zone). "
              "Adjust --gap (pause length) or --k (threshold), and check tap_onsets.png.")
        plot_onsets(env, thr, hop, sr, onsets)
        sys.exit(1)
    for z, g in zip(args.zones, groups):
        if abs(len(g) - args.taps) > 2:
            print(f"  note: zone {z} has {len(g)} taps (expected ~{args.taps}) - check tap_onsets.png")

    X, y, vel = [], [], []
    for z, g in zip(args.zones, groups):
        for o in g:
            f, p = features(chans, sr, o)
            X.append(f); y.append(z); vel.append(p)
    X, y = np.array(X), np.array(y)

    models = {
        "kNN (k=3)": make_pipeline(StandardScaler(), KNeighborsClassifier(3)),
        "LogReg": make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=0.5)),
    }
    min_class = min(np.sum(y == z) for z in args.zones)
    folds = max(2, min(5, min_class))
    print(f"\n== Cross-validated accuracy ({folds}-fold) ==")
    for name, m in models.items():
        s = cross_val_score(m, X, y, cv=StratifiedKFold(folds, shuffle=True, random_state=0))
        print(f"  {name:10s} {s.mean()*100:5.1f}%  (+/- {s.std()*100:.1f})")

    # realistic: first N taps per zone = calibration, rest = live play
    tr = np.zeros(len(y), bool)
    for z in args.zones:
        tr[np.where(y == z)[0][: args.calib]] = True
    if (~tr).sum() > 0:
        print(f"\n== Calibration test: train on first {args.calib}/zone, test on the rest ==")
        for name, m in models.items():
            m.fit(X[tr], y[tr])
            pred = m.predict(X[~tr])
            print(f"  {name:10s} {accuracy_score(y[~tr], pred)*100:5.1f}%")
        best = models["kNN (k=3)"]
        best.fit(X[tr], y[tr])
        cm = confusion_matrix(y[~tr], best.predict(X[~tr]), labels=args.zones)
        print("\n  kNN confusion (rows = true, cols = predicted):")
        print("        " + "  ".join(f"{z:>4s}" for z in args.zones))
        for z, row in zip(args.zones, cm):
            print(f"  {z:>4s}  " + "  ".join(f"{v:4d}" for v in row))

    vel = np.array(vel)
    print(f"\nTap strength range: {vel.min():.4f} - {vel.max():.4f} "
          f"(ratio {vel.max()/vel.min():.1f}x - usable for velocity if >3x when you vary force)")

    print("\nVERDICT GUIDE: >=90% calibration test = go for this many zones. "
          "75-90% = try nail/pen taps or fewer zones. <75% = rethink setup.")

    plot_onsets(env, thr, hop, sr, onsets)
    plot_spectra(X, y, args.zones, len(chans))
    np.savetxt("tap_features.csv", np.column_stack([y, X]), fmt="%s", delimiter=",")
    print("Saved tap_onsets.png, tap_spectra.png, tap_features.csv")


def plot_onsets(env, thr, hop, sr, onsets):
    t = np.arange(len(env)) * hop / sr
    plt.figure(figsize=(14, 3))
    plt.plot(t, env, lw=0.6)
    plt.axhline(thr, color="r", ls="--", lw=0.8, label="threshold")
    plt.plot(onsets / sr, np.full(len(onsets), thr), "rv", ms=5, label="detected taps")
    plt.xlabel("time (s)"); plt.legend(); plt.tight_layout()
    plt.savefig("tap_onsets.png", dpi=120); plt.close()


def plot_spectra(X, y, zones, nch):
    plt.figure(figsize=(9, 4))
    for z in zones:
        plt.plot(X[y == z][:, :N_BANDS].mean(axis=0), label=z)
    plt.xlabel("frequency band (low -> high)"); plt.ylabel("relative log energy")
    plt.title("Average tap spectrum per zone (ch 1)"); plt.legend(); plt.tight_layout()
    plt.savefig("tap_spectra.png", dpi=120); plt.close()


if __name__ == "__main__":
    main()
