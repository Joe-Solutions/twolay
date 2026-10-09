// Main-thread side of ai-worker.js: one shared worker, one MessagePort per model service.
import { netlog } from './netlog.js';

let hub;

function getHub() {
  if (hub) return hub;
  hub = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  hub.addEventListener('message', ({ data }) => {
    if (data.type !== 'net') return;
    if (data.blocked) netlog.blocked(data.url, 'ai-worker fetch');
    else netlog.resource(data.url, 'ai-worker');
  });
  hub.onerror = (e) => netlog.info(`ai worker error: ${e.message}`);
  return hub;
}

/** A port that behaves like a dedicated worker for one service: 'whisper', 'vad', 'kokoro' or 'translate'. */
export function connectAI(svc) {
  const { port1, port2 } = new MessageChannel();
  getHub().postMessage({ type: 'connect', svc, port: port2 }, [port2]);
  port1.start();
  return port1;
}
