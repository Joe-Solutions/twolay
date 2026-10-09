// MediaPipe Hands + Pose (local wasm + local .task models) and per-frame features.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { netlog } from './netlog.js';

const base = new URL('..', import.meta.url);
export const HAND_DIM = 66;                // 63 wrist-relative coords + wrist x,y + present flag
export const HANDS_DIM = HAND_DIM * 2;     // slot 0 = Left, slot 1 = Right
// Where each hand is relative to the face and shoulders (FSL signs differ by location: chin, chest…):
// per hand slot, wrist x,y and index tip x,y from the nose in shoulder widths; then a body-found flag.
export const BODY_DIM = 9;
export const FRAME_DIM = HANDS_DIM + BODY_DIM;
const VISIBLE = 0.5;

let landmarker = null;
let pose = null;
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
  await loadPose(fileset);
  return landmarker;
}

async function loadPose(fileset) {
  netlog.model('MediaPipe Pose Landmarker lite', 'models/mediapipe/pose_landmarker_lite.task');
  // CPU on purpose: pose lite takes ~11 ms there, and it keeps the GPU free for the hand model.
  try {
    pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('models/mediapipe/pose_landmarker_lite.task', base).href, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  } catch (err) {
    netlog.info(`Pose unavailable, hands only: ${err.message}`);
  }
}

/**
 * Detect on a <video>/<canvas>. Timestamps must strictly increase across all calls.
 * Returns the hand result plus .pose (33 body landmarks or null) and .aspect (width / height).
 */
let lastPose = null;
let lastPoseAt = -Infinity;
export function detect(source, { poseEveryMs = 66 } = {}) {
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
  const result = landmarker.detectForVideo(source, lastTs);
  // The body moves slowly; on the live camera ~15 pose updates a second is plenty and halves the cost.
  if (pose && lastTs - lastPoseAt >= poseEveryMs) {
    lastPose = pose.detectForVideo(source, lastTs).landmarks?.[0] ?? null;
    lastPoseAt = lastTs;
  }
  result.pose = lastPose;
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  result.aspect = w && h ? w / h : 1;
  return result;
}

/** Nose and body scale in aspect-corrected image units, or null if the body isn't visible. */
function bodyFrame(lms, aspect) {
  if (!lms) return null;
  const P = (i) => ({ x: lms[i].x * aspect, y: lms[i].y, v: lms[i].visibility ?? 1 });
  const nose = P(0);
  const [ls, rs, le, re] = [P(11), P(12), P(7), P(8)];
  if (nose.v < VISIBLE) return null;
  let scale = 0;
  if (ls.v > VISIBLE && rs.v > VISIBLE) scale = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  else if (le.v > VISIBLE && re.v > VISIBLE) scale = 2.6 * Math.hypot(le.x - re.x, le.y - re.y);
  return scale > 0.02 ? { x: nose.x, y: nose.y, scale } : null;
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

/** detect() result -> { vec: number[FRAME_DIM], hands: count, body: bool } */
export function frameFeature(result) {
  const vec = new Array(FRAME_DIM).fill(0);
  const n = result?.landmarks?.length ?? 0;
  const aspect = result?.aspect ?? 1;
  const body = bodyFrame(result?.pose, aspect);
  const used = [false, false];
  for (let h = 0; h < n; h++) {
    const side = result.handedness?.[h]?.[0]?.categoryName;
    let slot = side === 'Right' ? 1 : 0;
    if (used[slot]) slot = 1 - slot;
    if (used[slot]) continue;
    used[slot] = true;
    const lms = result.landmarks[h];
    const f = handFeature(lms);
    for (let i = 0; i < HAND_DIM; i++) vec[slot * HAND_DIM + i] = f[i];
    if (body) {
      const o = HANDS_DIM + slot * 4;
      vec[o] = (lms[0].x * aspect - body.x) / body.scale;
      vec[o + 1] = (lms[0].y - body.y) / body.scale;
      vec[o + 2] = (lms[8].x * aspect - body.x) / body.scale;
      vec[o + 3] = (lms[8].y - body.y) / body.scale;
    }
  }
  if (body) vec[FRAME_DIM - 1] = 1;
  return { vec, hands: n, body: !!body };
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
  if (vec.length < FRAME_DIM) return out.slice(0, HANDS_DIM);   // samples recorded before body features
  for (let s = 0; s < 2; s++) {
    const src = HANDS_DIM + s * 4;
    const dst = HANDS_DIM + (1 - s) * 4;
    out[dst] = -vec[src];
    out[dst + 1] = vec[src + 1];
    out[dst + 2] = -vec[src + 2];
    out[dst + 3] = vec[src + 3];
  }
  out[FRAME_DIM - 1] = vec[FRAME_DIM - 1];
  return out;
}

const CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;

export function drawHands(ctx, result, mirrored = true) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (!result?.landmarks) return;
  const X = (x) => (mirrored ? 1 - x : x) * W;
  ctx.lineWidth = Math.max(2, W / 200);
  // Face + shoulders the hands are measured against.
  if (result.pose) {
    ctx.fillStyle = '#4db8ff';
    for (const i of [0, 11, 12]) {
      const p = result.pose[i];
      if ((p.visibility ?? 1) < VISIBLE) continue;
      ctx.beginPath();
      ctx.arc(X(p.x), p.y * H, ctx.lineWidth * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
  const release = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error(`cannot decode ${file.name}: ${video.error?.message || video.error?.code}`));
    });
    const frames = [];
    const step = 1 / 15;
    for (let t = 0; t < video.duration; t += step) {
      video.currentTime = t;
      await new Promise((res) => (video.onseeked = res));
      frames.push(frameFeature(detect(video, { poseEveryMs: 0 })));
      onProgress?.(t / video.duration);
    }
    return frames;
  } finally {
    release();
  }
}
