# Twolay

**Twolay** (from *tulay*, "bridge": a bridge between two people) is a two-way, fully offline conversation app between a **Deaf** person who signs and a **Blind** person who speaks.

```
Person 1 (Deaf)                                     Person 2 (Blind)
signs "tulong" ─▶ MediaPipe Hands ─▶ 12-sign kNN ─▶ {"label":"tulong"} ─▶ local voice says "Tulong"
sees "Ano ang sakit?" + sakit clip ◀─ {"text":..,"signs":["sakit"]} ◀─ Whisper tiny ◀─ says "Ano ang sakit?"
```

- Two roles, one big button each: **Kamay** (hands, for the signer) and **Boses** (voice, for the speaker).
- Everything runs on the phone: hand tracking, sign classifier, speech-to-text, text-to-speech.
- The only network traffic is the text message between the two phones, over a direct WebRTC DataChannel
  on the hotspot (no STUN, no TURN, no signalling server; pairing is done by scanning QR codes).
- If the link drops, each phone keeps recognizing, captioning and playing back on its own.
- Demo mode: two windows on one laptop, linked with `BroadcastChannel` (no network at all).

## Models and engines (full disclosure)

| Job | Model / engine | Size | Runs |
|---|---|---|---|
| Hand tracking | MediaPipe Hand Landmarker `hand_landmarker.task` (float16) + MediaPipe Tasks Vision 1.1.0 wasm (SIMD and no-SIMD builds) | 7.8 MB + 25 MB | phone, wasm (GPU→CPU fallback) |
| Sign → word | Twolay nearest-neighbour classifier over 12-frame landmark sequences, mirror-augmented, with a distance + ratio rejection (`app/js/classifier.js`). Ships pre-trained on 6 signs from the FSL-105 dataset (Deaf signers, CC BY 4.0); the team adds the rest in-app. | 1.5 MB pack + IndexedDB | phone, JS |
| Speech → text | OpenAI Whisper **tiny** multilingual, int8 ONNX (`onnx-community/whisper-tiny`), Transformers.js 4.3.1 + ONNX Runtime Web 1.31 wasm, language forced to Tagalog | 43 MB + 39 MB runtime | phone, Web Worker |
| Text → sign | Keyword table for Filipino + Taglish, one-typo tolerant (`app/js/signs.js`) | — | phone |
| Text → voice | On-device system voice for Filipino if the phone has one (`speechSynthesis`, `localService` voices only), otherwise 12 clips pre-rendered with **espeak-ng** (Indonesian voice; Tagalog spelling is phonetic) in `app/audio/` | 0.5 MB | phone |
| Sign playback | FSL-105 clips for the 6 starter signs (`app/clips/`), plus clips the team records | 0.3 MB | phone |

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

Open `http://localhost:8000`, train the signs (next section), then follow **Demo script → A**.
Wi-Fi can be off from this point on.

### Re-downloading the models (optional)

Only needed to upgrade a model or rebuild `app/vendor`, `app/models` or `app/audio` from scratch (needs internet and Node):

```bash
brew install espeak-ng   # for the spoken word clips in app/audio
npm run setup            # MediaPipe, Whisper tiny, ONNX Runtime, QR libs -> app/; renders app/audio
```

After you change any file in `app/`, run `npm run manifest` so installed phones pick up the new version.

## Train the 12 signs

### Starter pack: 6 signs work out of the box

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

5-fold cross-validation on held-out takes (`npm run eval:pack`): **94% correct, 0% wrong, 6% "hindi kita"**.
The same signers appear in training and test folds, so expect lower accuracy on a new person.

Each of these also has a playback clip of a Deaf signer in `app/clips/`. The pack can be turned off in
⚙ → Turuan. Rebuild it with `npm run build:pack`.

The dataset framing (full upper body, blue background) differs from a selfie camera, so add 3–5 of your own
takes per sign for the best accuracy.

### The other 6 signs need a signer

FSL-105 has no **tubig, pagkain, tulong, sakit, banyo, sandali**, and the demo script uses *tulong* and *sakit*.
Record these from someone who knows FSL, ideally a Deaf signer. Do not make up gestures: judges and Deaf users
will see them as FSL. Places to learn or confirm them: the University of the Philippines OSDS *Basic Filipino
Sign Language* video series, the FSL Buddy app (De La Salle-College of Saint Benilde), and TulaySenyas
(health signs, including *sakit*). Check each sign there before recording; this repo has not verified them.

