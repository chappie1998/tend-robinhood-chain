#!/usr/bin/env python3
"""Render a narrated video from browser-client captures; never fabricates UI.

Requires macOS say, ffmpeg/ffprobe, and Pillow. Capture directories stay ignored.
Usage: python3 scripts/render-demo.py
"""
import json
import math
from pathlib import Path
import shutil
import subprocess
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs/demo-video"
PUBLIC = ROOT / "web/public/media"
FONT_DIR = Path("/System/Library/Fonts/Supplemental")
FONT = FONT_DIR / "Arial.ttf"
BOLD = FONT_DIR / "Arial Bold.ttf"


def run(args):
    """Use argument arrays: narration/paths never pass through a shell."""
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr[-8000:]}")
    return result.stdout


def duration(path):
    value = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                       "-of", "default=noprint_wrappers=1:nokey=1", str(path)]))
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"Invalid media duration: {path}")
    return value


def timestamp(seconds, separator="."):
    total = round(seconds * 1000)
    hours, rest = divmod(total, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}{separator}{millis:03}"


def wrap_pixels(draw, text, font, width):
    lines = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=font) > width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def overlay(scene, target, caption=None):
    image = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if caption is None:
        draw.rectangle((0, 0, 1920, 106), fill="#0b0e0b")
        draw.text((40, 15), "TEND / MONAD", font=ImageFont.truetype(BOLD, 21), fill="#8fd88c")
        draw.text((1490, 18), scene["tag"], font=ImageFont.truetype(FONT, 16), fill="#aeb6aa")
        draw.text((40, 48), scene["title"], font=ImageFont.truetype(BOLD, 37), fill="#f0f4ed")
        draw.line((40, 100, 1880, 100), fill="#364732", width=2)
        draw.rectangle((0, 900, 1920, 1080), fill="#0b0e0b")
        draw.text((40, 1038), scene["note"], font=ImageFont.truetype(FONT, 22), fill="#9db797")
        draw.text((1700, 1038), "TESTNET", font=ImageFont.truetype(BOLD, 22), fill="#8fd88c")
    else:
        font = ImageFont.truetype(FONT, 35)
        lines = wrap_pixels(draw, caption, font, 1810)
        if len(lines) > 2:
            raise ValueError(f"Caption exceeds two lines: {caption}")
        y = 922 if len(lines) == 2 else 944
        for line in lines:
            width = draw.textlength(line, font=font)
            draw.text(((1920-width)/2, y), line, font=font, fill="#f5f7f2")
            y += 43
    image.save(target)


