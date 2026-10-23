"""4.7 Кадрування, тонування (запікається), WebP-набори, manifest.json."""
from __future__ import annotations

import shutil
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image

from .common import Ctx, clean_appledouble, dump_json, list_files, log, read_gray16, read_rgb


def svg_viewbox(path) -> tuple[float, float, float, float]:
    root = ET.parse(path).getroot()
    vb = root.get("viewBox")
    if vb:
        return tuple(float(v) for v in vb.replace(",", " ").split())  # type: ignore[return-value]
    return 0.0, 0.0, float(root.get("width")), float(root.get("height"))


def tone(rgb: np.ndarray, t: dict) -> np.ndarray:
    """brightness / contrast / saturation / temperature, як CSS-filter-превʼю в debug."""
    x = rgb.astype(np.float32) / 255.0
    if t.get("brightness", 1) != 1:
        x = x * t["brightness"]
    if t.get("contrast", 1) != 1:
        x = (x - 0.5) * t["contrast"] + 0.5
    if t.get("saturation", 1) != 1:
        L = (0.2126 * x[..., 0] + 0.7152 * x[..., 1] + 0.0722 * x[..., 2])[..., None]
        x = L + (x - L) * t["saturation"]
    temp = t.get("temperature", 0)
    if temp:
        x = x * np.array([1 + 0.1 * temp, 1.0, 1 - 0.1 * temp], np.float32)
    return np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8)


def resize_premul(rgb: np.ndarray, a: np.ndarray, size: tuple[int, int]):
    """Масштабування в premultiplied-просторі: без темної/світлої облямівки."""
    pm = rgb.astype(np.float32) * a[..., None]
    pm = cv2.resize(pm, size, interpolation=cv2.INTER_AREA)
    a2 = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
    rgb2 = np.where(a2[..., None] > 1e-4, pm / np.maximum(a2[..., None], 1e-4), 0)
    return np.clip(rgb2 + 0.5, 0, 255).astype(np.uint8), a2


def rgba(rgb: np.ndarray, a: np.ndarray) -> Image.Image:
    a8 = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a8]), "RGBA")


def dir_mb(d) -> float:
    return sum(p.stat().st_size for p in list_files(d, "*.webp")) / 1e6


def even(v: float, up: bool) -> int:
    v = int(np.ceil(v)) if up else int(np.floor(v))
    return v + (v % 2) if up else v - (v % 2)


def step(ctx: Ctx):
    cfg = ctx.cfg["export"]
    K = ctx.state["angles"]["K"]
    anc = ctx.state["anchor"]
    W, H = ctx.W, ctx.H

    # --- спільний кроп: bbox(α > 0.01) ∪ bbox(S_out > 0.01) + відступ ---
    x0, y0, x1, y1 = W, H, 0, 0
    for i in range(K):
        for m in (read_gray16(ctx.tmp / "alpha" / f"{i:03d}.png") > 0.01,
                  read_gray16(ctx.tmp / "shadow" / f"{i:03d}.png") > 0.01):
            ys, xs = np.nonzero(m)
            if xs.size:
                x0, x1 = min(x0, xs.min()), max(x1, xs.max() + 1)
                y0, y1 = min(y0, ys.min()), max(y1, ys.max() + 1)
    pad = cfg["crop_pad_px"] * ctx.px
    cx0, cy0 = max(0, even(x0 - pad, False)), max(0, even(y0 - pad, False))
    cx1, cy1 = min(W, even(x1 + pad, True)), min(H, even(y1 + pad, True))
    cw, ch = cx1 - cx0, cy1 - cy0
    hw, hh = cw // 2, ch // 2
    log(f"кроп: x {cx0}–{cx1}, y {cy0}–{cy1} ({cw}×{ch})")

    dirs = {k: ctx.public / k for k in ("soldier/full", "soldier/half", "shadow")}
    for d in dirs.values():
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
    master = ctx.dir("master")

    q = {"full": cfg["soldier_quality"], "half": cfg["soldier_quality"], "shadow": cfg["shadow_quality"]}
    budgets = {"full": cfg["budget_full_mb"], "half": cfg["budget_half_mb"], "shadow": cfg["budget_shadow_mb"]}
    notes = []

    def encode(kind: str):
        d = dirs["soldier/" + kind] if kind != "shadow" else dirs["shadow"]
        for i in range(K):
            if kind == "shadow":
                s = read_gray16(ctx.tmp / "shadow" / f"{i:03d}.png")[cy0:cy1, cx0:cx1]
                s = cv2.resize(s, (hw, hh), interpolation=cv2.INTER_AREA)
                im = rgba(np.zeros((hh, hw, 3), np.uint8), s)
                im.save(d / f"{i:03d}.webp", "WEBP", quality=q[kind], method=6)
                continue
            a = read_gray16(ctx.tmp / "alpha" / f"{i:03d}.png")[cy0:cy1, cx0:cx1]
            rgb = tone(read_rgb(ctx.tmp / "fg" / f"{i:03d}.png")[cy0:cy1, cx0:cx1], cfg["tone"])
            if kind == "full":
                rgba(rgb, a).save(master / f"{i:03d}.png")
            else:
                rgb, a = resize_premul(rgb, a, (hw, hh))
            rgba(rgb, a).save(d / f"{i:03d}.webp", "WEBP", quality=q[kind],
                              alpha_quality=cfg["soldier_alpha_quality"], method=6)
        clean_appledouble(d)
        return dir_mb(d)

    sizes = {}
    for kind in ("full", "half", "shadow"):
        mb = encode(kind)
        while mb > budgets[kind] and q[kind] > 50:
            old = q[kind]
            q[kind] -= 5
            notes.append(f"{kind}: {mb:.2f} МБ > бюджету {budgets[kind]} МБ → quality {old} → {q[kind]}")
            log(notes[-1])
            mb = encode(kind)
        sizes[kind] = round(mb, 3)
        log(f"набір {kind}: {mb:.2f} МБ (бюджет {budgets[kind]}), quality {q[kind]}")

    _, _, vbw, _ = svg_viewbox(ctx.svg)
    svg_scale = W / vbw
    manifest = {
        "version": 1,
        "frameCount": K,
        "indexPad": 3,
        "source": {"width": W, "height": H, "fps": ctx.state["video"]["fps"]},
        "crop": {"x": cx0, "y": cy0, "width": cw, "height": ch},
        "sets": {
            "full": {"path": "soldier/full/{index}.webp", "width": cw, "height": ch},
            "half": {"path": "soldier/half/{index}.webp", "width": hw, "height": hh},
        },
        "shadow": {"path": "shadow/{index}.webp", "width": hw, "height": hh},
        "anchor": {
            "source": {"x": round(anc["x"], 2), "y": round(anc["y"], 2)},
            "crop": {"x": round(anc["x"] - cx0, 2), "y": round(anc["y"] - cy0, 2)},
        },
        "headTopY": {"source": anc["headTopY"], "crop": anc["headTopY"] - cy0},
        "frontWidth": {"source": float(np.ptp([ctx.state["matte"]["frame0"]["x0"], ctx.state["matte"]["frame0"]["x1"]]))},
        "svgScale": svg_scale,
        "angles": "angles.json",
        "zones": {"svg": "zones.svg", "content": "zones.json"},
    }
    dump_json(ctx.public / "manifest.json", manifest)
    ctx.save_state(export={"crop": [cx0, cy0, cx1, cy1], "sizes_mb": sizes, "quality": q,
                           "notes": notes, "svg_scale": svg_scale})
