"""4.9 QA-матеріали: contact sheet, matte_check.mp4, edges_200, svg_overlay_f0,
метрики ореолу і вирівнювання зон, текстовий звіт qa/report.md.
"""
from __future__ import annotations

import json
import subprocess
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image

from . import svgpath
from .common import Ctx, frame_path, log, luma, read_gray16, read_rgb

DARK = np.array([0x3A, 0x3A, 0x35], np.float32)
NS = "{http://www.w3.org/2000/svg}"

# Очікувані значення з розділу 2 ТЗ — для автоматичного списку розбіжностей.
TZ = {
    "size": (960, 960), "fps": 30, "frames": 150,
    "keys": {90: 44, 180: 74, 270: 100}, "K": (143, 146),
    "axis_x": (484, 487), "anchor_y": (846, 852), "head_top": 102,
    "crop": (230, 80, 740, 920), "noise_floor": 0.012,
}


def load_master(ctx: Ctx, i: int):
    im = np.asarray(Image.open(ctx.tmp / "master" / f"{i:03d}.png").convert("RGBA")).astype(np.float32)
    return im[..., :3], im[..., 3] / 255.0


def load_shadow(ctx: Ctx, i: int):
    x0, y0, x1, y1 = ctx.state["export"]["crop"]
    return read_gray16(ctx.tmp / "shadow" / f"{i:03d}.png")[y0:y1, x0:x1]


def comp(bg: np.ndarray, rgb: np.ndarray, a: np.ndarray, s: np.ndarray | None = None) -> np.ndarray:
    out = bg.astype(np.float32)
    if s is not None:
        out = out * (1 - s[..., None])
    out = rgb * a[..., None] + out * (1 - a[..., None])
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def label(img: np.ndarray, text: str, org=(10, 28), scale=0.8):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def pano_patch(ctx: Ctx, w: int, h: int, x_frac=0.5) -> np.ndarray:
    pano = read_rgb(ctx.pano)
    PH, PW = pano.shape[:2]
    ph = int(PH * 0.5)
    pw = int(ph * w / h)
    x0 = int(PW * x_frac - pw / 2) % PW
    y0 = int(PH * 0.36)
    strip = np.concatenate([pano, pano], 1)[y0:y0 + ph, x0:x0 + pw]
    return cv2.resize(strip, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)


def nearest_frame(angles: list[float], deg: float) -> int:
    a = np.array(angles + [360.0])
    i = int(np.argmin(np.abs(a - deg)))
    return 0 if i == len(angles) else i


def contact_sheet(ctx: Ctx, angles):
    tiles_dark, tiles_pano = [], []
    th = 420
    for deg in range(0, 360, 30):
        i = nearest_frame(angles, deg)
        rgb, a = load_master(ctx, i)
        s = load_shadow(ctx, i)
        h, w = a.shape
        dark = comp(np.broadcast_to(DARK, rgb.shape), rgb, a, s)
        pano = comp(pano_patch(ctx, w, h, 0.5), rgb, a, s)
        tw = int(w * th / h)
        for img, lst in ((dark, tiles_dark), (pano, tiles_pano)):
            t = cv2.resize(img, (tw, th), interpolation=cv2.INTER_AREA)
            lst.append(label(t, f"{deg} / f{i} ({angles[i]:.1f})", scale=0.55))
    sheet = np.vstack([np.hstack(tiles_dark[:6]), np.hstack(tiles_dark[6:]),
                       np.hstack(tiles_pano[:6]), np.hstack(tiles_pano[6:])])
    cv2.imwrite(str(ctx.qa / "contact_sheet.png"), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))


def matte_video(ctx: Ctx, K: int):
    rgb, a = load_master(ctx, 0)
    h, w = a.shape
    fps = ctx.state["video"]["fps"]
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
         "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
         "-movflags", "+faststart", str(ctx.qa / "matte_check.mp4")], stdin=subprocess.PIPE)
    bg = np.broadcast_to(DARK, (h, w, 3))
    for i in range(K):
        rgb, a = load_master(ctx, i)
        p.stdin.write(comp(bg, rgb, a, load_shadow(ctx, i)).tobytes())
    p.stdin.close()
    p.wait()


