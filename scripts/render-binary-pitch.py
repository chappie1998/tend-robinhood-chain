#!/usr/bin/env python3
"""Render the current, fact-bound Tend founder-pitch draft without network access.

Writes only gitignored outputs/demo-video/binary-pitch/. This renderer makes
motion-graphic cards, never synthetic product UI or wallet confirmations.
"""
import json
import math
import shutil
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
STORYBOARD = ROOT / "docs/video/binary-pitch-storyboard.json"
OUT = ROOT / "outputs/demo-video/binary-pitch"
WIDTH, HEIGHT, FPS = 1920, 1080, 30
FONT_DIR = Path("/System/Library/Fonts/Supplemental")
REGULAR = FONT_DIR / "Arial.ttf"
BOLD = FONT_DIR / "Arial Bold.ttf"
BG, PANEL, GREEN, MINT, TEXT, MUTED = "#07110d", "#0d2119", "#54e08a", "#b6f6c9", "#f2fff6", "#9ab4a2"


def run(args):
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr[-4000:]}")
    return result.stdout


def media_duration(path):
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


def font(path, size):
    return ImageFont.truetype(path, size)


def wrap(draw, value, face, maximum):
    lines, current = [], ""
    for word in value.split():
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=face) > maximum:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def draw_lines(draw, lines, x, y, face, fill, leading):
    for line in lines:
        draw.text((x, y), line, font=face, fill=fill)
        y += leading


def card_frame(scene, target):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    # Deliberately abstract market motion graphics; these do not depict the app.
    for x in range(-100, WIDTH + 100, 86):
        draw.line((x, 0, x + 420, HEIGHT), fill="#0a2d20", width=1)
    draw.rectangle((0, 0, WIDTH, 14), fill=GREEN)
    eyebrow = font(BOLD, 24)
    title = font(BOLD, 68)
    body = font(REGULAR, 31)
    badge = font(BOLD, 25)
    draw.text((96, 84), scene["eyebrow"], font=eyebrow, fill=GREEN)
    title_lines = wrap(draw, scene["title"], title, 1430)
    draw_lines(draw, title_lines, 96, 137, title, TEXT, 82)
    cards = scene["cards"]
    top = 372 if len(title_lines) == 1 else 452
    gap = 22
    available = WIDTH - 192 - (len(cards) - 1) * gap
    card_width = available // len(cards)
    for index, value in enumerate(cards):
        x = 96 + index * (card_width + gap)
        draw.rounded_rectangle((x, top, x + card_width, top + 210), radius=24, fill=PANEL, outline="#23633e", width=2)
        number = f"{index + 1:02}"
        draw.text((x + 28, top + 25), number, font=font(BOLD, 18), fill=GREEN)
        lines = wrap(draw, value, badge, card_width - 56)
        y = top + 83 - max(0, len(lines) - 1) * 17
        draw_lines(draw, lines, x + 28, y, badge, MINT, 38)
    # Captions occupy the lower third while narration is active. Keep the
    # disclosure/footer above that band so it remains visible in every frame.
    draw.line((96, 680, WIDTH - 96, 680), fill="#26563d", width=2)
    draw.text((96, 714), scene["footer"], font=body, fill=MUTED)
    draw.text((WIDTH - 270, 714), "TESTNET DRAFT", font=font(BOLD, 24), fill=GREEN)
    image.save(target)


def caption_frame(text, target):
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    face = font(BOLD, 40)
    lines = wrap(draw, text, face, 1640)
    if len(lines) > 3:
        raise ValueError(f"Caption exceeds three lines: {text}")
    height = 50 * len(lines) + 50
    y0 = HEIGHT - height - 50
    draw.rounded_rectangle((86, y0, WIDTH - 86, HEIGHT - 50), radius=20, fill=(2, 10, 6, 230))
    y = y0 + 26
    for line in lines:
        width = draw.textlength(line, font=face)
        draw.text(((WIDTH - width) / 2, y), line, font=face, fill=TEXT)
        y += 50
    image.save(target)


