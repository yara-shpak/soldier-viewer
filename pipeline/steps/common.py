"""Спільні утиліти пайплайну: шляхи, конфіг, стан, ввід/вивід кадрів."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import cv2
import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[2]


class Ctx:
    """Контекст збірки: конфіг, шляхи і спільний стан (build_tmp/state.json)."""

    def __init__(self, config_path: Path | None = None):
        self.config_path = config_path or ROOT / "pipeline" / "config.yaml"
        self.cfg = yaml.safe_load(self.config_path.read_text(encoding="utf-8"))
        p = self.cfg["paths"]
        self.video = ROOT / p["video"]
        self.svg = ROOT / p["svg"]
        self.pano = ROOT / p["pano"]
        self.pano_upscaled = ROOT / p["pano_upscaled"]
        self.tmp = ROOT / p["tmp"]
        self.qa = ROOT / p["qa"]
        self.public = ROOT / p["public"]
        for d in (self.tmp, self.qa, self.public):
            d.mkdir(parents=True, exist_ok=True)
        self.state_path = self.tmp / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    # --- стан між кроками ---
    def save_state(self, **kw):
        self.state.update(kw)
        self.state_path.write_text(json.dumps(self.state, indent=2, ensure_ascii=False))

    def need(self, *keys):
        missing = [k for k in keys if k not in self.state]
        if missing:
            raise SystemExit(f"Бракує даних попередніх кроків: {missing}. Запустіть повний build.")
        return [self.state[k] for k in keys]

    # --- розміри ---
    @property
    def W(self) -> int:
        return self.state["video"]["width"]

    @property
    def H(self) -> int:
        return self.state["video"]["height"]

    @property
    def px(self) -> float:
        """Множник для піксельних параметрів, заданих для кадру 960 px."""
        return self.W / 960.0

    def dir(self, name: str) -> Path:
        d = self.tmp / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def frame_count(self) -> int:
        return self.state["video"]["frames"]


def log(msg: str):
    print(f"  · {msg}", flush=True)


def run(cmd: list[str]):
    subprocess.run(cmd, check=True)


def list_files(d: Path, pattern: str) -> list[Path]:
    """glob без службових файлів macOS (._*), які створює exFAT."""
    return sorted(p for p in d.glob(pattern) if not p.name.startswith("._"))


def clean_appledouble(d: Path):
    """Видаляє ._* (AppleDouble), щоб вони не потрапили в деплой."""
    for p in d.rglob("._*"):
        try:
            p.unlink()
        except OSError:
            pass


def read_rgb(path: Path) -> np.ndarray:
    im = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if im is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(im, cv2.COLOR_BGR2RGB)


def write_rgb(path: Path, rgb: np.ndarray):
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


def read_gray16(path: Path) -> np.ndarray:
    """16-бітна PNG → float32 [0, 1]."""
    im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if im is None:
        raise FileNotFoundError(path)
    return im.astype(np.float32) / (65535.0 if im.dtype == np.uint16 else 255.0)


def write_gray16(path: Path, a: np.ndarray):
    cv2.imwrite(str(path), np.clip(a * 65535.0 + 0.5, 0, 65535).astype(np.uint16))


def frame_path(ctx: Ctx, i: int) -> Path:
    return ctx.tmp / "frames" / f"{i:03d}.png"


def load_frames(ctx: Ctx) -> np.ndarray:
    n = ctx.frame_count()
    return np.stack([read_rgb(frame_path(ctx, i)) for i in range(n)])


def luma(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float32)
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def dump_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def env_threads():
    os.environ.setdefault("OMP_NUM_THREADS", str(os.cpu_count() or 4))
