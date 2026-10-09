#!/usr/bin/env bash
# Synthetic test media: a still hand photo sliding across a dark frame = a fake "sign".
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p clips
for f in thumbs_up victory pointing_up; do
  [ -s "$f.jpg" ] || curl -fsSL "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/$f.jpg" -o "$f.jpg" \
    || curl -fsSL "https://storage.googleapis.com/mediapipe-assets/$f.jpg" -o "$f.jpg"
done
[ -s woman_hands.jpg ] || curl -fsSL https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg -o woman_hands.jpg
[ -s ano48.wav ] || { espeak-ng -v id -s 130 -w ano.wav "Ano ang sakit?" && ffmpeg -loglevel error -y -i ano.wav -af "adelay=1500,apad=pad_dur=3" -ar 48000 -ac 1 ano48.wav; }
[ -s water48.wav ] || { espeak-ng -v en-us -s 140 -w water.wav "I need water, please." && ffmpeg -loglevel error -y -i water.wav -af "adelay=1500,apad=pad_dur=3" -ar 48000 -ac 1 water48.wav; }

clip() { # img out dx dy scale
  ffmpeg -loglevel error -y -f lavfi -i "color=c=0x202020:s=640x480:r=30:d=2.6" -i "$1" -filter_complex \
    "[1:v]scale=-1:$5[h];[0:v][h]overlay=x='(W-w)/2+($3)*sin(t*2)':y='(H-h)/2+($4)*t':enable='between(t,0.5,2.0)'" \
    -pix_fmt yuv420p -c:v libvpx-vp9 -b:v 600k -deadline realtime "$2"
}

i=0
for v in "0 10 300" "30 -10 320" "-30 20 280"; do
  i=$((i+1))
  set -- $v
  clip thumbs_up.jpg "clips/tulong_0$i.webm" "$1" "$2" "$3"
  clip victory.jpg "clips/sakit_0$i.webm" "$1" "$2" "$3"
  clip pointing_up.jpg "clips/tubig_0$i.webm" "$1" "$2" "$3"
done

# Live fake camera: 1 s empty, 1.5 s tulong-hand, 1.5 s empty, looped by Chrome.
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x202020:s=640x480:r=30:d=4" -i thumbs_up.jpg -filter_complex \
  "[1:v]scale=-1:300[h];[0:v][h]overlay=x='(W-w)/2+15*sin(t*2)':y='(H-h)/2+5*t':enable='between(t,1,2.5)'" \
  -pix_fmt yuv420p cam_tulong.y4m
# An untrained shape (two open hands) for the "hindi kita" test.
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x202020:s=640x480:r=30:d=4" -i woman_hands.jpg -filter_complex \
  "[1:v]scale=-1:420[h];[0:v][h]overlay=x='(W-w)/2+15*sin(t*2)':y='(H-h)/2':enable='between(t,1,2.5)'" \
  -pix_fmt yuv420p cam_unknown.y4m
ls clips cam_tulong.y4m cam_unknown.y4m
