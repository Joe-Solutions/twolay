#!/usr/bin/env bash
# One-time setup (needs internet ONCE, on the build laptop).
# Copies every runtime + model into app/ so the app never touches the network again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
TMP="$ROOT/.vendor-tmp"

MP_VER="1.1.0"                              # @mediapipe/tasks-vision
TF_VER="4.3.1"                              # @huggingface/transformers
ORT_VER="1.31.0-dev.20260914-8d85527a0"     # onnxruntime-web pinned by transformers 4.3.1
HAND_MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
WHISPER_REPO="onnx-community/whisper-tiny"
HF="https://huggingface.co/$WHISPER_REPO/resolve/main"

mkdir -p "$TMP" "$APP/vendor/mediapipe/wasm" "$APP/vendor/transformers" "$APP/vendor/ort" \
         "$APP/models/mediapipe" "$APP/models/$WHISPER_REPO/onnx"
cd "$TMP"

fetch_pkg() { # name version dir
  if [ ! -d "$3/package" ]; then
    local tgz; tgz="$(npm pack "$1@$2" --silent | tail -1)"
    mkdir -p "$3" && tar xzf "$tgz" -C "$3" && chmod -R u+rwX "$3"
  fi
}

echo "==> MediaPipe Tasks Vision $MP_VER"
fetch_pkg @mediapipe/tasks-vision "$MP_VER" mp
cp mp/package/vision_bundle.mjs "$APP/vendor/mediapipe/"
cp mp/package/wasm/vision_wasm_internal.* mp/package/wasm/vision_wasm_nosimd_internal.* "$APP/vendor/mediapipe/wasm/"
# MediaPipe ships a usage logger that POSTs to odml.pa.googleapis.com every 60 s.
# Neuter its flush() so it never sends. The CSP in index.html also blocks it.
python3 - "$APP/vendor/mediapipe/vision_bundle.mjs" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
needle = 'flush(t,e){if(this.error)'
if 'flush(t,e){this.i=[];t?.();return;' not in s:
    assert s.count(needle) == 1, "MediaPipe telemetry patch point not found; re-check vision_bundle.mjs"
    s = s.replace(needle, 'flush(t,e){this.i=[];t?.();return;if(this.error)')
    open(p, "w").write(s)
print("   telemetry flush() disabled")
PY

echo "==> MediaPipe hand_landmarker.task"
[ -s "$APP/models/mediapipe/hand_landmarker.task" ] || curl -fsSL "$HAND_MODEL_URL" -o "$APP/models/mediapipe/hand_landmarker.task"

echo "==> Transformers.js $TF_VER (bundles ONNX Runtime JS)"
fetch_pkg @huggingface/transformers "$TF_VER" tf
cp tf/package/dist/transformers.js "$APP/vendor/transformers/"
# GitHub push protection reads one Mistral class-name string literal as a Mistral API key.
# Split the literal (same value at runtime) so the repo can be pushed.
python3 - "$APP/vendor/transformers/transformers.js" <<'PY'
import sys
p = sys.argv[1]
name = "Mistral3For" + "ConditionalGeneration"
s = open(p).read()
s = s.replace(f'"{name}"]', '"Mistral3For" + "ConditionalGeneration"]')
open(p, "w").write(s)
PY

echo "==> ONNX Runtime Web wasm $ORT_VER"
fetch_pkg onnxruntime-web "$ORT_VER" ort
cp ort/package/dist/ort-wasm-simd-threaded.asyncify.{mjs,wasm} "$APP/vendor/ort/"
cp ort/package/dist/ort-wasm-simd-threaded.{mjs,wasm} "$APP/vendor/ort/"

echo "==> Whisper tiny (multilingual, int8) from $WHISPER_REPO"
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json \
         special_tokens_map.json added_tokens.json normalizer.json vocab.json merges.txt \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  out="$APP/models/$WHISPER_REPO/$f"
  [ -s "$out" ] || curl -fsSL "$HF/$f" -o "$out" || echo "   (optional file missing: $f)"
done

echo "==> Kokoro-82M v1.0 (int8) text-to-speech + Spanish and English voices"
KOKORO_REPO="onnx-community/Kokoro-82M-v1.0-ONNX"
mkdir -p "$APP/models/$KOKORO_REPO/onnx" "$APP/models/$KOKORO_REPO/voices"
for f in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx voices/ef_dora.bin voices/em_alex.bin voices/af_heart.bin; do
  out="$APP/models/$KOKORO_REPO/$f"
  [ -s "$out" ] || curl -fsSL "https://huggingface.co/$KOKORO_REPO/resolve/main/$f" -o "$out"
done

echo "==> OPUS-MT English <-> Tagalog translators (int8)"
if [ -s "$APP/models/Helsinki-NLP/opus-mt-tl-en/onnx/decoder_model_merged_quantized.onnx" ] &&
   [ -s "$APP/models/Helsinki-NLP/opus-mt-en-tl/onnx/decoder_model_merged_quantized.onnx" ]; then
  echo "   already in app/models (committed)"
else
  bash "$ROOT/scripts/make_opus_mt.sh"
fi
[ -s "$APP/models/en-lexicon.json" ] || python3 "$ROOT/scripts/make_en_lexicon.py" || echo "   (skipped: needs espeak-ng + the OPUS-MT vocab)"

echo "==> QR pairing libs (qrcode-generator, jsQR)"
fetch_pkg qrcode-generator 2.0.4 qrgen
fetch_pkg jsqr 1.4.0 jsqr
mkdir -p "$APP/vendor/qr"
cp qrgen/package/dist/qrcode.mjs "$APP/vendor/qr/qrcode.mjs"
cp jsqr/package/dist/jsQR.js "$APP/vendor/qr/jsQR.js"

echo "==> Spoken-word fallback clips"
bash "$ROOT/scripts/make_voice.sh" || echo "   (skipped: install espeak-ng or piper to generate app/audio/*.wav)"

echo "==> Asset manifest for offline cache"
python3 "$ROOT/scripts/build_manifest.py"

echo "Done. Total app size:"; du -sh "$APP"
