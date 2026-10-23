"""Точка входу пайплайну.

    python pipeline/build.py                 # усі кроки
    python pipeline/build.py --step matte    # один крок
    python pipeline/build.py --from shadow   # з кроку і до кінця
"""
from __future__ import annotations

import argparse
import importlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from steps.common import Ctx, clean_appledouble, env_threads  # noqa: E402

STEPS = [
    ("extract", "4.2 кадри з відео"),
    ("aimask", "4.4.1 маска rembg"),
    ("plate", "4.3 чиста підкладка B"),
    ("matte", "4.4 маска солдата і деконтамінація"),
    ("angles", "4.6 таблиця кутів"),
    ("shadow", "4.5 шар тіні"),
    ("export", "4.7 кроп, тонування, WebP, manifest"),
    ("svg", "4.8 зони"),
    ("pano", "5 панорама"),
    ("qa", "4.9 QA-матеріали і звіт"),
]
NAMES = [s for s, _ in STEPS]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", choices=NAMES, action="append", help="виконати лише цей крок (можна кілька)")
    ap.add_argument("--from", dest="start", choices=NAMES, help="почати з цього кроку")
    ap.add_argument("--config", type=Path)
    ap.add_argument("--force", action="store_true", help="перерахувати кеш α_ai")
    args = ap.parse_args()

    env_threads()
    ctx = Ctx(args.config)
    if args.step:
        todo = args.step
    elif args.start:
        todo = NAMES[NAMES.index(args.start):]
    else:
        todo = NAMES

    for name, title in STEPS:
        if name not in todo:
            continue
        print(f"▶ {name}: {title}", flush=True)
        t = time.time()
        mod = importlib.import_module(f"steps.{name}")
        if name == "aimask":
            mod.step(ctx, force=args.force)
        else:
            mod.step(ctx)
        print(f"  ✓ {name} за {time.time() - t:.1f} с", flush=True)
    for d in (ctx.public, ctx.qa):
        clean_appledouble(d)


if __name__ == "__main__":
    main()
