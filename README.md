# Twolay

**Twolay** (from *tulay*, "bridge": a bridge between two people) is a fully offline conversation app between a **Deaf**
person who signs and a **Blind** person who speaks, on **one phone**.

The Blind person holds the phone with the rear camera pointed at the Deaf signer:

```
Deaf person signs "tulong" ─▶ camera ─▶ MediaPipe Hands + Pose ─▶ sign kNN ─▶ caption + voice says "Tulong"
Deaf person reads "Ano ang sakit?" + SAKIT clip ◀─ Whisper tiny ◀─ Blind person presses Magsalita, says "Ano ang sakit?"

English mode (⚙ → Wika, translated offline by OPUS-MT):
signs "salamat" ─▶ "Salamat — thank you", English voice says "Thank you"
reads "Kailangan ko ng tubig" + TUBIG clip ◀─ OPUS-MT en→tl ◀─ Whisper (English) ◀─ says "I need water"
```

- One screen, **Usap**. The camera watches all the time: each sign is detected on its own (no button), shown as a
  big caption and **read aloud** with the offline voice, so the Blind person hears it.
- One big button, **Magsalita**, for the Blind person to reply. The Deaf person reads the transcript on the same
  screen and sees the matching sign clip.
- Everything runs on the phone: hand and body tracking, sign classifier, voice detection, speech-to-text, translation,
  text-to-speech. Nothing is sent anywhere, so it works in airplane mode.
- Rear camera by default; **↺ Camera** switches to the front camera (e.g. a laptop webcam, or a signer alone).

## Models and engines (full disclosure)

| Job | Model / engine | Size | Runs |
|---|---|---|---|
| Hand tracking | MediaPipe Hand Landmarker `hand_landmarker.task` (float16) + MediaPipe Tasks Vision 1.1.0 wasm (SIMD and no-SIMD builds) | 7.8 MB + 25 MB | phone, wasm (GPU→CPU fallback) |
| Body position | MediaPipe Pose Landmarker **lite** `pose_landmarker_lite.task` (float16, Apache-2.0): nose + shoulders, so each hand's wrist and index tip are measured from the face in shoulder widths (chin vs chest vs side). About 11 ms per frame on CPU, run ~15×/s on the live camera | 5.8 MB | phone, wasm (CPU) |
| Sign → word | Twolay nearest-neighbour classifier over 12-frame landmark sequences (hand shape + position relative to the body), mirror-augmented, with a distance + ratio rejection (`app/js/classifier.js`). When both takes have the body, the hand's position in the camera image is ignored, so holding the phone closer or off-center doesn't matter. Ships pre-trained on 11 signs from the FSL-105 dataset (Deaf signers, CC BY 4.0); the team adds the rest in-app. | 3 MB pack + IndexedDB | phone, JS |
| Speech start / end | **Silero VAD v5** (ONNX, MIT) in a worker: speech probability every 32 ms. Recording starts counting only on real voice and stops after 0.9 s of silence; fans, traffic and room noise are ignored, so Whisper never runs on noise (where it invents words). Leading silence is trimmed before Whisper. Falls back to a loudness check if it can't load | 2.2 MB | phone, Web Worker |
| Speech → text | OpenAI Whisper **tiny** multilingual, int8 ONNX (`onnx-community/whisper-tiny`), Transformers.js 4.3.1 + ONNX Runtime Web 1.31 wasm, language forced to Tagalog (English when the language is set to English) | 43 MB + 39 MB runtime | phone, Web Worker |
| Translation English ↔ Filipino | **Helsinki-NLP OPUS-MT** `opus-mt-en-tl` and `opus-mt-tl-en` (Marian, ~75M params each, Apache-2.0), converted to ONNX and int8-quantized by `scripts/make_opus_mt.sh`, run with the Transformers.js `translation` pipeline in a worker. Used only when the language is set to **English**: speech is transcribed in English and translated to Filipino for the signer; signs are voiced in English (built-in signs use their fixed English, added words go through tl→en). About 50–400 ms per phrase on a laptop | 2 × 134 MB | phone, Web Worker |
| Text → sign | Keyword table for Filipino + Taglish, one-typo tolerant (`app/js/signs.js`) | — | phone |
| Text → voice | **Kokoro-82M v1.0** (hexgrad, Apache-2.0), int8 ONNX via Transformers.js in a worker, Spanish voice `ef_dora` for Filipino, American voice `af_heart` for English. English IPA comes from `app/models/en-lexicon.json` (10k words pre-phonemized with espeak-ng at build time); a sentence with an unknown word uses an on-device English system voice instead, if there is one. Kokoro has no Filipino voice, so `app/js/tl-g2p.js` turns Tagalog spelling into IPA (letter rules, penultimate stress, a short final-stress word list). About 1–3 s per phrase on a laptop. Until it has loaded, or if it fails: an on-device Filipino system voice (`speechSynthesis`, `localService` only), then 17 clips pre-rendered with **espeak-ng** in `app/audio/` | 92 MB + 1 MB + 0.25 MB | phone / laptop, wasm |
| Sign playback | FSL-105 clips for the 11 starter signs (`app/clips/`), plus clips the team records | 0.5 MB | phone |

