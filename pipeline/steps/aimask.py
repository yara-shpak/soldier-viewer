"""4.4.1 α_ai — м'яка маска rembg (birefnet-general), без бінаризації.

Найдовший крок, тому результат кешується в build_tmp/alpha_ai і
перераховується лише для кадрів, яких ще немає (або з --force).
"""
from __future__ import annotations

import time

import numpy as np
from PIL import Image

from .common import Ctx, frame_path, log, write_gray16


def step(ctx: Ctx, force: bool = False):
    from rembg import new_session, remove

    out = ctx.dir("alpha_ai")
    n = ctx.frame_count()
    todo = [i for i in range(n) if force or not (out / f"{i:03d}.png").exists()]
    if not todo:
        log("α_ai: усі кадри вже в кеші")
        return
    model = ctx.cfg["ai"]["model"]
    try:
        session = new_session(model)
    except Exception as e:  # noqa: BLE001
        model = ctx.cfg["ai"]["fallback_model"]
        log(f"модель недоступна ({e}); запасна: {model}")
        session = new_session(model)
    log(f"α_ai: модель {model}, кадрів до обробки: {len(todo)}")
    t0 = time.time()
    for k, i in enumerate(todo):
        img = Image.open(frame_path(ctx, i)).convert("RGB")
        m = remove(img, session=session, only_mask=True, post_process_mask=False)
        a = np.asarray(m, dtype=np.float32) / 255.0
        write_gray16(out / f"{i:03d}.png", a)
        if k % 10 == 0 or k == len(todo) - 1:
            el = time.time() - t0
            log(f"  кадр {i} ({k + 1}/{len(todo)}), {el / (k + 1):.1f} с/кадр")
    ctx.save_state(ai_model=model)