def main():
    for binary in ("ffmpeg", "ffprobe", "say"):
        if not shutil.which(binary):
            raise RuntimeError(f"Missing dependency: {binary}")
    OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    scenes = json.loads((ROOT / "docs/video/storyboard.json").read_text())
    timeline = []
    elapsed = 0.0
    # Prepare narration first, so the time limit is checked before rendering.
    for number, scene in enumerate(scenes, 1):
        work = OUT / f"scene-{number:02}"
        work.mkdir(exist_ok=True)
        scene["work"] = work
        capture = OUT / "capture" / scene["capture"]
        meta = json.loads((capture / "capture.json").read_text())
        if meta["frames"] < 2 or not 0 < meta["seconds"] < 60:
            raise ValueError(f"Insufficient capture: {capture}")
        scene["capture_path"] = capture
        scene["capture_meta"] = meta
        scene["timings"] = []
        offset = 0.0
        for index, sentence in enumerate(scene["captions"]):
            txt = work / f"voice-{index}.txt"
            audio = work / f"voice-{index}.aiff"
            txt.write_text(sentence)
            run(["say", "-v", "Samantha", "-r", "180", "-f", str(txt), "-o", str(audio)])
            length = duration(audio)
            scene["timings"].append((offset, offset+length, sentence))
            timeline.append((elapsed+offset, elapsed+offset+length, sentence))
            offset += length
        scene["duration"] = math.ceil((offset + .4)*30)/30
        scene["start"] = elapsed
        elapsed += scene["duration"]
        (work / "audio.txt").write_text("".join(f"file 'voice-{i}.aiff'\n" for i in range(len(scene["captions"]))))
        run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", str(work/"audio.txt"),
             "-af", "apad", "-t", str(scene["duration"]), "-ar", "48000", str(work/"voice.wav")])
    if elapsed >= 180:
        raise ValueError(f"Video exceeds hackathon limit: {elapsed:.2f}s")
    print(f"Narration prepared: {elapsed:.2f}s", flush=True)
    for number, scene in enumerate(scenes, 1):
        work = scene["work"]
        capture = scene["capture_path"]
        meta = scene["capture_meta"]
        with Image.open(capture / "00000.jpg") as shot:
            w, h = shot.size
        x, y, cw, ch = scene["crop"]
        if min(x,y) < 0 or cw <= 0 or ch <= 0 or x+cw > w or y+ch > h:
            raise ValueError(f"Crop outside source for {scene['capture']}: {w}x{h}")
        overlay(scene, work/"frame.png")
        args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0b0e0b:s=1920x1080:r=30",
                "-framerate", str(meta["frames"]/meta["seconds"]), "-i", str(capture/"%05d.jpg"),
                "-i", str(work/"voice.wav"), "-loop", "1", "-i", str(work/"frame.png")]
        filters = [f"[1:v]trim=end_frame={meta['frames']},crop={cw}:{ch}:{x}:{y},"
                   "scale=1840:780:force_original_aspect_ratio=decrease,setsar=1,"
                   f"tpad=stop_mode=clone:stop_duration={scene['duration']}[screen]",
                   "[0:v][screen]overlay=(W-w)/2:110+(780-h)/2[app]",
                   "[app][3:v]overlay=0:0[base]"]
        last = "base"
        for index, (start, end, sentence) in enumerate(scene["timings"]):
            layer = work / f"caption-{index}.png"
            overlay(scene, layer, sentence)
            args += ["-loop", "1", "-i", str(layer)]
            output = f"c{index}"
            filters.append(f"[{last}][{index+4}:v]overlay=0:0:enable='gte(t,{start})*lt(t,{end})'[{output}]")
            last = output
        args += ["-filter_complex", ";".join(filters), "-map", f"[{last}]", "-map", "2:a",
                 "-t", str(scene["duration"]), "-c:v", "libx264", "-preset", "fast", "-crf", "21",
                 "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k",
                 "-movflags", "+faststart", str(work/"scene.mp4")]
        run(args)
        print(f"Rendered scene {number}/{len(scenes)}", flush=True)
    (OUT/"scenes.txt").write_text("".join(f"file 'scene-{i:02}/scene.mp4'\n" for i in range(1,len(scenes)+1)))
    target = OUT/"tend-demo.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", str(OUT/"scenes.txt"),
         "-c", "copy", "-movflags", "+faststart", str(target)])
    actual = duration(target)
    if actual >= 180:
        raise ValueError(f"Final file exceeds the time limit: {actual}")
    vtt = "WEBVTT\n\n" + "\n\n".join(f"{timestamp(a)} --> {timestamp(b)}\n{t}" for a,b,t in timeline)
    srt = "\n\n".join(f"{i}\n{timestamp(a, ',')} --> {timestamp(b, ',')}\n{t}" for i,(a,b,t) in enumerate(timeline,1))
    (OUT/"tend-demo.vtt").write_text(vtt+"\n")
    (OUT/"tend-demo.srt").write_text(srt+"\n")
    transcript = "Tend — captured product demonstration\nSeptember 12, 2026\n\n" + "\n\n".join(
        scene["title"]+"\n"+textwrap.fill(" ".join(scene["captions"]), 100) for scene in scenes)
    (OUT/"tend-demo-transcript.txt").write_text(transcript+"\n")
    run(["ffmpeg", "-v", "error", "-y", "-ss", "4", "-i", str(target), "-frames:v", "1", str(OUT/"tend-demo-poster.jpg")])
    for name in ("tend-demo.mp4", "tend-demo.vtt", "tend-demo.srt", "tend-demo-transcript.txt", "tend-demo-poster.jpg"):
        shutil.copy2(OUT/name, PUBLIC/name)
    (OUT/"render-report.json").write_text(json.dumps({"durationSeconds":actual,"width":1920,"height":1080,
        "narration":"macOS Samantha; synthetic narration", "source":"actual browser-client captures",
        "historicalTrade":"position 10; CLI rehearsal; no browser signing staged",
        "scenes":[{"title":s["title"],"start":s["start"],"duration":s["duration"],"capture":s["capture"]} for s in scenes]},indent=2))
    print(f"Ready: {target} ({actual:.2f}s)", flush=True)


if __name__ == "__main__":
    main()
