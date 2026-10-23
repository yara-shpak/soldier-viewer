"""Мінімальний парсер SVG path (M L H V C S Q T Z, абсолютні й відносні)
і растеризація з правилом evenodd — для перевірки геометрії після svgo
і для QA-накладань. Дуги (A) не підтримуються: svgo запускається з makeArcs = null.
"""
from __future__ import annotations

import re

import cv2
import numpy as np

_TOK = re.compile(r"[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "Z": 0}


def _bez(p0, p1, p2, p3, n=16):
    t = np.linspace(0, 1, n + 1)[1:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def parse(d: str) -> list[np.ndarray]:
    """→ список замкнених полігонів (N×2) у координатах path."""
    toks = _TOK.findall(d)
    polys: list[list] = []
    cur = np.zeros(2)
    start = np.zeros(2)
    last_ctrl = None
    last_cmd = ""
    cmd = ""
    i = 0
    pts: list = []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Aa":
                raise ValueError("дуги в path не підтримуються")
            if cmd in "Zz":
                if pts:
                    polys.append(pts)
                pts = []
                cur = start.copy()
                last_cmd = "Z"
                continue
        C = cmd.upper()
        rel = cmd.islower()
        base = cur if rel else np.zeros(2)
        if C == "M":
            p = np.array([num(), num()]) + base
            if pts:
                polys.append(pts)
            pts = [p]
            cur = start = p
            cmd = "l" if rel else "L"  # наступні пари — lineto
            last_ctrl = None
        elif C == "L":
            cur = np.array([num(), num()]) + base
            pts.append(cur)
            last_ctrl = None
        elif C == "H":
            x = num() + (cur[0] if rel else 0)
            cur = np.array([x, cur[1]])
            pts.append(cur)
            last_ctrl = None
        elif C == "V":
            y = num() + (cur[1] if rel else 0)
            cur = np.array([cur[0], y])
            pts.append(cur)
            last_ctrl = None
        elif C == "C":
            c1 = np.array([num(), num()]) + base
            c2 = np.array([num(), num()]) + base
            p = np.array([num(), num()]) + base
            pts.extend(_bez(cur, c1, c2, p))
            last_ctrl, cur = c2, p
        elif C == "S":
            c1 = 2 * cur - last_ctrl if last_cmd in "CS" and last_ctrl is not None else cur
            c2 = np.array([num(), num()]) + base
            p = np.array([num(), num()]) + base
            pts.extend(_bez(cur, c1, c2, p))
            last_ctrl, cur = c2, p
        elif C in "QT":
            if C == "Q":
                q = np.array([num(), num()]) + base
            else:
                q = 2 * cur - last_ctrl if last_cmd in "QT" and last_ctrl is not None else cur
            p = np.array([num(), num()]) + base
            pts.extend(_bez(cur, cur + 2 / 3 * (q - cur), p + 2 / 3 * (q - p), p))
            last_ctrl, cur = q, p
        last_cmd = C
    if pts:
        polys.append(pts)
    return [np.array(p) for p in polys if len(p) > 2]


def raster(polys: list[np.ndarray], W: int, H: int, scale: float = 1.0,
           offset=(0.0, 0.0), ss: int = 1) -> np.ndarray:
    """Растеризація (evenodd) у маску W·ss × H·ss. Координати → (p − offset)·scale."""
    img = np.zeros((H * ss, W * ss), np.uint8)
    shift = 4
    k = scale * ss * (1 << shift)
    cs = [np.round((p - np.array(offset)) * k).astype(np.int32) for p in polys]
    cv2.fillPoly(img, cs, 255, lineType=cv2.LINE_8, shift=shift)
    return img


def hausdorff_px(a: np.ndarray, b: np.ndarray, ss: int) -> float:
    """Симетрична відстань Гаусдорфа між межами двох масок (у px до супердискретизації)."""
    ea = cv2.morphologyEx(a, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    eb = cv2.morphologyEx(b, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    if not ea.any() or not eb.any():
        return float("inf")
    da = cv2.distanceTransform((~ea).astype(np.uint8), cv2.DIST_L2, 5)
    db = cv2.distanceTransform((~eb).astype(np.uint8), cv2.DIST_L2, 5)
    return float(max(da[eb].max(), db[ea].max())) / ss