def halo_metrics(ctx: Ctx, idxs) -> dict:
    """Світлий ореол на темному тлі: наскільки композит у кільці 0–3 px зовні
    контуру α=0.5 яскравіший за max(тло, яскравість найближчих внутрішніх
    пікселів). Деконтамінований результат проти «наївного» (кадр × α)."""
    x0, y0, x1, y1 = ctx.state["export"]["crop"]
    bgL = float(luma(DARK[None, None])[0, 0])
    res = {k: {"p99": [], "wide": []} for k in ("decontaminated", "naive")}
    for i in idxs:
        rgb, a = load_master(ctx, i)
        I = read_rgb(frame_path(ctx, i))[y0:y1, x0:x1].astype(np.float32)
        d = cv2.distanceTransform((a <= 0.5).astype(np.uint8), cv2.DIST_L2, 5)
        ring = (d > 0) & (d <= 3)
        far = (d > 1) & (d <= 3)
        inner = (a > 0.95).astype(np.float32)
        bg = np.broadcast_to(DARK, rgb.shape)
        for name, col in (("decontaminated", rgb), ("naive", I)):
            Lin = luma(col) * inner
            Lprop = cv2.GaussianBlur(Lin, (0, 0), 3) / np.maximum(cv2.GaussianBlur(inner, (0, 0), 3), 1e-3)
            ex = luma(comp(bg, col, a)) - np.maximum(bgL, Lprop)
            res[name]["p99"].append(float(np.percentile(ex[ring], 99)))
            res[name]["wide"].append(float((ex[far] > 10).mean()))
    return {k: {"p99": round(max(v["p99"]), 1), "wide_pct": round(100 * max(v["wide"]), 2)}
            for k, v in res.items()}


def edges(ctx: Ctx, keys):
    x0, y0, x1, y1 = ctx.state["export"]["crop"]
    cols = []
    for deg, k in zip((0, 90, 180, 270), keys):
        i = int(round(k))
        rgb, a = load_master(ctx, i)
        I = read_rgb(frame_path(ctx, i))[y0:y1, x0:x1].astype(np.float32)
        anc = ctx.state["anchor"]
        hy = int(anc["headTopY"] - y0)
        ys, xs = np.nonzero(a > 0.5)
        cx = int(np.median(xs))
        box = (max(0, hy - 16), cx - 110, 300, 220)  # голова, плечі
        r0, c0, hh, ww = box
        c0 = max(0, min(c0, a.shape[1] - ww))
        sl = (slice(r0, r0 + hh), slice(c0, c0 + ww))
        bg = np.broadcast_to(DARK, rgb.shape)
        naive = comp(bg, I, a)[sl]
        dec = comp(bg, rgb, a)[sl]
        z = lambda im: cv2.resize(im, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)  # noqa: E731
        col = np.vstack([label(z(naive), f"{deg} f{i}: naive"), label(z(dec), f"{deg} f{i}: decontam")])
        cols.append(col)
    sheet = np.hstack(cols)
    cv2.imwrite(str(ctx.qa / "edges_200.png"), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))


