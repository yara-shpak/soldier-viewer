"""4.6 Таблиця «кадр → кут» + точка опори (anchor) для 4.7.

1. Ширина силуету w(i) по α > 0.5 → ключові кадри 90/180/270 (субкадрово).
2. Кінець петлі K ∈ [loop_search_from, last] — найближчий до кадру 0.
3. Усередині сегментів кут ∝ накопиченому |flow_x| (Farneback) у масці.
"""
from __future__ import annotations

import cv2
import numpy as np

from .common import Ctx, dump_json, frame_path, log, read_gray16


def largest_component(mask: np.ndarray) -> np.ndarray:
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    return lab == k


def parabolic(y: np.ndarray, i: int) -> float:
    if i <= 0 or i >= len(y) - 1:
        return float(i)
    a, b, c = y[i - 1], y[i], y[i + 1]
    den = a - 2 * b + c
    if abs(den) < 1e-9:
        return float(i)
    return float(i + np.clip(0.5 * (a - c) / den, -0.5, 0.5))


def flow_x(g0: np.ndarray, g1: np.ndarray, mask: np.ndarray) -> tuple[float, float]:
    f = cv2.calcOpticalFlowFarneback(g0, g1, None, 0.5, 4, 21, 3, 7, 1.5, 0)
    fx = f[..., 0][mask]
    return float(np.abs(fx).mean()), float(fx.mean())