### Recording your own takes

All training data stays on the device (IndexedDB). Two ways to train; both feed the same classifier.

1. **Record live, Turuan screen:** on the home screen tap **Turuan** (Train FSL), or ⚙ → Turuan →
   *Buksan ang Turuan*. Or open `http://localhost:8000/?role=train` directly.
   - The chips at the bottom list all 12 signs with your takes (`n/5`) and any FSL-105 samples. Green ✓ = enough.
   - Left: an example of the sign (FSL-105 clip, or your own first take). Right: your camera with the hand skeleton.
   - Tap **I-record** (or Space). After the 3-2-1 beeps, sign once, then drop your hands. That's one take.
   - If a take looks like a different sign, the status line warns you ("kahawig ito ng …").
   - **Bawiin ang huling take** removes a bad take. **Burahin ang takes nito** clears that sign.
   - **Subukan** signs once without saving and shows what Twolay recognises.
   - After 5 takes it moves on to the next unfinished sign. The first take of a sign without a clip becomes
     its playback clip on the Kamay screen.
   - **Your own words:** type a word under the chips (e.g. `gutom`) and tap **＋ Idagdag**. It becomes a new
     sign (dashed chip) to record like the others. On the Boses side it triggers only when that exact word or
     phrase is heard, and it wins over a built-in synonym (`gutom` → your sign, not *pagkain*).
     **Tanggalin ang salitang ito** removes the word and its takes. Built-in signs can't be removed, only their takes.
     The Kamay device sends its word list to the Boses device whenever they connect, and packs carry the words too.
2. **Import the team's clips:** ⚙ → Turuan → *I-import ang video clips*. File names start with the sign:
   `tulong_01.mp4`, `sakit-2.mov`, `salamat 3.mp4`.

The ⚙ → Turuan tab shows samples per sign, whether a clip exists, and a leave-one-out self-test score.
**Export pack** / **Import pack** copies the trained set and clips to the other phone or the demo laptop as one JSON file.

Unknown or unclear signs show **"hindi kita"** locally and are not sent. Two checks reject them: the distance
must be within the threshold learned from the training data, and the best sign must clearly beat the runner-up.

## Install on two phones (offline)

Camera, mic and offline caching need HTTPS. Use a trusted local cert:

```bash
brew install mkcert
npm run cert                      # prints the rootCA.pem to install + trust on each phone
npm run start:lan                 # https://<laptop-ip>:8443
```

On each phone (laptop on the same Wi-Fi or hotspot): open the URL → ⚙ → **Offline** →
*I-save ang buong app para offline* → wait for **Handa offline ✓** → Share → *Add to Home Screen*.
After that the laptop is not needed. Import the training pack on the signer's phone.

Alternative: put `app/` on any static HTTPS host you control and open it once on each phone. That download
only contains the app and models; no user audio, video or text is ever sent.

## Demo script

**Audience mode** (⚙ → Link, off by default). Each screen normally uses only its user's sense: Boses *speaks*
the sign for the Blind user, Kamay *shows* the text and sign clip for the Deaf user. For judges watching both
screens, audience mode also plays the sign clip on Boses and reads the transcript aloud on Kamay. It is per device.

### A. Single laptop (required fallback)

- **Where:** laptop, Chrome or Edge, `http://localhost:8000` (`python3 scripts/serve.py`). Turn Wi-Fi **off** first.
- **Inputs:** tap **Demo mode: dalawang window sa isang laptop**. Allow the camera in the Kamay window and the
  mic in the Boses window. If the second window is blocked, allow pop-ups or open
  `http://localhost:8000/?role=boses&link=demo` yourself.
- **Expected:** both windows show the green pill **Konektado (demo)**.
- **Step 1:** in the Kamay window press **Kamay** (or Space) and sign **tulong**.
  Expected: Kamay caption "Ikaw: Tulong", status "Tulong — NN% → naipadala"; Boses window shows "Kamay: Tulong",
  plays a two-tone chime and says **"Tulong"**.
- **Step 2:** in the Boses window press **Boses** (or Space) and say **"Ano ang sakit?"**, then stop talking.
  Expected: the button turns red ("Nakikinig…"), then "Isinusulat…" for about 1–2 s; Boses caption shows the
  transcript; Kamay window shows "Boses: Ano ang sakit?" and plays the **SAKIT** clip.
- **Step 3:** ⚙ → **Network log**. Expected: "Requests palabas ng dalawang device: **0**", only `[local]` loads, and
  `[out]`/`[in]` lines carrying just the JSON text messages.