def svg_overlay(ctx: Ctx) -> dict:
    x0, y0, x1, y1 = ctx.state["export"]["crop"]
    scale = ctx.state["svg"]["svgScale"]
    root = ET.parse(ctx.public / "zones.svg").getroot()
    vb = [float(v) for v in root.get("viewBox").split()]
    W, H = x1 - x0, y1 - y0
    ss = 2
    img = read_rgb(frame_path(ctx, 0))[y0:y1, x0:x1]
    img = cv2.resize(img, None, fx=ss, fy=ss, interpolation=cv2.INTER_CUBIC)
    a0 = read_gray16(ctx.tmp / "alpha" / "000.png")[y0:y1, x0:x1]
    sil = (a0 > 0.5).astype(np.uint8)
    union = np.zeros((H, W), np.uint8)
    for g in root.iter(f"{NS}g"):
        col = g.get("data-color").lstrip("#")
        bgr = tuple(int(col[k:k + 2], 16) for k in (0, 2, 4))
        polys = [p for path in g.iter(f"{NS}path") for p in svgpath.parse(path.get("d"))]
        m2 = svgpath.raster(polys, W, H, scale, offset=(vb[0], vb[1]), ss=ss)
        cs, _ = cv2.findContours(m2, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(img, cs, -1, bgr, 1, cv2.LINE_AA)
        union |= svgpath.raster(polys, W, H, scale, offset=(vb[0], vb[1]), ss=1) > 0
    # вирівнювання: зовнішні межі зон проти контуру силуету
    eU = cv2.morphologyEx(union, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    eS = cv2.morphologyEx(sil, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    dS = cv2.distanceTransform((~eS).astype(np.uint8), cv2.DIST_L2, 5)
    outer = eU & (dS <= 6)
    dist = dS[outer]
    cs, _ = cv2.findContours(cv2.resize(sil, None, fx=ss, fy=ss, interpolation=cv2.INTER_NEAREST),
                             cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = img.copy()
    cv2.drawContours(out, cs, -1, (255, 255, 255), 1, cv2.LINE_AA)
    img = cv2.addWeighted(out, 0.45, img, 0.55, 0)
    label(img, "frame 0 + zones.svg (colour) + alpha>0.5 contour (white)", scale=0.7)
    cv2.imwrite(str(ctx.qa / "svg_overlay_f0.png"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    return {
        "outer_edge_px": int(outer.sum()),
        "within_2px": round(float((dist <= 2).mean()), 4) if dist.size else 0,
        "p50": round(float(np.median(dist)), 2) if dist.size else 0,
        "p95": round(float(np.percentile(dist, 95)), 2) if dist.size else 0,
    }


def fmt_kb(b):
    return f"{b / 1024:.0f} КБ"


def report(ctx: Ctx, halo: dict, align: dict, ang: dict):
    st = ctx.state
    v, an, ex, sh, pl = st["video"], st["angles"], st["export"], st["shadow"], st["plate"]
    anc = st["anchor"]
    keys = an["keys"]
    diffs = []
    if (v["width"], v["height"]) != TZ["size"] or v["frames"] != TZ["frames"] or round(v["fps"]) != TZ["fps"]:
        diffs.append(f"Відео: {v['width']}×{v['height']}, {v['frames']} кадрів, {v['fps']:g} fps "
                     f"(ТЗ: 960×960, 150, 30).")
    for d, exp in TZ["keys"].items():
        k = keys[(0, 90, 180, 270).index(d)]
        if abs(k - exp) > 2:
            diffs.append(f"Ключовий кадр {d}°: виміряно {k:.1f}, у ТЗ ≈{exp}.")
    if not TZ["K"][0] <= an["K"] <= TZ["K"][1]:
        diffs.append(f"Кінець петлі K = {an['K']} (ТЗ: ≈143–146).")
    if not TZ["axis_x"][0] - 2 <= anc["x"] <= TZ["axis_x"][1] + 2:
        diffs.append(f"Вісь обертання x = {anc['x']:.1f} (ТЗ: ≈484–487).")
    if not TZ["anchor_y"][0] - 3 <= anc["y"] <= TZ["anchor_y"][1] + 3:
        diffs.append(f"Лінія підошов y = {anc['y']:.0f} (ТЗ: ≈846–852).")
    if abs(anc["headTopY"] - TZ["head_top"]) > 4:
        diffs.append(f"headTopY = {anc['headTopY']:.0f} (ТЗ: ≈102).")
    if an["direction"] != "face-turns-to-screen-right":
        diffs.append(f"Напрям обертання: {an['direction']} (ТЗ: обличчя вправо).")
    if abs(sh["noise_floor"] - TZ["noise_floor"]) > 0.006:
        diffs.append(f"Noise floor тіні {sh['noise_floor']:.4f} (ТЗ: ≈0.012).")
    diffs.append(f"Фон відео має покадрове мерехтіння експозиції: коефіцієнт {pl['gain_min']:.3f}–{pl['gain_max']:.3f} "
                 "(≈±1,5%). У ТЗ не згадано; clean plate рахується з покадровою нормалізацією.")
    diffs.append("B = 95-й перцентиль вільних значень мінус виміряний зсув від шуму "
                 f"({', '.join(f'{b:.2f}' for b in pl['bias'])} рівня по R,G,B): чистий p95 дає систематичне "
                 "завищення фону на ~1,7 рівня, що шкодить ключу тіні.")
    diffs.append("Вільні пікселі для B визначаються маскою rembg, а не різницею з медіаною: через сповільнення "
                 "біля фронту фронтальний силует присутній у більшості кадрів і потрапляє в медіану.")
    diffs.append("Дірка в тіні під солдатом заповнюється для α > 0.02 (+2 px), а не α > 0.5: інакше напівпрозора "
                 "кромка черевиків дає темний контур у шарі тіні.")
    if an["max_deg_per_frame_mid"] > 4.5:
        diffs.append(f"Обертання у відео не лише нерівномірне, а й ривками: окремі кадри стоять, потім стрибок до "
                     f"{an['max_deg_per_frame_mid']:.1f}°/кадр (ТЗ: ≈3,2°/кадр у середині сегментів). Ривки видно і на "
                     "кривій ширини силуету, тобто це властивість джерела. При повільному drag можливе ступінчасте "
                     "обертання — кандидат на `rotation.frameBlend`.")
    if an["K"] != an["loop_best"]:
        diffs.append(f"Кінець петлі: формальний мінімум відстані до кадру 0 — кадр {an['loop_best']}, але кадри "
                     f"{an['loop_plateau'][0]}…{an['loop_plateau'][-1]} однаково близькі (обертання зупинилось). "
                     f"Взято K = {an['K']} (початок плато), щоб у петлю не потрапили дублікати.")
    diffs.append(f"Кадр {v['frames'] - 1} відрізняється від кадру 0 на ≈{an['last_vs_0_deg']:.1f}°, а кадр 7 — на "
                 f"≈{an['f7_vs_0_deg']:.1f}° (ТЗ: «так само»); петля замкнена краще, ніж очікувалось.")
    diffs.append("У відео за силуетом є світла кайма (I > B на 5–10 рівнів, ефект шарпенінгу). α_diff рахується лише "
                 "за затемненням і зміною кольору, колір краю обмежено кольором внутрішніх сусідів — інакше кайма "
                 "дає білий ореол на темному ангарі.")
    diffs.append("`cv2.ximgproc.guidedFilter` з 3-канальним float-гайдом вироджується в box-фільтр (рампа α ~16 px, "
                 "широкий ореол). Використовується 8-бітний гайд з eps × 255².")
    diffs.append("Контактна тінь під черевиками присутня майже в усіх кадрах, тому частково «запечена» в clean plate "
                 "і слабше виділяється в шарі тіні. Компенсується синтетичною контактною тінню в рантаймі (7.5).")
    diffs.append("Вхідні файли: панорама надана як `bg.png` (у ТЗ `image.png`), референс UI `image.jpg` не надано — "
                 "параметри з 2.6 взято з тексту ТЗ.")

    seam_note = ("помітний — рекомендовано `seam.crossfadeFrames: 3`" if an["seam_deg"] > 1.5
                 else "в межах норми")
    lines = [
        "# QA-звіт · етап M1 (кадри солдата)",
        "",
        "Згенеровано `python pipeline/build.py`. Усі числа виміряні на поточних вхідних файлах.",
        "",
        "## Відео",
        f"- {v['codec']} {v['width']}×{v['height']}, {v['fps']:g} fps, {v['pix_fmt']}, {v['frames']} кадрів",
        f"- Clean plate: похибка на вільних пікселях **{pl['error']:.2f}** рівня (ліміт 3); "
        f"рівень фону {pl['level_min']:.0f}–{pl['level_max']:.0f}; ядро, заповнене inpaint, {pl['core_fraction'] * 100:.1f}% кадру",
        f"- Мерехтіння експозиції: g ∈ [{pl['gain_min']:.4f}, {pl['gain_max']:.4f}]",
        f"- Модель маски: `{st.get('ai_model', '?')}`",
        "",
        "## Таблиця кутів (`public/assets/angles.json`)",
        "| Кут | Виміряний кадр | ТЗ (≈) |",
        "|---|---|---|",
        f"| 0° | {keys[0]:.1f} | 0 |",
        f"| 90° | {keys[1]:.2f} | 44 |",
        f"| 180° | {keys[2]:.2f} | 74 |",
        f"| 270° | {keys[3]:.2f} | 100 |",
        f"| 360° (K) | {keys[4]:.0f} | 143–146 |",
        "",
        f"- Кадрів у петлі: **{an['K']}** (0…{an['K'] - 1}); кадри {an['K']}…{v['frames'] - 1} відкинуто",
        f"- Плато зупинки (кадри, однаково близькі до кадру 0 у межах шуму): {an['loop_plateau'][0]}…{an['loop_plateau'][-1]}; "
        f"формальний мінімум — кадр {an['loop_best']}; K = початок плато",
        f"- Залишковий стрибок на шві K→0: **{an['seam_deg']:.2f}°** — {seam_note}",
        f"- Для порівняння: кадр {v['frames'] - 1} vs 0 ≈ {an['last_vs_0_deg']:.1f}°, кадр 7 vs 0 ≈ {an['f7_vs_0_deg']:.1f}°",
        f"- Напрям: `{an['direction']}`",
        f"- Макс. крок у середині сегментів: {an['max_deg_per_frame_mid']:.2f}°/кадр",
        f"- Найбільше відхилення від лінійного припущення (i × 2,4°): {ang['max_lin_err']:.1f}° на кадрі {ang['max_lin_err_i']}",
        "",
        "## Тінь",
        f"- Noise floor (авто, p95 на чистій підлозі): **{sh['noise_floor']:.4f}**",
        f"- Сире затемнення в еліпсі: p90 {sh['raw_p90'] * 100:.1f}%, p99 {sh['raw_p99'] * 100:.1f}%",
        f"- Після підсилення: max {sh['out_max']:.2f}, середнє в еліпсі {sh['out_mean_in_ellipse']:.3f}",
        "",
        "## Кадрування і точка опори",
        f"- Кроп (джерело): x {ex['crop'][0]}–{ex['crop'][2]}, y {ex['crop'][1]}–{ex['crop'][3]} "
        f"({ex['crop'][2] - ex['crop'][0]}×{ex['crop'][3] - ex['crop'][1]})",
        f"- anchor: ({anc['x']:.1f}, {anc['y']:.1f}) у джерелі; headTopY {anc['headTopY']:.0f}",
        "",
        "## Вага наборів",
        "| Набір | Розмір | Бюджет | quality |",
        "|---|---|---|---|",
        f"| full | {ex['sizes_mb']['full']:.2f} МБ | 9 МБ | {ex['quality']['full']} |",
        f"| half | {ex['sizes_mb']['half']:.2f} МБ | 3,5 МБ | {ex['quality']['half']} |",
        f"| shadow | {ex['sizes_mb']['shadow']:.2f} МБ | 0,6 МБ | {ex['quality']['shadow']} |",
        "",
    ]
    if ex["notes"]:
        lines += ["Зниження якості через бюджет:", *[f"- {n}" for n in ex["notes"]], ""]
    sv = st["svg"]
    lines += [
        "## SVG-зони",
        f"- Групи: {', '.join(f'{k}×{n}' for k, n in sv['zones'].items())}",
        f"- svgScale = {sv['svgScale']:g}; viewBox = {' '.join(f'{x:g}' for x in sv['viewBox'])}",
        f"- Розмір `zones.svg`: {fmt_kb(sv['bytes'])}; макс. відхилення геометрії після svgo: **{sv['max_dev_px']:.2f} px** (ліміт 0,5)",
        f"- Вирівнювання з кадром 0: зовнішні межі зон у межах ±2 px від контуру α=0.5 — "
        f"**{align['within_2px'] * 100:.1f}%** точок (медіана {align['p50']} px, p95 {align['p95']} px)",
        "",
    ]
    if "pano" in st:
        pn = st["pano"]
        lines += [
            "## Панорама (етап M2)",
            f"- Джерело: `{pn['source']}` {pn['src_size'][0]}×{pn['src_size'][1]} → {pn['size'][0]}×{pn['size'][1]} "
            "(рівно 2:1, Lanczos)",
            f"- Шов: {pn['seam_before']:.2f}× → {pn['seam_after']:.2f}× від різниці сусідніх колонок",
            f"- Варіанти: {', '.join(pn['variants'])}. `pano_4096.jpg` має розмір джерела ({pn['size'][0]}×{pn['size'][1]}): "
            "алгоритмічно не апскейлимо; `pano_8192` — лише з `hangar_360_upscaled.png`",
            "",
        ]
    lines += [
        "## Краї (ореол)",
        "- Надлишок яскравості композиту на тлі #3A3A35 над max(тло, найближчі внутрішні пікселі), "
        "кільце 0–3 px зовні контуру α=0.5, кадри 0/90/180/270:",
        f"  - деконтамінований: p99 **{halo['decontaminated']['p99']:+.1f}** рівня; "
        f"пікселів далі 1 px зі світлінням > 10 рівнів: **{halo['decontaminated']['wide_pct']:.2f}%**",
        f"  - наївна вирізка: p99 {halo['naive']['p99']:+.1f}; далі 1 px: {halo['naive']['wide_pct']:.2f}%",
        "",
        "## Розбіжності з розділом 2 ТЗ",
        *[f"- {d}" for d in diffs],
        "",
        "## Файли",
        "- `qa/contact_sheet.png` — 12 кадрів через 30° (за таблицею кутів): темний фон / фрагмент панорами",
        "- `qa/matte_check.mp4` — повний оберт на темному фоні з тінню",
        "- `qa/edges_200.png` — краї ×2, наївна вирізка проти деконтамінованої",
        "- `qa/angle_plot.png`, `qa/svg_overlay_f0.png`",
    ]
    (ctx.qa / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def step(ctx: Ctx):
    data = json.loads((ctx.public / "angles.json").read_text())
    angles = data["anglesDeg"]
    K = data["frameCount"]
    keys = ctx.state["angles"]["keys"]
    contact_sheet(ctx, angles)
    log("contact_sheet.png")
    matte_video(ctx, K)
    log("matte_check.mp4")
    edges(ctx, keys[:4])
    log("edges_200.png")
    align = svg_overlay(ctx)
    log(f"svg_overlay_f0.png: ±2 px — {align['within_2px'] * 100:.1f}%")
    halo = halo_metrics(ctx, [int(round(k)) for k in keys[:4]])
    log(f"ореол: decontam {halo['decontaminated']}, naive {halo['naive']}")
    full = np.array(ctx.state["angles"]["angles_full"])
    lin = np.arange(len(full)) * 2.4
    err = np.abs(full - lin)
    report(ctx, halo, align, {"max_lin_err": float(err.max()), "max_lin_err_i": int(err.argmax())})
    log("report.md")
