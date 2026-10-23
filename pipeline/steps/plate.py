"""4.3 Чиста підкладка фону B (clean plate).

Виміряно на наданому відео: фон має покадрове мерехтіння експозиції
(≈ ±1,5%), тому B оцінюється на нормалізованих кадрах, а для кожного
кадру зберігається поканальний коефіцієнт g_i (B_i = g_i · B).

Вільні пікселі визначаються маскою rembg (розширеною), а не різницею
з медіаною: обертання сповільнюється біля фронту, тож фронтальний
силует присутній у більшості кадрів і «прилипає» до медіани.

B = 95-й перцентиль вільних значень (стійкий до тіні, яка рухається
разом із силуетом) мінус глобальний зсув перцентиля від шуму, виміряний
далеко від підлоги. Ядро (вільне в <10% кадрів) заповнюється inpaint +
gaussian blur.
"""
from __future__ import annotations

import warnings

import cv2
import numpy as np

from .common import Ctx, dump_json, load_frames, log, read_gray16


def masked_percentile(F: np.ndarray, free: np.ndarray, q: float, rows: int = 48) -> np.ndarray:
    """Попіксельний перцентиль по кадрах лише серед вільних значень."""
    n, h, w, c = F.shape
    out = np.full((h, w, c), np.nan, np.float32)
    for y in range(0, h, rows):
        blk = F[:, y:y + rows].astype(np.float32)
        m = free[:, y:y + rows, :, None]
        blk = np.where(m, blk, np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out[y:y + rows] = np.nanpercentile(blk, q, axis=0)
    return out


def step(ctx: Ctx):
    cfg = ctx.cfg["plate"]
    n = ctx.frame_count()
    F = load_frames(ctx)  # uint8 n,h,w,3
    h, w = F.shape[1:3]
    k = max(3, int(round(15 * ctx.px))) | 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    occ = np.zeros((n, h, w), bool)
    for i in range(n):
        a = read_gray16(ctx.tmp / "alpha_ai" / f"{i:03d}.png")
        occ[i] = cv2.dilate((a > 0.02).astype(np.uint8), ker) > 0
    free = ~occ
    never = free.all(0)
    log(f"завжди вільні пікселі: {never.mean() * 100:.1f}% кадру")

    # Покадрове мерехтіння експозиції: поканальний коефіцієнт відносно медіани.
    ref = np.median(F[:, never].astype(np.float32), axis=0)  # (pixels, 3)
    gains = np.empty((n, 3), np.float32)
    for i in range(n):
        gains[i] = np.median(F[i][never].astype(np.float32) / np.maximum(ref, 1), axis=0)
    log(f"мерехтіння експозиції: g ∈ [{gains.min():.4f}, {gains.max():.4f}]")
    Fn = F.astype(np.float32) / gains[:, None, None, :]

    p95 = masked_percentile(Fn, free, 95)
    p50 = masked_percentile(Fn, free, 50)
    nfree = free.sum(0)
    core = nfree < max(8, int(np.ceil((1 - cfg["covered_fraction"]) * n)))

    # Зсув 95-го перцентиля від шуму: міряємо на верхній половині кадру
    # (стіна, без тіні), віднімаємо всюди.
    upper = np.zeros((h, w), bool)
    upper[: h // 2] = True
    sel = upper & ~core & (nfree >= n // 2)
    bias = np.nanmedian((p95 - p50)[sel], axis=0)
    log(f"зсув p95 від шуму: {np.round(bias, 2).tolist()}")
    B = p95 - bias

    # Заповнення ядра: inpaint + gaussian blur по краю.
    hole = core | np.isnan(B).any(-1)
    log(f"ядро для заповнення: {hole.mean() * 100:.2f}% кадру")
    B = np.nan_to_num(B, nan=0.0)
    B16 = np.clip(B * 256, 0, 65535).astype(np.uint16)
    hole8 = cv2.dilate(hole.astype(np.uint8), ker)
    filled = np.stack([cv2.inpaint(B16[..., c], hole8, int(12 * ctx.px), cv2.INPAINT_TELEA)
                       for c in range(3)], -1).astype(np.float32) / 256
    s = 6 * ctx.px
    blurred = cv2.GaussianBlur(filled, (0, 0), s)
    B = np.where(hole8[..., None] > 0, blurred, B)
    # Ледь згладити, щоб прибрати залишковий шум оцінки.
    B = cv2.GaussianBlur(B, (0, 0), 1.0 * ctx.px).astype(np.float32)

    # Перевірка 4.3.3: середня |кадр − B_i| на заздалегідь вільних пікселях.
    errs = []
    for i in range(0, n, 5):
        Bi = B * gains[i]
        errs.append(np.abs(F[i].astype(np.float32) - Bi)[never].mean())
    err = float(np.mean(errs))
    log(f"похибка B на вільних пікселях: {err:.2f} рівня (ліміт {cfg['max_error']})")
    if err >= cfg["max_error"]:
        raise SystemExit(f"Clean plate не пройшов перевірку: {err:.2f} ≥ {cfg['max_error']}")

    np.save(ctx.tmp / "plate.npy", B)
    np.save(ctx.tmp / "gains.npy", gains)
    np.save(ctx.tmp / "never_free.npy", never)
    cv2.imwrite(str(ctx.tmp / "plate.png"), cv2.cvtColor(np.clip(B, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    ctx.save_state(plate={
        "error": round(err, 3), "gain_min": float(gains.min()), "gain_max": float(gains.max()),
        "core_fraction": float(hole.mean()), "bias": [float(b) for b in bias],
        "level_min": float(B.mean(-1).min()), "level_max": float(B.mean(-1).max()),
    })
    dump_json(ctx.tmp / "gains.json", gains.round(5).tolist())
