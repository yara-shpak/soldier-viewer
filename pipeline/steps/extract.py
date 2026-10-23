"""4.2 Розкладання відео на кадри (PNG без втрат, без зміни fps і розміру)."""
from __future__ import annotations

import json
import shutil
import subprocess

from .common import Ctx, list_files, log, run


def probe(path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt,nb_read_frames,duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {
        "codec": s["codec_name"], "width": int(s["width"]), "height": int(s["height"]),
        "fps": float(num) / float(den), "pix_fmt": s["pix_fmt"],
        "frames": int(s["nb_read_frames"]), "duration": float(s.get("duration", 0)),
    }


def step(ctx: Ctx):
    info = probe(ctx.video)
    log(f"відео: {info['codec']} {info['width']}×{info['height']} {info['fps']:g} fps, "
        f"{info['frames']} кадрів, {info['pix_fmt']}")
    out = ctx.tmp / "frames"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    run(["ffmpeg", "-v", "error", "-i", str(ctx.video), "-vsync", "0",
         "-start_number", "0", str(out / "%03d.png")])
    n = len(list_files(out, "*.png"))
    if n != info["frames"]:
        log(f"увага: ffprobe каже {info['frames']} кадрів, витягнуто {n}")
        info["frames"] = n
    ctx.save_state(video=info)
    log(f"витягнуто {n} кадрів → {out}")
