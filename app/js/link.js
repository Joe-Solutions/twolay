// The only network the app uses: a direct link to the other phone.
//   demo -> BroadcastChannel between two windows of the same browser (no network at all)
//   p2p  -> WebRTC DataChannel over the phone hotspot (or Bluetooth PAN). No STUN/TURN servers,
//           pairing is done by scanning QR codes, so no signalling server either.
import { netlog } from './netlog.js';

const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 7000;

class BaseLink extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind;
    this.status = 'idle';     // idle | waiting | connected | lost
    this.peerRole = null;
    this.role = null;
    this.lastSeen = 0;
    this.hb = setInterval(() => this.#tick(), HEARTBEAT_MS);
  }

  #tick() {
    if (this.status === 'connected' && Date.now() - this.lastSeen > PEER_TIMEOUT_MS) this.setStatus('lost');
    this.raw({ t: 'hb', role: this.role });
  }

  setRole(role) {
    this.role = role;
    this.raw({ t: 'hb', role });
  }

  setStatus(s, detail = '') {
    if (this.status === s) return;
    this.status = s;
    netlog.info(`link ${this.kind}: ${s}${detail ? ` (${detail})` : ''}`);
    this.dispatchEvent(new CustomEvent('status', { detail: s }));
  }

  /** Send an app message. Returns false if the peer is not reachable. */
  send(msg) {
    if (this.status !== 'connected') return false;
    const ok = this.raw(msg);
    if (ok) netlog.peer('out', this.kind, msg);
    return ok;
  }

  receive(msg) {
    this.lastSeen = Date.now();
    if (msg.role) this.peerRole = msg.role;
    if (this.status !== 'connected') this.setStatus('connected');
    if (msg.t === 'hb') return;
    netlog.peer('in', this.kind, msg);
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  close() {
    clearInterval(this.hb);
    this.setStatus('idle');
  }
}

export class DemoLink extends BaseLink {
  constructor() {
    super('demo');
    this.ch = new BroadcastChannel('twolay-demo-link');
    this.ch.onmessage = (e) => this.receive(e.data);
    this.setStatus('waiting');
  }
  raw(msg) {
    this.ch.postMessage(msg);
    return true;
  }
  close() {
    super.close();
    this.ch.close();
  }
}

// ---- WebRTC pairing codes: deflate + base64url so the SDP fits in one QR ----
async function pack(desc) {
  const json = JSON.stringify({ t: desc.type[0], s: desc.sdp });
  if (!('CompressionStream' in window)) return `T0${btoa(unescape(encodeURIComponent(json)))}`;
  const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return `T1${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

async function unpack(code) {
  code = code.trim();
  let json;
  if (code.startsWith('T0')) json = decodeURIComponent(escape(atob(code.slice(2))));
  else if (code.startsWith('T1')) {
    const b64 = code.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  } else throw new Error('hindi Twolay pairing code');
  const o = JSON.parse(json);
  return { type: o.t === 'o' ? 'offer' : 'answer', sdp: o.s };
}

export class P2PLink extends BaseLink {
  constructor() {
    super('p2p');
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.dc = this.pc.createDataChannel('twolay', { negotiated: true, id: 0, ordered: true });
    this.dc.onopen = () => {
      this.lastSeen = Date.now();
      this.setStatus('connected');
      this.raw({ t: 'hb', role: this.role });
      this.#logRoute();
    };
    this.dc.onclose = () => this.setStatus('lost', 'channel closed');
    this.dc.onmessage = (e) => this.receive(JSON.parse(e.data));
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) this.setStatus('lost', this.pc.connectionState);
    };
  }

  raw(msg) {
    if (this.dc.readyState !== 'open') return false;
    this.dc.send(JSON.stringify(msg));
    return true;
  }

  async #gathered() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise((res) => {
      const done = () => this.pc.iceGatheringState === 'complete' && res();
      this.pc.addEventListener('icegatheringstatechange', done);
      setTimeout(res, 3000);
    });
  }

  /** Phone A: make the code to show as a QR. */
  async createOffer() {
    this.setStatus('waiting');
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.#gathered();
    return pack(this.pc.localDescription);
  }

  /** Phone B: scan A's code, return the answer code to show back. */
  async acceptOffer(code) {
    this.setStatus('waiting');
    await this.pc.setRemoteDescription(await unpack(code));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.#gathered();
    return pack(this.pc.localDescription);
  }

  /** Phone A: scan B's answer code. */
  async acceptAnswer(code) {
    await this.pc.setRemoteDescription(await unpack(code));
  }

  async #logRoute() {
    const stats = await this.pc.getStats();
    let pair;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    stats.forEach((s) => {
      if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    if (!pair) return;
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    const addr = (c) => `${c?.address ?? c?.ip ?? '?'}:${c?.port ?? '?'} (${c?.candidateType})`;
    netlog.info(`p2p route: ${addr(l)} <-> ${addr(r)} — direct, no relay server`);
  }

  close() {
    super.close();
    this.pc.close();
  }
}
