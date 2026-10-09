// MediaPipe Hands (local wasm + local .task model) and per-frame features.
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { netlog } from './netlog.js';

const base = new URL('..', import.meta.url);
export const HAND_DIM = 66;                // 63 wrist-relative coords + wrist x,y + present flag
export const FRAME_DIM = HAND_DIM * 2;     // slot 0 = Left, slot 1 = Right

let landmarker = null;
let lastTs = 0;

export async function loadHands() {
  if (landmarker) return landmarker;
  netlog.model('MediaPipe Hand Landmarker', 'models/mediapipe/hand_landmarker.task');
  const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', base).href);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: new URL('models/mediapipe/hand_landmarker.task', base).href, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return landmarker;
}

/** Detect on a <video>/<canvas>. Timestamps must strictly increase across all calls. */
export function detect(source) {
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
  return landmarker.detectForVideo(source, lastTs);
}

function handFeature(lms) {
  const w = lms[0];
  const m = lms[9];
  const scale = Math.hypot(m.x - w.x, m.y - w.y, m.z - w.z) || 1e-3;
  const out = new Array(HAND_DIM);
  for (let i = 0; i < 21; i++) {
    out[i * 3] = (lms[i].x - w.x) / scale;
    out[i * 3 + 1] = (lms[i].y - w.y) / scale;
    out[i * 3 + 2] = (lms[i].z - w.z) / scale;
  }
  out[63] = (w.x - 0.5) * 4;   // where the hand is in frame matters for motion signs
  out[64] = (w.y - 0.5) * 4;
  out[65] = 2;
  return out;
}

/** HandLandmarkerResult -> { vec: number[FRAME_DIM], hands: count } */
export function frameFeature(result) {
  const vec = new Array(FRAME_DIM).fill(0);
  const n = result?.landmarks?.length ?? 0;
  const used = [false, false];
  for (let h = 0; h < n; h++) {
    const side = result.handedness?.[h]?.[0]?.categoryName;
    let slot = side === 'Right' ? 1 : 0;
    if (used[slot]) slot = 1 - slot;
    if (used[slot]) continue;
    used[slot] = true;
    const f = handFeature(result.landmarks[h]);
    for (let i = 0; i < HAND_DIM; i++) vec[slot * HAND_DIM + i] = f[i];
  }
  return { vec, hands: n };
}

/** Mirror a frame vector (swap hands, flip x) so left- and right-handed signing both match. */
export function mirrorFrame(vec) {
  const out = new Array(FRAME_DIM);
  for (let s = 0; s < 2; s++) {
    const src = s * HAND_DIM;
    const dst = (1 - s) * HAND_DIM;
    for (let i = 0; i < HAND_DIM; i++) out[dst + i] = vec[src + i];
    for (let i = 0; i < 21; i++) out[dst + i * 3] = -vec[src + i * 3];
    out[dst + 63] = -vec[src + 63];
  }
  return out;
}

const CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;

export function drawHands(ctx, result, mirrored = true) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (!result?.landmarks) return;
  const X = (x) => (mirrored ? 1 - x : x) * W;
  ctx.lineWidth = Math.max(2, W / 200);
  for (const lms of result.landmarks) {
    ctx.strokeStyle = '#ffd34d';
    ctx.beginPath();
    for (const { start, end } of CONNECTIONS) {
      ctx.moveTo(X(lms[start].x), lms[start].y * H);
      ctx.lineTo(X(lms[end].x), lms[end].y * H);
    }
    ctx.stroke();
    ctx.fillStyle = '#ff5a36';
    for (const p of lms) {
      ctx.beginPath();
      ctx.arc(X(p.x), p.y * H, ctx.lineWidth * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Run the landmarker over a recorded video file (team clips) at ~15 fps. */
export async function framesFromVideoFile(file, onProgress) {
  await loadHands();
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error(`cannot decode ${file.name}`));
  });
  const frames = [];
  const step = 1 / 15;
  for (let t = 0; t < video.duration; t += step) {
    video.currentTime = t;
    await new Promise((res) => (video.onseeked = res));
    const f = frameFeature(detect(video));
    frames.push(f);
    onProgress?.(t / video.duration);
  }
  URL.revokeObjectURL(url);
  return frames;
}
