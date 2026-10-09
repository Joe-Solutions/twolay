// Two isolated browser contexts ("two phones") pair over WebRTC with the paste-code fallback
// (same codes the QR carries), then exchange a message. No STUN/TURN, no signalling server.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8126;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn('python3', [path.join(here, '../scripts/serve.py'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const external = [];

async function phone(role) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    external.push(u);
    return r.abort();
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`  [${role} pageerror] ${e.message}`));
  await p.goto(`${ORIGIN}/?role=${role}`);
  await p.click('#setup-btn');
  return p;
}

const a = await phone('kamay');
const b = await phone('boses');

await a.click('#p2p-offer');
await a.waitForFunction(() => document.querySelector('#code-out').value.startsWith('T'), null, { timeout: 10000 });
const offer = await a.inputValue('#code-out');
console.log(`offer code: ${offer.length} chars`);

await b.click('details summary');
await b.fill('#code-in', offer);
await b.click('#code-apply');
await b.waitForFunction(() => document.querySelector('#code-out').value.startsWith('T'), null, { timeout: 10000 });
const answer = await b.inputValue('#code-out');
console.log(`answer code: ${answer.length} chars`);

await a.click('details summary');
await a.fill('#code-in', answer);
await a.click('#code-apply');
await a.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });
await b.waitForFunction(() => document.querySelector('#link-pill').textContent.includes('Konektado'), null, { timeout: 15000 });
console.log(`A: ${await a.textContent('#link-status')}`);
console.log(`B: ${await b.textContent('#link-status')}`);

await a.click('#ping');
await b.waitForFunction(() => document.querySelector('#toast').textContent.includes('Natanggap'), null, { timeout: 5000 });
console.log(`B received ping: ${await b.textContent('#toast')}`);
const route = await a.evaluate(async () => (await import('./js/netlog.js')).netlog.entries.filter((e) => e.text.includes('route')).map((e) => e.text));
console.log(`route: ${route.join(' ')}`);
console.log(`requests that tried to leave 127.0.0.1: ${external.length}`);
await browser.close();
server.kill();