Not used anywhere: cloud STT/TTS, sign-language APIs, generated avatars, API keys, uploads.

**Telemetry removed.** MediaPipe Tasks Vision 1.1.0 contains a usage logger that POSTs to
`odml.pa.googleapis.com` every 60 s. `scripts/vendor.sh` patches it out, the page's
Content-Security-Policy (`connect-src 'self' blob: data:`) would block it anyway, and the in-app
guard logs any blocked attempt in the Network log.

## Run it

Needs only **Python 3** and **Chrome or Edge**. All models are already in the repo, so nothing is downloaded at run time.

```bash
git clone https://github.com/Joe-Solutions/twolay.git
cd twolay
python3 scripts/serve.py   # or: npm start   ->  http://localhost:8000
```

Open `http://localhost:8000`, train the signs (next section), then follow the **Demo script**.
Wi-Fi can be off from this point on.

### Re-downloading the models (optional)

Only needed to upgrade a model or rebuild `app/vendor`, `app/models` or `app/audio` from scratch (needs internet and Node):

```bash
brew install espeak-ng   # for the spoken word clips in app/audio
npm run setup            # MediaPipe, Whisper tiny, ONNX Runtime -> app/; renders app/audio
```

Rebuilding the OPUS-MT translators (`scripts/make_opus_mt.sh`, only run when they are missing) also needs
[`uv`](https://docs.astral.sh/uv/); it creates a Python 3.12 venv in `.vendor-tmp/`.

After you change any file in `app/`, run `npm run manifest` so installed phones pick up the new version.

## Train the signs

### Starter pack: 11 signs work out of the box

`app/packs/fsl105.json` is pre-trained from **FSL-105**, a dataset of introductory Filipino Sign Language
signs performed by adult Deaf FSL signers and reviewed by an FSL expert (CC BY 4.0). It covers:

| Twolay sign | FSL-105 sign | Takes |
|---|---|---|
| oo | YES | 20 |
| hindi | NO | 21 |
| kumusta | HOW ARE YOU | 21 |
| salamat | THANK YOU | 20 |
| tama | CORRECT | 22 |
| mali | WRONG | 21 |
| hello | HELLO | 20 |
| magandang umaga | GOOD MORNING | 20 |
| walang anuman | YOURE WELCOME | 20 |
| naiintindihan | UNDERSTAND | 20 |
| hindi ko maintindihan | DON’T UNDERSTAND | 21 |

5-fold cross-validation on held-out takes (`npm run eval:pack`): **88% correct, under 1% wrong, 12% "hindi kita"**
(hand shape only: 87% / 13%). Per sign: 75% (oo) to 100% (salamat). Body position helps the weakest signs most:
*tama* 68% → 86%, *naiintindihan* 75% → 90%. `BODY_WEIGHTS=0,8,12 npm run eval:pack` compares weights, `SHIFT=1`
re-frames the held-out takes (signer further away and off-center). GOOD AFTERNOON and GOOD EVENING were tried and left out: they share the
"good" movement and were confused with each other (29% / 41% correct).
The same signers appear in training and test folds, so expect lower accuracy on a new person.

Each of these also has a playback clip of a Deaf signer in `app/clips/`. The pack can be turned off in
⚙ → Turuan. Rebuild it with `npm run build:pack`.

The dataset framing (full upper body, blue background) differs from a selfie camera, so add 3–5 of your own
takes per sign for the best accuracy. Keep your **face and both shoulders in the frame** (blue dots on the nose and
shoulders show the body was found). Takes recorded before body tracking still work, compared on hand shape only;
re-record them to get the location benefit.

### The other 6 signs need a signer

FSL-105 has no **tubig, pagkain, tulong, sakit, banyo, sandali** (nor goodbye, ako, ikaw), and the demo script uses
*tulong* and *sakit*. No other openly licensed FSL word-video dataset was found for them.
Record these from someone who knows FSL, ideally a Deaf signer. Do not make up gestures: judges and Deaf users
will see them as FSL. Places to learn or confirm them: the University of the Philippines OSDS *Basic Filipino
Sign Language* video series, the FSL Buddy app (De La Salle-College of Saint Benilde), and TulaySenyas
(health signs, including *sakit*). Check each sign there before recording; this repo has not verified them.

### Recording your own takes

All training data stays on the device (IndexedDB). Two ways to train; both feed the same classifier.

1. **Record live, Turuan screen:** on the home screen tap **Turuan** (Train FSL), or ⚙ → Turuan →
   *Buksan ang Turuan*. Or open `http://localhost:8000/?screen=train` directly.
   - The chips at the bottom list all 17 signs with your takes (`n/5`) and any FSL-105 samples. Green ✓ = enough.
   - Left: an example of the sign (FSL-105 clip, or your own first take). Right: your camera with the hand skeleton.
   - Tap **I-record** (or Space). After the 3-2-1 beeps, sign once, then drop your hands. That's one take.
   - If a take looks like a different sign, the status line warns you ("kahawig ito ng …").
   - **Bawiin ang huling take** removes a bad take. **Burahin ang takes nito** clears that sign.
   - **Burahin ang halimbawa** deletes the example clip (your saved one, and hides a shipped FSL-105 one); your
     next take becomes the new example. **Ibalik ang FSL-105 halimbawa** brings the shipped clip back.
   - **Subukan** signs once without saving and shows what Twolay recognises.
   - After 5 takes it moves on to the next unfinished sign. The first take of a sign without a clip becomes
     its playback clip on the Usap screen.
   - **Your own words:** type a word under the chips (e.g. `gutom`) and tap **＋ Idagdag**. It becomes a new
     sign (dashed chip) to record like the others. When spoken, it triggers only when that exact word or
     phrase is heard, and it wins over a built-in synonym (`gutom` → your sign, not *pagkain*).
     **Tanggalin ang salitang ito** removes the word and its takes. Built-in signs can't be removed, only their takes.
     Packs carry the words too.
2. **Import the team's clips:** ⚙ → Turuan → *I-import ang video clips*. File names start with the sign:
   `tulong_01.mp4`, `sakit-2.mov`, `salamat 3.mp4`.

The ⚙ → Turuan tab shows samples per sign, whether a clip exists, and a leave-one-out self-test score.
**Export pack** / **Import pack** copies the trained set and clips to another phone or the demo laptop as one JSON file.

Unknown or unclear signs show **"hindi kita"** with a short error tone, and are not read out as a word. Two checks reject them: the distance
must be within the threshold learned from the training data, and the best sign must clearly beat the runner-up.

## Language: Filipino or English

Set it in ⚙ → **Wika**, or with the **Wika** menu on the Usap screen. Default is **Filipino** (nothing is translated).

With **English**:

| Direction | What happens |
|---|---|
| Blind person speaks | Whisper transcribes in English → OPUS-MT en→tl translates → the screen shows the Filipino text and the matching sign. The history keeps the English original. Sign lookup checks both texts, so "water" still finds *tubig* if the translation drifts. |
| Deaf person signs | The screen shows `Salamat — thank you` and the English is said with Kokoro's `af_heart` voice. Built-in signs use a fixed English meaning; added words go through OPUS-MT tl→en. |

The translators load in the background when English is chosen (134 MB each, a few seconds on a laptop).
If a translation fails, the original English text is shown unchanged.

## Install on a phone (offline)

Camera, mic and offline caching need HTTPS.

**Easiest: the hosted copy.** Every push to `main` publishes `app/` to
**https://joe-solutions.github.io/twolay/** (`.github/workflows/pages.yml`). On the phone, with internet once:
open the link → ⚙ → **Offline** → *I-save ang buong app para offline* (about 500 MB, use Wi-Fi) → wait for **Handa offline ✓** →
Add to Home Screen (iPhone: Share; Android Chrome: menu → Install app). After that it runs with Wi-Fi and data off.
After a new version is published, open the app online once and save for offline again.
The site only serves the app and model files; nothing the phones see or hear is uploaded.

**Without internet: serve from the laptop.** Use a trusted local cert:

```bash
brew install mkcert
npm run cert                      # prints the rootCA.pem to install + trust on each phone
npm run start:lan                 # https://<laptop-ip>:8443
```

On the phone (laptop on the same Wi-Fi or hotspot): open the URL → ⚙ → **Offline** →
*I-save ang buong app para offline* → wait for **Handa offline ✓** → Share → *Add to Home Screen*.
After that the laptop is not needed. Import the training pack (⚙ → Turuan → Import pack).

Alternative: put `app/` on any static HTTPS host you control and open it once on the phone. That download
only contains the app and models; no user audio, video or text is ever sent.

## Demo script

Two people, one phone (or one laptop). Train or import *tulong* first (see **Train the signs**).

- **Where:** the phone with Twolay saved for offline (or **https://joe-solutions.github.io/twolay/**), Chrome
  (Android) or Safari (iPhone). Turn on **airplane mode** first. On a laptop: `http://localhost:8000` in Chrome
  or Edge, Wi-Fi off, and tap **↺ Camera** if the webcam faces you.
- **Start:** tap **Simulan**, allow the camera and the mic. The Blind person holds the phone, rear camera pointed at
  the Deaf signer, about 1–2 m away with the signer's **face and shoulders in the frame**.
  Expected: status "Nakatutok. Hinihintay ang sign…"; the button goes from "Naglo-load NN%" to **Magsalita**.
- **Step 1:** the Deaf person signs **tulong**, then drops their hands. Nobody presses anything.
  Expected: the hand skeleton appears, status "Nagsa-sign…", then the big caption **🤟 Sign · Tulong**, status
  "Tulong — NN%", and the phone says **"Tulong"** aloud. An unclear sign shows "hindi kita" with a low tone.
- **Step 2:** the Blind person presses **Magsalita** (or Space on a laptop) and says **"Ano ang sakit?"**, then
  stops talking. Expected: the button turns red ("Nakikinig…"), stops by itself after the speech, shows
  "Isinusulat…" for 1–3 s; then the caption **🗣 Boses · Ano ang sakit?** and the **SAKIT** clip plays for the signer.
- **Step 3 (English, optional):** set **Wika** → **English**. Say **"I need water"**: the caption shows
  "Kailangan ko ng tubig" with the **TUBIG** clip. Sign **salamat**: the caption shows "Salamat — thank you" and the
  phone says "thank you" in English.
- **Step 4:** ⚙ → **Network log**. Expected: "Requests palabas ng device: **0**" and only `[local]` loads.
- **Send back:** a screenshot after step 2 and of the Network log tab.

## Automated tests

```bash
npm run test:setup   # once: Playwright + Chromium + synthetic hand clips + espeak "Ano ang sakit?" / "I need water, please."
npm test
```

- `e2e.mjs`: one page, a fake camera showing the trained "tulong" hand and a fake mic saying "Ano ang sakit?".
  Checks the sign is picked up **without pressing anything** and spoken, the mic button gives the transcript and the
  *sakit* clip, and **0 requests leave 127.0.0.1** (any other request is aborted and counted).
- `e2e-offline.mjs`: an untrained two-hand shape gives "hindi kita"; after *save for offline* the server is killed,
  the Usap screen reloads, starts the camera and transcribes from cache.
- `e2e-train.mjs`: the Turuan screen records takes from the fake camera, undoes one, saves the playback clip,
  recognises *Tulong* with **Subukan**, and turns the camera off on Home.
- `e2e-translate.mjs`: with the language set to English, OPUS-MT translates "Thank you" → "Salamat" and back; a fake mic
  saying "I need water, please." shows "Kailangan ko ng tubig." with the *tubig* sign; a *Salamat* sign is
  shown as "Salamat — thank you" and spoken with Kokoro's English voice; an added word is translated tl→en; and
  Whisper (English) correctly hears four phrases Kokoro said.
- `e2e-vad.mjs`: loud pink noise with nobody talking gives "Walang narinig" and sends nothing; "Ano ang sakit?" after
  1.5 s of silence is detected by Silero, trimmed to the speech, and transcribed to *sakit*.
- `e2e-voice.mjs`: loads Kokoro from this origin only, speaks six Tagalog phrases, and saves them to
  `test/voice-samples/*.wav` so you can listen.

The synthetic clips are still photos sliding across the frame. They prove the pipeline, not real sign accuracy.

## Limits (honest)

- 17 built-in signs plus the team's own words. Accuracy depends on the training takes. Record in the same light and at the
  same distance you will demo in, and use 5+ takes per sign.
- Whisper **tiny** is weak at Tagalog. The keyword table absorbs common misspellings ("Anong ang sakit" still maps
  to *sakit*), but long sentences will be rough. Short, clear phrases work best. For better accuracy, swap in
  `onnx-community/whisper-base` (about 3× slower) in `vendor.sh` and `app/js/whisper-worker.js`.
- The espeak-ng voice is robotic. A phone with an offline Filipino system voice (Android: Google TTS → Filipino,
  downloaded) is used automatically instead.
- OPUS-MT is a small model. Short phrases translate well ("Where is the bathroom?" → "Nasaan ang banyo?"), but
  single Filipino words without context can come out odd ("kumusta" → "what"), so built-in signs keep a fixed
  English meaning and the translator is only used for added words and free speech. Full offline save is about 500 MB.
- The English voice only knows the ~10k words in `en-lexicon.json`. A sentence with any other word (names, rare words)
  uses the phone's offline English system voice; with none installed, Kokoro guesses that word from its spelling.
- Body position needs the face and shoulders in view. If they aren't (camera too close), recognition falls back to
  hand shape and camera position only.
- The camera watches one signer. Keep only the signer's hands in view: other people's hands in the frame can start a
  capture and give "hindi kita".

## Layout

```
app/                    the whole app (static, no build step)
  index.html            CSP locks network to this origin
  js/main.js            screens, setup dialog, training import/export
  js/usap.js            the one-phone conversation screen (auto sign capture, mic, captions)
  js/hands.js           MediaPipe hands + pose, landmark + body-position features
  js/classifier.js      sign kNN with "hindi kita" rejection
  js/camera.js          camera (front/rear) + one-sign segmentation
  js/stt.js             mic + Silero VAD (vad-worker.js) -> whisper-worker.js
  js/signs.js           labels + Filipino/Taglish phrase map, added words
  js/trainer.js         Turuan screen (record, test, add words)
  js/store.js           IndexedDB samples, clips, packs
  js/voice.js           speech output order + earcons
  js/kokoro.js          Kokoro voice -> tts-worker.js
  js/tl-g2p.js          Tagalog spelling -> IPA
  js/en-g2p.js          English words -> IPA (models/en-lexicon.json)
  js/translate.js       English <-> Filipino -> mt-worker.js (OPUS-MT)
  js/netlog.js          network log + offline guard
  js/offline.js, sw.js  save-for-offline cache
  vendor/               MediaPipe, Transformers.js, ONNX Runtime (from scripts/vendor.sh)
  models/               hand + pose landmarkers, Silero VAD, Whisper tiny, Kokoro + voices, OPUS-MT en-tl / tl-en, en-lexicon.json
  packs/fsl105.json     starter training pack; clips/ its playback clips
  audio/                espeak-ng word clips
scripts/                vendor.sh, make_voice.sh, make_opus_mt.sh + opus_mt_quantize.py, make_en_lexicon.py,
                        build_manifest.py, serve.py, make_cert.sh, fsl105/
test/                   Playwright end-to-end tests
.github/workflows/      pages.yml publishes app/ to GitHub Pages on push to main
```