def step(ctx: Ctx):
    cfg = ctx.cfg["angles"]
    n = ctx.frame_count()
    W, H = ctx.W, ctx.H

    hard, widths, centers, gray = [], [], [], []
    for i in range(n):
        a = read_gray16(ctx.tmp / "alpha" / f"{i:03d}.png")
        m = largest_component(a > 0.5)
        xs = np.nonzero(m.any(0))[0]
        hard.append(m)
        widths.append(float(xs[-1] - xs[0] + 1))
        centers.append(0.5 * (xs[0] + xs[-1]))
        gray.append(cv2.cvtColor(cv2.imread(str(frame_path(ctx, i))), cv2.COLOR_BGR2GRAY))
    w = np.array(widths)

    # --- кінець петлі K ---
    lo = min(int(cfg["loop_search_from"] * n / 150), n - 2)
    cand = list(range(lo, n))
    f0 = cv2.imread(str(frame_path(ctx, 0))).astype(np.float32)
    l1, iou = [], []
    for i in cand:
        u = hard[0] | hard[i]
        fi = cv2.imread(str(frame_path(ctx, i))).astype(np.float32)
        l1.append(float(np.abs(fi - f0)[u].mean()))
        iou.append(float((hard[0] & hard[i]).sum() / u.sum()))
    l1, iou = np.array(l1), np.array(iou)
    norm = lambda v: (v - v.min()) / (np.ptp(v) + 1e-9)  # noqa: E731
    score = norm(l1) + norm(1 - iou)
    # Обертання зупиняється в кінці відео: кілька кадрів поспіль майже однакові
    # і всі «найближчі» до кадру 0 у межах шуму. Беремо початок цього плато,
    # щоб дублікати не потрапили в петлю.
    K = cand[int(np.nonzero(score <= score.min() + cfg["loop_plateau_tol"])[0][0])]
    plateau = [c for c, sc in zip(cand, score) if sc <= score.min() + cfg["loop_plateau_tol"]]
    log(f"кінець петлі K = {K} (L1 {l1[K - lo]:.2f}, IoU {iou[K - lo]:.4f}); кадрів у петлі: {K}")

    # --- ключові кадри за шириною силуету ---
    ws = cv2.GaussianBlur(w[: K + 1].reshape(1, -1).astype(np.float64), (0, 0), 1.0).ravel()
    win = max(4, K // 18)
    minima = [i for i in range(2, K - 1)
              if ws[i] == ws[max(0, i - win): i + win + 1].min()]
    if len(minima) < 2:
        raise SystemExit(f"Не знайдено двох мінімумів ширини силуету: {minima}")
    m1, m2 = sorted(sorted(minima, key=lambda i: ws[i])[:2])
    M = m1 + int(np.argmax(ws[m1:m2 + 1]))
    keys = [0.0, parabolic(ws, m1), parabolic(ws, M), parabolic(ws, m2), float(K)]
    log("ключові кадри: " + ", ".join(f"{d}°→{k:.1f}" for d, k in zip((0, 90, 180, 270, 360), keys)))

    # --- оптичний потік між сусідніми кадрами ---
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mags, signed = [], []
    for i in range(K):
        m = cv2.erode((hard[i] | hard[i + 1]).astype(np.uint8), ker) > 0
        mg, sg = flow_x(gray[i], gray[i + 1], m)
        mags.append(mg)
        signed.append(sg)
    mags = np.maximum(np.array(mags), 1e-4)  # строга монотонність
    C = np.concatenate([[0.0], np.cumsum(mags)])
    Ck = np.interp(keys, np.arange(K + 1), C)
    ang = np.empty(K + 1)
    for i in range(K + 1):
        s = min(int(np.searchsorted(keys, i, side="right")) - 1, 3)
        ang[i] = 90 * s + 90 * (C[i] - Ck[s]) / (Ck[s + 1] - Ck[s])
    assert np.all(np.diff(ang) > 0), "кути не монотонні"

    # стрибок на шві: потік K → 0 у градусах за швидкістю останнього сегмента
    m = cv2.erode((hard[K] | hard[0]).astype(np.uint8), ker) > 0
    seam_mag, _ = flow_x(gray[K], gray[0], m)
    deg_per_flow = 90.0 / (Ck[4] - Ck[3])
    seam_deg = seam_mag * deg_per_flow
    # те саме для кадру 149 (останнього) і кадру 7 — для звіту (п. 2.2)
    def deg_between(a_, b_):
        mm = cv2.erode((hard[a_] | hard[b_]).astype(np.uint8), ker) > 0
        return flow_x(gray[a_], gray[b_], mm)[0] * deg_per_flow
    last_vs_0 = deg_between(n - 1, 0)
    f7_vs_0 = deg_between(min(7, n - 1), 0)
    direction = "face-turns-to-screen-right" if np.mean(signed) > 0 else "face-turns-to-screen-left"
    log(f"стрибок на шві ≈ {seam_deg:.2f}°; напрям: {direction}")

    # --- anchor і headTopY ---
    near = lambda k: [i for i in range(n) if abs(i - k) <= 1.5]  # noqa: E731
    front = near(0) + near(K)
    back = near(keys[2])
    ax = 0.5 * (np.mean([centers[i] for i in front if i <= K]) + np.mean([centers[i] for i in back]))
    rows = hard[0].sum(1)
    ys = np.nonzero(rows >= max(3, int(3 * ctx.px)))[0]
    anchor_y = float(ys[-1])
    head_top = float(np.nonzero(hard[0].any(1))[0][0])
    log(f"anchor = ({ax:.1f}, {anchor_y:.1f}), headTopY = {head_top:.1f}")

    angles = ang[:K]
    data = {
        "frameCount": int(K),
        "anglesDeg": [round(float(x), 3) for x in angles],
        "keyframes": {str(d): round(k, 2) for d, k in zip((0, 90, 180, 270, 360), keys)},
        "seamJumpDeg": round(float(seam_deg), 2),
        "indexIncreases": direction,
    }
    dump_json(ctx.public / "angles.json", data)
    ctx.save_state(angles={
        "K": int(K), "keys": keys, "seam_deg": float(seam_deg),
        "last_vs_0_deg": float(last_vs_0), "f7_vs_0_deg": float(f7_vs_0),
        "direction": direction, "widths": w.tolist(), "angles_full": ang.tolist(),
        "flow_mag": mags.tolist(), "max_deg_per_frame_mid": float(np.diff(ang)[20:K - 20].max()),
        "loop_l1": l1.tolist(), "loop_iou": iou.tolist(), "loop_from": lo, "loop_plateau": plateau,
        "loop_best": cand[int(np.argmin(score))],
    }, anchor={"x": float(ax), "y": anchor_y, "headTopY": head_top})

    plot(ctx, ang, w, keys, K)


def plot(ctx: Ctx, ang, w, keys, K):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    i = np.arange(len(ang))
    fig, ax = plt.subplots(figsize=(11, 6), dpi=110)
    ax.plot(i, ang, color="#1f6feb", lw=2, label="θ(i) за таблицею (потік + ключові кадри)")
    ax.plot(i, i * 360.0 / 150.0, "--", color="#999", label="лінійне припущення: i × 2,4°")
    for d, k in zip((0, 90, 180, 270, 360), keys):
        ax.axhline(d, color="#ddd", lw=0.8, zorder=0)
        ax.plot([k], [d], "o", color="#d73a49")
        ax.annotate(f"{d}° @ {k:.1f}", (k, d), textcoords="offset points", xytext=(6, -14), fontsize=9)
    ax.set_xlabel("індекс кадру")
    ax.set_ylabel("кут, °")
    ax.set_yticks([0, 45, 90, 135, 180, 225, 270, 315, 360])
    ax.grid(alpha=0.25)
    ax2 = ax.twinx()
    ax2.plot(np.arange(len(w)), w, color="#2da44e", alpha=0.45, lw=1, label="ширина силуету, px")
    ax2.axvline(K, color="#2da44e", ls=":", lw=1)
    ax2.set_ylabel("ширина силуету, px", color="#2da44e")
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper left", fontsize=9)
    ax.set_title(f"Таблиця кутів: K = {K}, кадрів у петлі = {K}")
    fig.tight_layout()
    fig.savefig(ctx.qa / "angle_plot.png")
    plt.close(fig)
