"""4.8 SVG-зони: групування path за fill → <g data-zone>, viewBox = кроп,
прозора заливка з хіт-тестом, svgo (floatPrecision 1) з перевіркою геометрії.
"""
from __future__ import annotations

import shutil
import subprocess
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr

from . import svgpath
from .common import ROOT, Ctx, dump_json, log
from .export import svg_viewbox

NS = "{http://www.w3.org/2000/svg}"

SVGO_CONFIG = """export default {
  multipass: false,
  js2svg: { pretty: false },
  plugins: [
    { name: 'preset-default', params: { overrides: {
      removeViewBox: false, collapseGroups: false, mergePaths: false,
      removeHiddenElems: false, moveElemsAttrsToGroup: false,
      moveGroupAttrsToElems: false, removeUnknownsAndDefaults: false,
      cleanupIds: false, convertTransform: false,
      // fill-opacity 0 → fill="none" ламає хіт-тест (visiblePainted) і прибирає evenodd
      removeUselessStrokeAndFill: false,
      convertPathData: { floatPrecision: %d, makeArcs: null },
      cleanupNumericValues: { floatPrecision: %d },
    } } },
  ],
};
"""


def read_zones(ctx: Ctx):
    colors = {k.upper(): v for k, v in ctx.cfg["zones"]["colors"].items()}
    root = ET.parse(ctx.svg).getroot()
    groups: dict[str, list[str]] = {}
    unknown = []
    for idx, p in enumerate(root.iter(f"{NS}path")):
        fill = (p.get("fill") or "").upper()
        if fill not in colors:
            unknown.append(f"path #{idx}: fill={fill or '—'}")
            continue
        groups.setdefault(colors[fill], []).append(p.get("d"))
    if unknown:
        raise SystemExit("Невідомі кольори зон у SVG (додайте в config.yaml → zones.colors):\n  "
                         + "\n  ".join(unknown))
    return groups, {v: k for k, v in colors.items()}


def build_svg(order, groups, color_of, viewbox, titles) -> str:
    vb = " ".join(f"{v:g}" for v in viewbox)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" class="sv-zones">']
    for key in order:
        if key not in groups:
            continue
        out.append(f'<g data-zone="{key}" data-color="{color_of[key]}" aria-label={quoteattr(titles.get(key, key))}>')
        for d in groups[key]:
            out.append(f'<path d="{d}" fill="#fff" fill-opacity="0" fill-rule="evenodd" pointer-events="visiblePainted"/>')
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out)


def svgo(src, dst, precision: int) -> bool:
    exe = ROOT / "node_modules" / ".bin" / "svgo"
    if not exe.exists():
        exe = shutil.which("svgo")
    if not exe:
        log("svgo не знайдено (npm install) — лише округлення координат")
        return False
    cfg = src.parent / "svgo.config.mjs"
    cfg.write_text(SVGO_CONFIG % (precision, precision))
    subprocess.run([str(exe), "--config", str(cfg), "-i", str(src), "-o", str(dst), "--quiet"], check=True)
    return True


def round_svg(text: str, precision: int) -> str:
    import re
    return re.sub(r"\d+\.\d+", lambda m: f"{float(m.group()):.{precision}f}".rstrip("0").rstrip("."), text)


def parse_groups(path):
    root = ET.parse(path).getroot()
    res = {}
    for g in root.iter(f"{NS}g"):
        res[g.get("data-zone")] = [p.get("d") for p in g.iter(f"{NS}path")]
    return res, root.get("viewBox")


def step(ctx: Ctx):
    zc = ctx.cfg["zones"]
    order = list(dict.fromkeys(zc["colors"].values()))
    titles = zc["titles"]
    groups, color_of = read_zones(ctx)
    log("зони: " + ", ".join(f"{k}×{len(v)}" for k, v in groups.items()))

    _, _, vbw, _ = svg_viewbox(ctx.svg)
    scale = ctx.W / vbw  # px відео на одиницю SVG
    cx0, cy0, cx1, cy1 = ctx.state["export"]["crop"]
    viewbox = (cx0 / scale, cy0 / scale, (cx1 - cx0) / scale, (cy1 - cy0) / scale)

    raw = ctx.tmp / "zones_raw.svg"
    raw.write_text(build_svg(order, groups, color_of, viewbox, titles), encoding="utf-8")
    dst = ctx.public / "zones.svg"
    prec = zc["float_precision"]
    if not svgo(raw, dst, prec):
        dst.write_text(round_svg(raw.read_text(encoding="utf-8"), prec), encoding="utf-8")

    # Атрибути хіт-тесту мають пережити svgo.
    text = dst.read_text(encoding="utf-8")
    n_paths = text.count("<path")
    for attr in ('fill="#fff"', 'fill-opacity="0"', 'fill-rule="evenodd"', 'pointer-events="visiblePainted"'):
        if text.count(attr) != n_paths:
            raise SystemExit(f"svgo зіпсував атрибут {attr}: {text.count(attr)} з {n_paths} path")

    # Перевірка геометрії: растеризація оригіналу і результату ×4.
    opt, _ = parse_groups(dst)
    ss = 4
    W, H = ctx.W, ctx.H
    worst = 0.0
    per_zone = {}
    for key, ds in groups.items():
        a = svgpath.raster([p for d in ds for p in svgpath.parse(d)], W, H, scale, ss=ss)
        b = svgpath.raster([p for d in opt[key] for p in svgpath.parse(d)], W, H, scale, ss=ss)
        dev = svgpath.hausdorff_px(a, b, ss)
        per_zone[key] = round(dev, 3)
        worst = max(worst, dev)
    log(f"svgo: {raw.stat().st_size / 1024:.0f} КБ → {dst.stat().st_size / 1024:.0f} КБ, "
        f"макс. відхилення геометрії {worst:.2f} px (ліміт 0,5)")
    if worst > 0.5:
        log("відхилення > 0,5 px — пишу SVG без svgo, лише з округленням")
        dst.write_text(round_svg(raw.read_text(encoding="utf-8"), max(prec, 2)), encoding="utf-8")

    dump_json(ctx.public / "zones.json",
              [{"key": k, "title": titles.get(k, k), "description": ""} for k in order if k in groups])
    ctx.save_state(svg={"zones": {k: len(v) for k, v in groups.items()}, "max_dev_px": round(worst, 3),
                        "per_zone_dev": per_zone, "viewBox": viewbox, "svgScale": scale,
                        "bytes": dst.stat().st_size})
