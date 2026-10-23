"""4.4 Маска солдата (без тіні) + деконтамінація кольору країв.

α = max(α_ai, α_diff) у смузі розширеної α_ai, поза нею 0;
guided filter по кадру; F = (I − (1 − α)·B_i) / α.
"""
from __future__ import annotations

import cv2
import numpy as np

from .common import Ctx, frame_path, log, read_gray16, read_rgb, write_gray16, write_rgb


def shadow_like(I: np.ndarray, B: np.ndarray, k_min: float, tol: float) -> np.ndarray:
    """Чисте затемнення фону: I ≈ k·B, k ∈ [k_min, 1], хроматичність збережена."""
    sI = I.sum(-1) + 1e-3
    sB = B.sum(-1) + 1e-3
    k = sI / sB
    chroma = np.abs(I / sI[..., None] - B / sB[..., None]).max(-1)
    return (k >= k_min) & (k <= 1.0 + 0.02) & (chroma < tol)


def matte_frame(I8: np.ndarray, Bi: np.ndarray, a_ai: np.ndarray, cfg: dict, px: float):
    I = I8.astype(np.float32)
    # Лише затемнення і зміна кольору: у відео за силуетом є світла кайма
    # (I > B на 5–10 рівнів, шарпенінг), її не можна вважати солдатом.
    sI = I.sum(-1, keepdims=True) + 1e-3
    sB = Bi.sum(-1, keepdims=True) + 1e-3
    d_dark = np.clip(Bi - I, 0, None).max(-1)
    d_chroma = np.abs(I / sI - Bi / sB).max(-1) * Bi.mean(-1) * 3
    d = np.maximum(d_dark, d_chroma)
    t0, t1 = cfg["t0"], cfg["t1"]
    a_diff = np.clip((d - t0) / (t1 - t0), 0, 1)
    a_diff[shadow_like(I, Bi, cfg["shadow_k_min"], cfg["shadow_chroma_tol"])] = 0

    r = max(1, int(round(cfg["ai_dilate_px"] * px)))
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    band = cv2.dilate((a_ai > 0.02).astype(np.uint8), ker) > 0
    a = np.where(band, np.maximum(a_ai, a_diff), 0).astype(np.float32)

    gr = max(1, int(round(cfg["guided_radius"] * px)))
    # Гайд — 8-бітний кадр: з 3-канальним float-гайдом OpenCV guidedFilter
    # вироджується в box-фільтр і розмазує край на ~4r px (світлий ореол).
    a = cv2.ximgproc.guidedFilter(I8, a, gr, cfg["guided_eps"] * 255.0 ** 2)
    a = np.clip(a, 0, 1)
    a[a < 1e-3] = 0

    choke = cfg.get("choke_px", 0) * px
    if choke > 0:
        # Субпіксельна ерозія: зсув альфи вниз на величину нахилу.
        er = cv2.erode(a, np.ones((3, 3), np.uint8))
        a = a + (er - a) * min(choke, 1.0)

    amin = cfg["decontam_min_alpha"]
    Fg = I.copy()
    m = a > amin
    Fg[m] = (I[m] - (1 - a[m, None]) * Bi[m]) / a[m, None]
    Fg = np.clip(Fg, 0, 255)

    # Обмеження кольору краю кольором найближчих внутрішніх пікселів:
    # світла кайма з відео після ділення на α дає майже білий F.
    inner = (a > 0.95).astype(np.float32)
    Fp = np.zeros_like(I)
    wsum = np.zeros(I.shape[:2], np.float32)
    for sig in (1.5, 4.0, 10.0):  # дрібний масштаб має пріоритет
        s = sig * px
        w = cv2.GaussianBlur(inner, (0, 0), s)
        f = cv2.GaussianBlur(I * inner[..., None], (0, 0), s) / np.maximum(w, 1e-4)[..., None]
        take = (wsum < 0.05) & (w > 0.02)
        Fp[take] = f[take]
        wsum = np.where(take, 1.0, wsum)
    edge = m & (a < 0.95) & (wsum > 0)
    tol = cfg["edge_color_tol"]
    Fg[edge] = np.minimum(Fg[edge], Fp[edge] + tol)
    lo = cfg["edge_blend_alpha"]  # низька α — колір переважно з внутрішніх пікселів
    t = np.clip(a / lo, 0, 1)[..., None]
    Fg = np.where(edge[..., None], Fp * (1 - t) + Fg * t, Fg)
    return a, Fg


def step(ctx: Ctx):
    cfg = ctx.cfg["matte"]
    n = ctx.frame_count()
    B = np.load(ctx.tmp / "plate.npy")
    gains = np.load(ctx.tmp / "gains.npy")
    out_a = ctx.dir("alpha")
    out_f = ctx.dir("fg")
    stats = []
    for i in range(n):
        I8 = read_rgb(frame_path(ctx, i))
        a_ai = read_gray16(ctx.tmp / "alpha_ai" / f"{i:03d}.png")
        a, Fg = matte_frame(I8, B * gains[i], a_ai, cfg, ctx.px)
        write_gray16(out_a / f"{i:03d}.png", a)
        write_rgb(out_f / f"{i:03d}.png", (Fg + 0.5).astype(np.uint8))
        hard = a > 0.5
        ys, xs = np.nonzero(hard)
        stats.append({
            "i": i, "x0": int(xs.min()), "x1": int(xs.max()), "y0": int(ys.min()), "y1": int(ys.max()),
            "added_px": int(((a > 0.5) & (a_ai <= 0.5)).sum()),
        })
        if i % 25 == 0:
            log(f"кадр {i}: bbox x {stats[-1]['x0']}–{stats[-1]['x1']}, y {stats[-1]['y0']}–{stats[-1]['y1']}")
    xs0 = min(s["x0"] for s in stats); xs1 = max(s["x1"] for s in stats)
    ys0 = min(s["y0"] for s in stats); ys1 = max(s["y1"] for s in stats)
    log(f"солдат по всіх кадрах: x {xs0}–{xs1}, y {ys0}–{ys1}")
    ctx.save_state(matte={"bbox_all": [xs0, ys0, xs1, ys1], "frame0": stats[0]})
