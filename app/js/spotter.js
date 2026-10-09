// Finds signs in a continuous camera stream, for a signer who chains signs without dropping their hands
// (and whose resting hands stay in view when the phone is held at a distance).
// A stretch of hand movement is one segment; it ends when the hands hold still for PAUSE_MS or leave
// the frame. The segment is then classified whole and as windows anchored at its start and its end,
// so two signs run together still come out as two; the best accepted match wins.
import { trimFrames } from './classifier.js';
import { HAND_DIM } from './hands.js';

const WINDOWS_MS = [700, 1000, 1300, 1700, 2200];
const MOVE_WINDOW_MS = 300;    // movement is measured over this much time
const MIN_MOVE = 0.03;         // wrist travel (image units) in MOVE_WINDOW_MS that counts as moving
const PAUSE_MS = 350;          // still (or no hands) this long ends a segment
const PRE_MS = 250;            // keep a little before the first movement (the hand coming up)
const MAX_SEGMENT_MS = 4000;   // signing without any pause: classify what we have
const MIN_SEGMENT_MS = 350;
const REST_MIN_MS = 700;       // leftover movement this long is classified on its own
const KEEP_MS = 6000;
const REPEAT_MS = 800;          // the same sign again this soon is one sign done with two movements

/** How far either wrist travelled in these frames (resting hands jitter much less). */
export function movement(frames) {
  let best = 0;
  for (const slot of [0, 1]) {
    const x = slot * HAND_DIM + 63;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of frames) {
      const vx = f.vec[x];
      const vy = f.vec[x + 1];
      if (!vx && !vy) continue;
      minX = Math.min(minX, vx); maxX = Math.max(maxX, vx);
      minY = Math.min(minY, vy); maxY = Math.max(maxY, vy);
    }
    if (maxX >= minX) best = Math.max(best, maxX - minX + (maxY - minY));
  }
  return best;
}

export class SignSpotter {
  /** onSign(result) per sign found, onUnknown(result) for movement that matched nothing, onActivity(signing). */
  constructor(classifier, { onSign, onUnknown, onActivity } = {}) {
    Object.assign(this, { classifier, onSign, onUnknown, onActivity });
    this.reset();
  }

  reset() {
    this.frames = [];
    this.segStart = 0;     // first moving frame of the current segment (0 = none)
    this.lastMove = 0;     // newest moving frame
    this.signing = false;
    this.last = null;      // { label, endAt } of the last sign announced
  }

  push(frame) {
    const now = frame.at;
    this.frames.push(frame);
    while (this.frames.length && this.frames[0].at < now - KEEP_MS) this.frames.shift();
    if (!this.classifier.ready) return;

    const recent = this.frames.filter((f) => f.at >= now - MOVE_WINDOW_MS);
    const moving = frame.hands > 0 && movement(recent) >= MIN_MOVE;
    if (moving) {
      this.lastMove = now;
      if (!this.segStart) this.segStart = now;
    }
    this.#activity(!!this.segStart);
    if (!this.segStart) return;
    const paused = now - this.lastMove >= PAUSE_MS;
    if (paused || now - this.segStart >= MAX_SEGMENT_MS) this.#endSegment(this.segStart - PRE_MS, paused ? this.lastMove + 100 : now);
  }

  #endSegment(from, to) {
    const seg = this.frames.filter((f) => f.at >= from && f.at <= to);
    this.frames = this.frames.filter((f) => f.at > to);
    this.segStart = 0;
    this.#activity(false);
    if (to - from < MIN_SEGMENT_MS + PRE_MS) return;
    const found = this.#classify(seg);
    if (!found.length) {
      if (this.lastGuess) this.onUnknown?.(this.lastGuess);
      return;
    }
    for (const r of found) {
      const repeat = this.last && r.label === this.last.label && r.startAt - this.last.endAt < REPEAT_MS;
      this.last = { label: r.label, endAt: r.endAt };
      if (!repeat) this.onSign?.(r);
    }
  }

  /** Best match in `seg`, plus a second sign in what is left on either side of it. Chronological. */
  #classify(seg, depth = 0) {
    this.lastGuess = null;
    if (seg.length < 2) return [];
    const t0 = seg[0].at;
    const t1 = seg.at(-1).at;
    const spans = [[t0, t1]];
    for (const ms of WINDOWS_MS) {
      if (ms >= t1 - t0) break;
      spans.push([t1 - ms, t1], [t0, t0 + ms]);
    }
    let best = null;
    for (const [a, b] of spans) {
      const win = seg.filter((f) => f.at >= a && f.at <= b);
      const vecs = trimFrames(win);
      if (!vecs) continue;
      const res = this.classifier.predict(vecs);
      if (!res.label) {
        if (!this.lastGuess || res.distance < this.lastGuess.distance) this.lastGuess = res;
        continue;
      }
      if (!best || res.distance < best.distance) {
        const hands = win.filter((f) => f.hands);
        best = { ...res, startAt: hands[0].at, endAt: hands.at(-1).at, frames: hands.length };
      }
    }
    if (!best) return [];
    if (depth > 0) return [best];
    const before = seg.filter((f) => f.at < best.startAt);
    const after = seg.filter((f) => f.at > best.endAt);
    const more = (part) => (part.length > 1 && part.at(-1).at - part[0].at >= REST_MIN_MS && movement(part) >= MIN_MOVE ? this.#classify(part, 1) : []);
    return [...more(before), best, ...more(after)];
  }

  #activity(on) {
    if (on === this.signing) return;
    this.signing = on;
    this.onActivity?.(on);
  }
}
