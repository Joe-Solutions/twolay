// Front camera + live hand tracking + one-sign segmentation.
import { loadHands, detect, frameFeature, drawHands } from './hands.js';

const WAIT_FOR_HANDS_MS = 5000;
const MAX_SIGN_MS = 3500;
const HANDS_GONE_MS = 450;

export class SignCam {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stream = null;
    this.running = false;
    this.onFrame = null;       // (frame, result) => void
    this.capture = null;
    this.lastVideoTime = -1;
  }

  async start() {
    if (this.running) return;
    await loadHands();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.running = true;
    this.#loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  #loop() {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const result = detect(this.video);
      drawHands(this.ctx, result, true);
      const frame = frameFeature(result);
      frame.at = performance.now();
      this.capture?.push(frame);
      this.onFrame?.(frame, result);
    }
    requestAnimationFrame(() => this.#loop());
  }

  /**
   * Capture one sign: wait for hands, record until hands drop / time limit / stop().
   * Resolves { frames, clip } where clip is a video Blob when recordClip is set.
   */
  captureSign({ recordClip = false, onState } = {}) {
    let finish;
    const frames = [];
    let firstHandAt = 0;
    let lastHandAt = 0;
    const t0 = performance.now();
    let rec;
    const chunks = [];
    if (recordClip && 'MediaRecorder' in window) {
      const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start();
    }
    onState?.('waiting');

    const done = new Promise((resolve) => (finish = resolve)).then(async () => {
      this.capture = null;
      clearInterval(timer);
      let clip = null;
      if (rec) {
        await new Promise((r) => { rec.onstop = r; rec.stop(); });
        clip = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      }
      return { frames, clip };
    });

    this.capture = {
      push: (f) => {
        if (f.hands) {
          if (!firstHandAt) { firstHandAt = f.at; onState?.('signing'); }
          lastHandAt = f.at;
        }
        if (firstHandAt) frames.push(f);
      },
    };

    const timer = setInterval(() => {
      const now = performance.now();
      if (!firstHandAt && now - t0 > WAIT_FOR_HANDS_MS) finish();
      if (firstHandAt && now - firstHandAt > MAX_SIGN_MS) finish();
      if (firstHandAt && now - lastHandAt > HANDS_GONE_MS) finish();
    }, 50);

    return { done, stop: () => finish() };
  }
}
