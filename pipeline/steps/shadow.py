"""4.5 Тінь окремим шаром: S = 1 − L(I)/L(B_i) в еліпсі підлоги,
дірка під солдатом заповнюється inpaint, шумоподавлення і підсилення.
Майстер: build_tmp/shadow/{i}.png (16 біт, повна роздільність, S_out).
"""
from __future__ import annotations

import cv2
import numpy as np

from .common import Ctx, frame_path, log, luma, read_gray16, read_rgb, write_gray16


def ellipse_mask(W, H, cx, cy, rx, ry, feather):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    # feather у пікселях уздовж малої осі → у нормованих одиницях
    f = feather / min(rx, ry)
    return np.clip((1 - r) / f + 0.5, 0, 1)


def step(ctx: Ctx):
    cfg = ctx.cfg["shadow"]
    (K,) = [ctx.state["angles"]["K"]]
    anc = ctx.state["anchor"]
    W, H = ctx.W, ctx.H
    B = np.load(ctx.tmp / "plate.npy")
    gains = np.load(ctx.tmp / "gains.npy")
    rx, ry = cfg["ellipse_rx"] * W, cfg["ellipse_ry"] * H
    ell = ellipse_mask(W, H, anc["x"], anc["y"], rx, ry, cfg["ellipse_feather_px"] * ctx.px)

    # «чиста підлога» для noise floor: та сама смуга по висоті, поза еліпсом
    yy, xx = np.mgrid[0:H, 0:W]
    clean = (np.abs(yy - anc["y"]) < ry) & (ell == 0)

    # Обробка лише в межах еліпса (пам'ять: K кадрів × ROI).
    ys_, xs_ = np.nonzero(ell > 0)
    y0, y1, x0, x1 = ys_.min(), ys_.max() + 1, xs_.min(), xs_.max() + 1
    roi = (slice(y0, y1), slice(x0, x1))

    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    raw = []
    noise = []
    for i in range(K):
        I = read_rgb(frame_path(ctx, i)).astype(np.float32)
        LB = luma(B * gains[i])
        S = np.clip(1 - luma(I) / np.maximum(LB, 1), 0, 1)
        noise.append(S[clean])
        a = read_gray16(ctx.tmp / "alpha" / f"{i:03d}.png")
        # Дірка під солдатом: не лише α > 0.5, а вся напівпрозора кромка,
        # інакше темний край черевиків проступає контуром у тіні.
        hole = cv2.dilate((a > 0.02).astype(np.uint8), ker, iterations=1)
        S16 = (S * 65535).astype(np.uint16)
        S = cv2.inpaint(S16, hole, int(6 * ctx.px), cv2.INPAINT_TELEA).astype(np.float32) / 65535
        raw.append((S * ell)[roi])
    raw = np.stack(raw)

    nf = cfg["noise_floor"]
    if nf == "auto":
        nf = float(np.percentile(np.concatenate(noise), 95))
    log(f"noise floor = {nf:.4f}")
    S = np.maximum(0, raw - nf)
    sig = cfg["blur_sigma_px"] * ctx.px
    S = np.stack([cv2.GaussianBlur(s, (0, 0), sig) for s in S])
    r = cfg["temporal_radius"]
    if r > 0:  # петля циклічна: сусіди кадру 0 — кадри K−1, K−2
        S = np.mean([np.roll(S, k, axis=0) for k in range(-r, r + 1)], axis=0)
    Sout = np.clip(S * cfg["gain"], 0, cfg["max_opacity"])

    out = ctx.dir("shadow")
    full = np.zeros((H, W), np.float32)
    for i in range(K):
        full[roi] = Sout[i]
        write_gray16(out / f"{i:03d}.png", full)
    raw_in = raw[raw > 0]
    ctx.save_state(shadow={
        "noise_floor": nf,
        "raw_p90": float(np.percentile(raw_in, 90)) if raw_in.size else 0,
        "raw_p99": float(np.percentile(raw_in, 99)) if raw_in.size else 0,
        "out_max": float(Sout.max()), "out_mean_in_ellipse": float(Sout[:, ell[roi] > 0.5].mean()),
    })
    log(f"S_out: max {Sout.max():.3f}, середнє в еліпсі {Sout[:, ell[roi] > 0.5].mean():.4f}")
