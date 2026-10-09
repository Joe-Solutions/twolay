// Nearest-neighbour sign classifier over resampled hand-landmark sequences.
// Trains in-app on the team's recorded clips. Rejects anything far from every
// trained sign ("hindi kita") instead of guessing.
import { FRAME_DIM, HAND_DIM, HANDS_DIM, mirrorFrame } from './hands.js';

export const T = 12;                 // frames per sequence after resampling
export const MIN_HAND_FRAMES = 5;
const RATIO_MAX = 0.88;              // best / second-best label distance must be clearly lower
// How much hand-to-face/shoulder position counts, relative to one hand-shape dimension.
export const BODY_WEIGHT = 12;
const BODY_DIMS = FRAME_DIM - HANDS_DIM - 1;

/** Drop leading/trailing frames with no hands; return null if too little signing. */
export function trimFrames(frames) {
  let a = 0;
  let b = frames.length - 1;
  while (a <= b && !frames[a].hands) a++;
  while (b >= a && !frames[b].hands) b--;
  const kept = frames.slice(a, b + 1);
  const withHands = kept.filter((f) => f.hands).length;
  return withHands >= MIN_HAND_FRAMES ? kept.map((f) => f.vec) : null;
}

/** -> { hands: Float32Array(T*HANDS_DIM), body: Float32Array(T*BODY_DIMS) | null } */
function resample(vecs) {
  const hands = new Float32Array(T * HANDS_DIM);
  const n = vecs.length;
  // Body features count only if the body was found in most frames (older samples have none).
  const withBody = vecs.filter((v) => v.length >= FRAME_DIM && v[FRAME_DIM - 1] > 0.5).length;
  const body = withBody >= n / 2 ? new Float32Array(T * BODY_DIMS) : null;
  for (let t = 0; t < T; t++) {
    const pos = n === 1 ? 0 : (t * (n - 1)) / (T - 1);
    const i = Math.floor(pos);
    const j = Math.min(n - 1, i + 1);
    const k = pos - i;
    for (let d = 0; d < HANDS_DIM; d++) hands[t * HANDS_DIM + d] = vecs[i][d] * (1 - k) + vecs[j][d] * k;
    if (body) {
      for (let d = 0; d < BODY_DIMS; d++) {
        body[t * BODY_DIMS + d] = (vecs[i][HANDS_DIM + d] ?? 0) * (1 - k) + (vecs[j][HANDS_DIM + d] ?? 0) * k;
      }
    }
  }
  return { hands, body };
}

function sq(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// Wrist position in the camera image (per hand): depends on how the phone is held, so it is
// replaced by the body-relative position whenever both sequences have one.
const FRAME_POS = [63, 64, HAND_DIM + 63, HAND_DIM + 64];

/** RMS over hand shape, plus weighted body position when both sequences have it. */
function dist(a, b, w = BODY_WEIGHT) {
  let h = sq(a.hands, b.hands);
  if (!a.body || !b.body) return Math.sqrt(h / a.hands.length);
  for (let t = 0; t < T; t++) {
    for (const d of FRAME_POS) h -= (a.hands[t * HANDS_DIM + d] - b.hands[t * HANDS_DIM + d]) ** 2;
  }
  const n = a.hands.length - T * FRAME_POS.length;
  return Math.sqrt((Math.max(0, h) + w * sq(a.body, b.body)) / (n + w * a.body.length));
}

export class SignClassifier {
  constructor({ bodyWeight = BODY_WEIGHT } = {}) {
    this.bodyWeight = bodyWeight;
    this.items = [];        // { label, vec, sampleId }
    this.threshold = Infinity;
    this.counts = {};
  }

  /** samples: [{ id, label, frames: number[][] (already trimmed) }] */
  fit(samples) {
    this.items = [];
    this.counts = {};
    for (const s of samples) {
      if (!s.frames?.length) continue;
      this.items.push({ label: s.label, vec: resample(s.frames), sampleId: s.id });
      this.items.push({ label: s.label, vec: resample(s.frames.map(mirrorFrame)), sampleId: s.id, mirrored: true });
      this.counts[s.label] = (this.counts[s.label] || 0) + 1;
    }
    // Rejection threshold from leave-one-sample-out distance to the nearest same-sign example.
    const loo = [];
    for (const it of this.items) {
      let best = Infinity;
      for (const o of this.items) {
        if (o.sampleId === it.sampleId || o.label !== it.label) continue;
        best = Math.min(best, dist(it.vec, o.vec, this.bodyWeight));
      }
      if (best < Infinity) loo.push(best);
    }
    loo.sort((x, y) => x - y);
    this.threshold = loo.length >= 4 ? loo[Math.floor(loo.length * 0.9)] * 1.5 : 0.35;
    return this;
  }

  /** Leave-one-sample-out nearest-neighbour accuracy, per label and overall. */
  selfTest() {
    const perLabel = {};
    let ok = 0;
    let n = 0;
    for (const it of this.items) {
      if (it.mirrored) continue;
      let best = Infinity;
      let bestLabel = null;
      for (const o of this.items) {
        if (o.sampleId === it.sampleId) continue;
        const d = dist(it.vec, o.vec, this.bodyWeight);
        if (d < best) { best = d; bestLabel = o.label; }
      }
      if (!bestLabel) continue;
      const hit = bestLabel === it.label;
      perLabel[it.label] ??= { ok: 0, n: 0 };
      perLabel[it.label].n++;
      perLabel[it.label].ok += hit;
      ok += hit;
      n++;
    }
    return { accuracy: n ? ok / n : null, n, perLabel };
  }

  get ready() {
    return this.items.length > 0;
  }

  /** frames: trimmed frame vectors. -> { label|null, distance, margin, confidence } */
  predict(frames) {
    if (!frames || !this.ready) return { label: null, reason: frames ? 'untrained' : 'no-hands' };
    const q = resample(frames);
    const perLabel = {};
    for (const it of this.items) {
      const d = dist(q, it.vec, this.bodyWeight);
      if (!(it.label in perLabel) || d < perLabel[it.label]) perLabel[it.label] = d;
    }
    const ranked = Object.entries(perLabel).sort((a, b) => a[1] - b[1]);
    const [bestLabel, d1] = ranked[0];
    const d2 = ranked[1]?.[1] ?? Infinity;
    const ratio = d1 / d2;
    const confidence = Math.max(0, Math.min(1, 1 - d1 / this.threshold));
    const out = { distance: d1, ratio, confidence, guess: bestLabel, threshold: this.threshold };
    if (d1 > this.threshold) return { ...out, label: null, reason: 'far' };
    if (ratio > RATIO_MAX) return { ...out, label: null, reason: 'ambiguous' };
    return { ...out, label: bestLabel };
  }
}