- **Send back:** a screenshot of the Network log tab and of both windows after step 2.

### B. Two phones on a hotspot

- **Where:** Phone A turns on its hotspot with **mobile data off** (so the hotspot has no internet). Phone B joins
  it. Wi-Fi to any other network is off. Open Twolay from the home screen on both phones.
- **Pair:** both phones ⚙ → Link. Phone A: *Gumawa ng pairing code* (QR appears). Phone B: *I-scan ang code ni A*
  (rear camera), and an answer QR appears. Phone A: *I-scan ang sagot ni B*.
  Expected: both show **Konektado (phone)**; the Network log shows
  `p2p route: <ip>:… (host) <-> <ip>:… (host) — direct, no relay server`, with private hotspot addresses
  (iPhone hotspot: `172.20.10.x`; Android: usually `192.168.x.x` or `10.x.x.x`).
- **Roles:** Phone A → **Kamay**, Phone B → **Boses**. Then run steps 1–3 from part A.
- **Offline switch:** turn the hotspot off mid-demo. Expected: the pill turns red, **Nawala ang link**; signing still
  shows "Tulong" locally with "(walang link, dito lang)", and speaking still transcribes on the Boses phone.
  To reconnect, pair again.
- **Send back:** the Network log screenshot from both phones.

Bluetooth: browsers cannot open raw Bluetooth sockets, but **Bluetooth tethering** (personal hotspot over
Bluetooth) gives the phones an IP link, and the same WebRTC pairing works over it.

## Automated tests

```bash
npm run test:setup   # once: Playwright + Chromium + synthetic hand clips + espeak "Ano ang sakit?"
npm test
```

- `e2e.mjs`: two demo windows, a fake camera showing the trained "tulong" hand, and a fake mic saying
  "Ano ang sakit?". Checks the Boses window receives and speaks *Tulong*, the Kamay window gets the
  transcript and plays the *sakit* clip, and **0 requests leave 127.0.0.1** (any other request is aborted and counted).
- `e2e-offline.mjs`: an untrained two-hand shape gives "hindi kita" and sends nothing; closing the other window
  shows "Nawala ang link" and recognition still works; after *save for offline* the server is killed and
  both roles reload, load their models and transcribe from cache.
- `e2e-p2p.mjs`: two isolated browser contexts pair over WebRTC using the same codes the QR carries, exchange a
  message, and log a host-to-host route.
- `e2e-train.mjs`: the Turuan screen records takes from the fake camera, undoes one, saves the playback clip,
  recognises *Tulong* with **Subukan**, and turns the camera off on Home.

The synthetic clips are still photos sliding across the frame. They prove the pipeline, not real sign accuracy.

## Limits (honest)

- 12 signs only, trained by the team. Accuracy depends on the training takes. Record in the same light and at the
  same distance you will demo in, and use 5+ takes per sign.
- Whisper **tiny** is weak at Tagalog. The keyword table absorbs common misspellings ("Anong ang sakit" still maps
  to *sakit*), but long sentences will be rough. Short, clear phrases work best. For better accuracy, swap in
  `onnx-community/whisper-base` (about 3× slower) in `vendor.sh` and `app/js/whisper-worker.js`.
- The espeak-ng voice is robotic. A phone with an offline Filipino system voice (Android: Google TTS → Filipino,
  downloaded) is used automatically instead.
- Pairing must be redone after the link drops, by scanning the QR codes again.

## Layout

```
app/                    the whole app (static, no build step)
  index.html            CSP locks network to this origin
  js/main.js            screens, roles, setup dialog
  js/hands.js           MediaPipe wrapper + landmark features
  js/classifier.js      12-sign kNN with "hindi kita" rejection
  js/camera.js          camera + one-sign segmentation
  js/stt.js             mic + VAD -> whisper-worker.js
  js/signs.js           labels + Filipino/Taglish phrase map
  js/voice.js           local TTS + earcons
  js/link.js            DemoLink (BroadcastChannel), P2PLink (WebRTC, QR pairing)
  js/netlog.js          network log + offline guard
  js/offline.js, sw.js  save-for-offline cache
  vendor/, models/      vendored runtimes and models (from scripts/vendor.sh)
  audio/                espeak-ng word clips
scripts/                vendor.sh, make_voice.sh, build_manifest.py, serve.py, make_cert.sh
test/                   Playwright end-to-end tests
```
