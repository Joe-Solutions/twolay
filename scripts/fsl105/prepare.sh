#!/usr/bin/env bash
# Download FSL-105 (CC BY 4.0; adult Deaf FSL signers, reviewed by an FSL expert) and extract the
# clips for the Twolay signs it covers. Output in $WORK:
#   webm/<label>_<n>.webm   15 fps copies for landmark extraction (Chromium-decodable)
#   mp4/<label>.mp4         one H.264 clip per sign for playback on the Deaf user's screen
set -euo pipefail
WORK="${WORK:-/tmp/fsl105}"
BASE="https://prod-dcd-datasets-public-files-eu-west-1.s3.eu-west-1.amazonaws.com"
mkdir -p "$WORK" && cd "$WORK"

[ -s train.csv ] || curl -fsSL -o train.csv "$BASE/09c71779-3a2a-4c98-8d9b-0ef74f54d92a"
[ -s test.csv ]  || curl -fsSL -o test.csv  "$BASE/39af8117-6b44-47b9-a551-0bdc40837295"
[ -s clips.zip ] || curl -fsSL -o clips.zip "$BASE/de95a3c3-02f4-4a3f-9a9e-ce2371160275"

python3 - <<'PY'
import csv, subprocess, zipfile, os, pathlib
MAP = {"YES": "oo", "NO": "hindi", "HOW ARE YOU": "kumusta",
       "THANK YOU": "salamat", "CORRECT": "tama", "WRONG": "mali",
       "HELLO": "hello", "GOOD MORNING": "magandang-umaga",
       "YOURE WELCOME": "walang-anuman",
       "UNDERSTAND": "naiintindihan", "DON’T UNDERSTAND": "hindi-maintindihan"}
rows = [r for f in ("train.csv", "test.csv") for r in csv.DictReader(open(f, encoding="utf-8-sig"))]
z = zipfile.ZipFile("clips.zip")
names = {n.replace("\\", "/").lower(): n for n in z.namelist()}
pathlib.Path("webm").mkdir(exist_ok=True)
pathlib.Path("mp4").mkdir(exist_ok=True)
pathlib.Path("raw").mkdir(exist_ok=True)
count = {}
for r in rows:
    label = MAP.get(r["label"].strip())
    if not label:
        continue
    key = r["vid_path"].replace("\\", "/").lower()
    member = names.get(key) or next((names[k] for k in names if k.endswith(key)), None)
    if not member:
        print("missing", key); continue
    n = count[label] = count.get(label, 0) + 1
    raw = f"raw/{label}_{n:02d}{os.path.splitext(member)[1].lower()}"
    if not os.path.exists(raw):
        with z.open(member) as src, open(raw, "wb") as dst:
            dst.write(src.read())
    out = f"webm/{label}_{n:02d}.webm"
    if not os.path.exists(out):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-an", "-vf", "scale=640:-2,fps=15",
                        "-c:v", "libvpx-vp9", "-b:v", "900k", "-deadline", "realtime", out], check=True)
    if n == 1:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-an", "-vf", "scale=480:-2,fps=24",
                        "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-crf", "28",
                        "-movflags", "+faststart", f"mp4/{label}.mp4"], check=True)
print(count)
PY
