#!/usr/bin/env bash
# Build the offline translators: Helsinki-NLP OPUS-MT en->tl and tl->en, int8 ONNX for Transformers.js.
# Needs internet once and `uv` (https://docs.astral.sh/uv/). Output: app/models/Helsinki-NLP/opus-mt-*/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/.vendor-tmp"
mkdir -p "$TMP" && cd "$TMP"

# transformers.js 3.8.1 still ships scripts/convert.py and the Marian tokenizer.json generator.
[ -d tfjs ] || git clone -q --depth 1 --branch 3.8.1 https://github.com/huggingface/transformers.js.git tfjs
if [ ! -x mt-venv/bin/python ]; then
  uv venv -q --python 3.12 mt-venv
  uv pip install -q --python mt-venv/bin/python -r tfjs/scripts/requirements.txt
fi
# Newer torch exports via dynamo, which this optimum version can't post-process.
uv pip install -q --python mt-venv/bin/python "torch==2.5.1" sentencepiece

cd tfjs
for m in opus-mt-en-tl opus-mt-tl-en; do
  ../mt-venv/bin/python -m scripts.convert --model_id "Helsinki-NLP/$m" --task text2text-generation-with-past >/dev/null
done
../mt-venv/bin/python "$ROOT/scripts/opus_mt_quantize.py"

for m in opus-mt-en-tl opus-mt-tl-en; do
  src="models/Helsinki-NLP/$m"; dst="$ROOT/app/models/Helsinki-NLP/$m"
  mkdir -p "$dst/onnx"
  cp "$src"/{config.json,generation_config.json,tokenizer.json,tokenizer_config.json} "$dst/"
  cp "$src"/onnx/{encoder_model_quantized,decoder_model_merged_quantized}.onnx "$dst/onnx/"
done
echo "   OPUS-MT -> app/models/Helsinki-NLP/"
