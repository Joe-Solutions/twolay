# Third-party components shipped in `app/`

| Component | Path | License |
|---|---|---|
| MediaPipe Tasks Vision 1.1.0 (telemetry flush disabled by `scripts/vendor.sh`) | `app/vendor/mediapipe/` | Apache-2.0 |
| MediaPipe Hand Landmarker model | `app/models/mediapipe/hand_landmarker.task` | Apache-2.0 |
| MediaPipe Pose Landmarker lite model | `app/models/mediapipe/pose_landmarker_lite.task` | Apache-2.0 |
| Silero VAD v5 (ONNX, via onnx-community) | `app/models/onnx-community/silero-vad/` | MIT |
| Transformers.js 4.3.1 | `app/vendor/transformers/` | Apache-2.0 |
| ONNX Runtime Web 1.31.0-dev | `app/vendor/ort/` | MIT |
| OpenAI Whisper tiny (ONNX export by onnx-community) | `app/models/onnx-community/whisper-tiny/` | MIT |
| Kokoro-82M v1.0 by hexgrad (int8 ONNX export by onnx-community), voices `ef_dora`, `em_alex`, `af_heart` | `app/models/onnx-community/Kokoro-82M-v1.0-ONNX/` | Apache-2.0 |
| Helsinki-NLP OPUS-MT `opus-mt-en-tl`, `opus-mt-tl-en` (Tiedemann & Thottingal, OPUS-MT, EAMT 2020), converted to int8 ONNX by `scripts/make_opus_mt.sh` | `app/models/Helsinki-NLP/` | Apache-2.0 |
| Word clips rendered with espeak-ng (the tool is GPL-3.0; it is not shipped, only its audio output) | `app/audio/`, `app/models/en-lexicon.json` (English IPA for 10k words) | — |

All files are unmodified upstream releases except two one-line patches in `scripts/vendor.sh`: the MediaPipe telemetry patch, and splitting one Mistral class-name string literal in Transformers.js (GitHub secret scanning misreads it as an API key; the value is unchanged).

## Training data

| Data | Path | License |
|---|---|---|
| FSL-105: The Video Filipino Sign Language Sign Database of Introductory 105 FSL Signs (I. J. L. Tupal, M. K. Cabatuan). Clips for YES, NO, HOW ARE YOU, THANK YOU, CORRECT, WRONG, HELLO, GOOD MORNING, YOURE WELCOME, UNDERSTAND, DON’T UNDERSTAND were converted to hand-landmark sequences and one 480p playback clip per sign. https://data.mendeley.com/datasets/48y2y99mb9/2 | `app/packs/fsl105.json`, `app/clips/*.mp4` | CC BY 4.0 |
