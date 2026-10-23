"""5. Панорама: рівно 2:1 (Lanczos), шов, опційний патч надиру,
варіанти текстури (4096 / 8192 / preview) і офлайн-розмиття.
"""
from __future__ import annotations

import json
import shutil

import cv2
import numpy as np

from .common import Ctx, dump_json, log, read_rgb, write_rgb


def seam_ratio(p: np.ndarray) -> float:
    p = p.astype(np.float32)
    seam = np.abs(p[:, 0] - p[:, -1]).mean()
    adj = np.abs(p[:, 1:] - p[:, :-1]).mean()
    return float(seam / adj)


def fix_seam(p: np.ndarray, band: int) -> np.ndarray:
    """Розносить різницю країв на ±band px з урахуванням циклічності:
    лівий край тягнеться до середнього, правий — теж, лінійно згасаючи."""
    x = p.astype(np.float32)
    d = x[:, :1] - x[:, -1:]                      # (H,1,3): різниця «початок − кінець»
    d = cv2.GaussianBlur(d, (1, 0), sigmaX=0.1, sigmaY=3)
    t = (1 - np.arange(band, dtype=np.float32) / band)[None, :, None]  # 1 → 0
    x[:, :band] -= 0.5 * d * t
    x[:, -band:] += 0.5 * d * t[:, ::-1]
    return np.clip(x + 0.5, 0, 255).astype(np.uint8)


def nadir_patch(p: np.ndarray, frac: float) -> np.ndarray:
    """Нижні frac висоти плавно змішуються з усередненим по рядку бетоном."""
    H = p.shape[0]
    h = max(2, int(H * frac))
    x = p.astype(np.float32)
    ref = x[H - 2 * h:H - h]
    mean_row = cv2.GaussianBlur(ref.mean(0, keepdims=True), (0, 0), sigmaX=40, sigmaY=0.1)
    fill = np.repeat(mean_row, h, 0)
    w = np.linspace(0, 1, h, dtype=np.float32)[:, None, None] ** 1.5
    x[H - h:] = x[H - h:] * (1 - w) + fill * w
    return np.clip(x + 0.5, 0, 255).astype(np.uint8)


def blur_cyclic(p: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return p
    pad = int(sigma * 4) + 1
    x = cv2.copyMakeBorder(p, 0, 0, pad, pad, cv2.BORDER_WRAP)
    x = cv2.GaussianBlur(x, (0, 0), sigma)
    return x[:, pad:-pad]


def save_jpg(path, rgb, q):
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_JPEG_QUALITY, q, cv2.IMWRITE_JPEG_OPTIMIZE, 1])


def step(ctx: Ctx):
    cfg = ctx.cfg["pano"]
    upscaled = ctx.pano_upscaled.exists()
    src = ctx.pano_upscaled if upscaled else ctx.pano
    p = read_rgb(src)
    H0, W0 = p.shape[:2]
    log(f"джерело: {src.name} {W0}×{H0} ({W0 / H0:.3f}:1), шов {seam_ratio(p):.2f}× від сусідніх колонок")

    H = H0
    W = 2 * H
    if (W, H) != (W0, H0):
        p = cv2.resize(p, (W, H), interpolation=cv2.INTER_LANCZOS4)
        log(f"→ 2:1: {W}×{H} (по горизонталі {100 * (W / W0 - 1):+.1f}%)")

    before = seam_ratio(p)
    if before > cfg["seam_max_ratio"]:
        band = int(round(cfg["seam_blend_px"] * W / 2880))
        p = fix_seam(p, band)
    after = seam_ratio(p)
    log(f"шов після ресайзу: {before:.2f}× → {after:.2f}×")

    if cfg["nadirPatch"]:
        p = nadir_patch(p, cfg["nadir_fraction"])
        log("надир: патч застосовано")

    out = ctx.public / "pano"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # Варіанти: не апскейлимо алгоритмічно — це не додає деталей.
    variants = {}
    w4 = min(cfg["width"], W)
    sizes = {"pano_4096": w4}
    if upscaled and W >= 8192:
        sizes["pano_8192"] = 8192
    q = cfg["quality"]
    for name, w in sizes.items():
        img = p if w == W else cv2.resize(p, (w, w // 2), interpolation=cv2.INTER_AREA)
        for b in cfg["blurPx"]:
            fn = f"{name}.jpg" if b == 0 else f"{name}_b{b}.jpg"
            save_jpg(out / fn, blur_cyclic(img, b * w / 2880), q)
            variants.setdefault(name, {"width": w, "height": w // 2, "blur": {}})["blur"][str(b)] = fn
    pw = cfg["preview_width"]
    save_jpg(out / "pano_preview.jpg", cv2.resize(p, (pw, pw // 2), interpolation=cv2.INTER_AREA), q)
    variants["pano_preview"] = {"width": pw, "height": pw // 2, "blur": {"0": "pano_preview.jpg"}}
    for f in sorted(out.glob("[!.]*.jpg")):
        log(f"{f.name}: {f.stat().st_size / 1e6:.2f} МБ")

    mpath = ctx.public / "manifest.json"
    manifest = json.loads(mpath.read_text()) if mpath.exists() else {}
    manifest["pano"] = {"dir": "pano/", "variants": variants, "upscaledSource": upscaled}
    dump_json(mpath, manifest)

    # QA: шов після зсуву на 50% і надир
    rolled = np.roll(p, W // 2, axis=1)
    c = W // 2
    crop = rolled[int(H * 0.25):int(H * 0.75), c - 200:c + 200]
    crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    cv2.line(crop, (400, 0), (400, 14), (255, 0, 0), 2)
    write_rgb(ctx.qa / "pano_seam.png", crop)
    write_rgb(ctx.qa / "pano_nadir.png", cv2.resize(p[int(H * 0.75):], (1440, int(1440 * 0.25 * H / W))))
    ctx.save_state(pano={"source": src.name, "src_size": [W0, H0], "size": [W, H],
                         "seam_before": before, "seam_after": after, "variants": list(variants)})
