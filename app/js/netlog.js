// Network log + guard. Proves the demo claim: nothing leaves the two devices.
//  - every resource the page/worker loads is logged with its origin
//  - fetch / XHR / WebSocket / sendBeacon to another origin are BLOCKED and logged
//  - CSP violations (the browser-level block) are logged
//  - every peer-link message is logged with its size and payload
const entries = [];
const listeners = new Set();
let external = 0;

const isLocal = (url) => {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin || ['blob:', 'data:', 'mediastream:'].includes(u.protocol);
  } catch {
    return false;
  }
};

function push(e) {
  e.t = new Date().toLocaleTimeString();
  entries.push(e);
  if (entries.length > 500) entries.shift();
  for (const fn of listeners) fn(e);
}

export const netlog = {
  entries,
  get externalCount() {
    return external;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  resource(url, from = 'page') {
    const local = isLocal(url);
    if (!local) external++;
    const u = new URL(url, location.href);
    push({ kind: local ? 'local' : 'EXTERNAL', text: `${from} load ${u.protocol === 'blob:' ? 'blob:' : u.pathname}` });
  },
  blocked(url, via) {
    external++;
    push({ kind: 'BLOCKED', text: `${via} -> ${url}` });
  },
  peer(dir, transport, msg) {
    const body = typeof msg === 'string' ? msg : JSON.stringify(msg);
    push({ kind: dir, text: `${transport} ${body.length} B ${body.slice(0, 140)}` });
  },
  info(text) {
    push({ kind: 'info', text });
  },
  model(name, path) {
    push({ kind: 'model', text: `${name} <- ${path} (bundled)` });
  },
  isLocal,
  dump() {
    return entries.map((e) => `${e.t} [${e.kind}] ${e.text}`).join('\n');
  },
};

export function installGuard() {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!isLocal(url)) {
      netlog.blocked(url, 'fetch');
      return Promise.reject(new TypeError(`Tulay offline guard blocked ${url}`));
    }
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (!isLocal(url)) {
      netlog.blocked(url, 'xhr');
      throw new TypeError(`Tulay offline guard blocked ${url}`);
    }
    return origOpen.call(this, method, url, ...rest);
  };

  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    netlog.blocked(url, 'websocket');
    throw new TypeError('Tulay offline guard: WebSocket disabled');
  };
  window.WebSocket.prototype = OrigWS.prototype;

  if (navigator.sendBeacon) {
    navigator.sendBeacon = (url) => {
      netlog.blocked(url, 'beacon');
      return false;
    };
  }

  document.addEventListener('securitypolicyviolation', (e) => {
    netlog.blocked(e.blockedURI || '(inline)', `CSP ${e.effectiveDirective}`);
  });

  if ('PerformanceObserver' in window) {
    for (const r of performance.getEntriesByType('resource')) netlog.resource(r.name);
    new PerformanceObserver((list) => {
      for (const r of list.getEntries()) netlog.resource(r.name);
    }).observe({ type: 'resource', buffered: false });
  }
}
