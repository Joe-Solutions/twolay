#!/usr/bin/env bash
# Pre-render the 12 sign words to app/audio/<label>.wav with a LOCAL TTS engine.
# Used by the Boses phone when it has no offline system voice.
#   Piper:     PIPER_MODEL=/path/voice.onnx bash scripts/make_voice.sh
#   espeak-ng: bash scripts/make_voice.sh   (Indonesian voice; Tagalog spelling is phonetic)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app/audio"
mkdir -p "$OUT"

WORDS="oo:Oo hindi:Hindi kumusta:Kumusta tubig:Tubig pagkain:Pagkain tulong:Tulong
sakit:Sakit banyo:Banyo salamat:Salamat sandali:Sandali tama:Tama mali:Mali"

if [ -n "${PIPER_MODEL:-}" ] && command -v piper >/dev/null; then
  ENGINE="piper ($PIPER_MODEL)"
  say_word() { echo "$2" | piper --model "$PIPER_MODEL" --output_file "$1" >/dev/null 2>&1; }
elif command -v espeak-ng >/dev/null; then
  ENGINE="espeak-ng -v id"
  say_word() { espeak-ng -v id -s 135 -p 45 -w "$1" "$2"; }
else
  echo "no local TTS engine found (install espeak-ng or piper)" >&2; exit 1
fi

for pair in $WORDS; do
  say_word "$OUT/${pair%%:*}.wav" "${pair#*:}"
done
echo "$ENGINE" > "$OUT/ENGINE.txt"
echo "   12 clips via $ENGINE -> app/audio/"