def prepare_scene(scene, number, timeline, elapsed):
    work = OUT / f"scene-{number:02}"
    work.mkdir(parents=True, exist_ok=True)
    card_frame(scene, work / "card.png")
    timings, offset = [], 0.0
    for index, phrase in enumerate(scene["captions"]):
        text_path, audio = work / f"voice-{index}.txt", work / f"voice-{index}.aiff"
        text_path.write_text(phrase + "\n")
        run(["say", "-v", "Samantha", "-r", "178", "-f", str(text_path), "-o", str(audio)])
        length = media_duration(audio)
        timings.append((offset, offset + length, phrase))
        timeline.append((elapsed + offset, elapsed + offset + length, phrase))
        caption_frame(phrase, work / f"caption-{index}.png")
        offset += length
    scene_duration = math.ceil((offset + 0.65) * FPS) / FPS
    (work / "audio.txt").write_text("".join(f"file 'voice-{i}.aiff'\n" for i in range(len(scene["captions"]))))
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", str(work / "audio.txt"),
         "-af", "apad", "-t", str(scene_duration), "-ar", "48000", str(work / "voice.wav")])
    return work, timings, scene_duration


def render_scene(work, timings, scene_duration):
    args = ["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(work / "card.png"),
            "-i", str(work / "voice.wav")]
    for index in range(len(timings)):
        args += ["-loop", "1", "-i", str(work / f"caption-{index}.png")]
    filters = ["[0:v]zoompan=z='min(1.045,zoom+0.00035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30[base]"]
    previous = "base"
    for index, (start, end, _) in enumerate(timings):
        output = f"caption{index}"
        filters.append(f"[{previous}][{index + 2}:v]overlay=0:0:enable='between(t,{start},{end})'[{output}]")
        previous = output
    args += ["-filter_complex", ";".join(filters), "-map", f"[{previous}]", "-map", "1:a", "-t", str(scene_duration),
             "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(work / "scene.mp4")]
    run(args)


def main():
    for binary in ("ffmpeg", "ffprobe", "say"):
        if not shutil.which(binary):
            raise RuntimeError(f"Missing dependency: {binary}")
    if not REGULAR.exists() or not BOLD.exists():
        raise RuntimeError("Expected macOS Arial fonts are unavailable.")
    storyboard = json.loads(STORYBOARD.read_text())
    scenes = storyboard["scenes"]
    OUT.mkdir(parents=True, exist_ok=True)
    timeline, elapsed, prepared = [], 0.0, []
    for number, scene in enumerate(scenes, 1):
        work, timings, scene_duration = prepare_scene(scene, number, timeline, elapsed)
        prepared.append((work, timings, scene_duration))
        elapsed += scene_duration
    if elapsed >= 120:
        raise ValueError(f"Draft exceeds two minutes: {elapsed:.2f}s")
    for work, timings, scene_duration in prepared:
        render_scene(work, timings, scene_duration)
    (OUT / "scenes.txt").write_text("".join(f"file 'scene-{i:02}/scene.mp4'\n" for i in range(1, len(scenes) + 1)))
    target = OUT / "tend-binary-founder-pitch-draft.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", str(OUT / "scenes.txt"),
         "-c", "copy", "-movflags", "+faststart", str(target)])
    actual = media_duration(target)
    if actual >= 120:
        raise ValueError(f"Final draft exceeds two minutes: {actual:.2f}s")
    srt = "\n\n".join(f"{i}\n{timestamp(start, ',')} --> {timestamp(end, ',')}\n{text}"
                      for i, (start, end, text) in enumerate(timeline, 1))
    (OUT / "tend-binary-founder-pitch-draft.srt").write_text(srt + "\n")
    transcript = f"{storyboard['title']}\n{storyboard['status']}\n\n" + "\n\n".join(
        f"{scene['eyebrow']}\n{scene['title']}\n" + textwrap.fill(" ".join(scene["captions"]), 96)
        for scene in scenes)
    (OUT / "tend-binary-founder-pitch-draft-transcript.txt").write_text(transcript + "\n")
    run(["ffmpeg", "-v", "error", "-y", "-ss", "4", "-i", str(target), "-frames:v", "1",
         str(OUT / "tend-binary-founder-pitch-draft-poster.jpg")])
    (OUT / "render-report.json").write_text(json.dumps({
        "status": "DRAFT — local only, not uploaded or submitted",
        "durationSeconds": actual, "width": WIDTH, "height": HEIGHT, "fps": FPS,
        "narration": "macOS Samantha synthetic voice", "source": "fact-bound motion graphics; no app or wallet UI",
        "scenes": [{"id": scene["id"], "title": scene["title"]} for scene in scenes],
    }, indent=2) + "\n")
    print(f"Rendered draft: {target} ({actual:.2f}s)")


if __name__ == "__main__":
    main()
