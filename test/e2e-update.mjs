// A phone that saved the app offline must pick up a new deploy by itself:
//   1. serve a copy of app/; save it offline the way older versions did (one cache per version);
//   2. "deploy" a change (index.html text) and rebuild the manifest;
//   3. reload: the old copy is migrated by hash into the new cache;
//   4. deploy again: the next start downloads only the changed file and reloads itself into it;
//   5. kill the server and reload: the new version still runs offline.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const copy = path.join(here, 'app-copy');
const PORT = 8131;
const ORIGIN = `http://127.0.0.1:${PORT}`;

rmSync(copy, { recursive: true, force: true });
try {
  execFileSync('cp', ['-Rc', path.join(root, 'app'), copy]); // APFS clone: instant, no extra space
} catch {
  execFileSync('cp', ['-R', path.join(root, 'app'), copy]);
}
const buildManifest = () => execFileSync('python3', [path.join(root, 'scripts/build_manifest.py'), copy]).toString().trim();
console.log(`  v1 manifest: ${buildManifest()}`);
const serve = () => spawn('python3', [path.join(root, 'scripts/serve.py'), '--port', String(PORT), '--dir', copy], { stdio: 'ignore' });
let server = serve();
await new Promise((r) => setTimeout(r, 800));

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const step = (s) => console.log(`\n== ${s}`);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/`);
await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready, null, { timeout: 10000 });

step('v1 saved offline the old way (one cache named by version)');
const v1 = await page.evaluate(async () => {
  const m = await (await fetch('asset-manifest.json', { cache: 'no-store' })).json();
  const cache = await caches.open(`twolay-${m.version}`);
  for (const f of [...m.files, './asset-manifest.json']) await cache.put(new URL(f, location.href), await fetch(f, { cache: 'no-store' }));
  return { version: m.version, files: m.files.length };
});
console.log(`  saved ${v1.files} files as twolay-${v1.version}`);

step('deploy v2: change the home text, rebuild the manifest');
const indexPath = path.join(copy, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('Sign ↔ Boses, sa iisang phone, walang internet.', 'BAGONG BERSYON v2'));
console.log(`  v2 manifest: ${buildManifest()}`);

step('reload on v2: migrate the old cache by hash, then update');
await page.reload();
await page.waitForFunction(() => /BAGONG BERSYON v2/.test(document.querySelector('#home .sub')?.textContent || ''), null, { timeout: 60000 });
const installed = () => page.evaluate(async () => {
  const keys = await caches.keys();
  const inst = await (await (await caches.open('twolay-files')).match(new URL('__installed.json', location.href)))?.json();
  return { keys, version: inst?.version, complete: inst?.complete, n: Object.keys(inst?.hashes ?? {}).length };
});
let state;
for (let i = 0; i < 240; i++) {
  state = await installed();
  if (state.complete && !state.keys.some((k) => k !== 'twolay-files')) break;
  await page.waitForTimeout(500);
}
console.log(`  caches: ${state.keys.join(', ')} | installed ${state.version} complete=${state.complete} files=${state.n}`);
check(!state.keys.some((k) => k !== 'twolay-files'), 'old per-version cache removed');
check(state.complete && state.n === v1.files, 'every file saved under the new scheme');

step('deploy v3: the saved phone fetches only what changed and reloads itself');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('BAGONG BERSYON v2', 'BAGONG BERSYON v3'));
console.log(`  v3 manifest: ${buildManifest()}`);
const fetched = [];
page.on('response', (r) => { if (r.url().startsWith(ORIGIN) && !r.fromServiceWorker()) fetched.push(new URL(r.url()).pathname); });
await page.reload();
await page.waitForFunction(() => /BAGONG BERSYON v3/.test(document.querySelector('#home .sub')?.textContent || ''), null, { timeout: 60000 });
check(true, 'home shows the v3 text without saving again');
const served = fetched.filter((p) => !/asset-manifest|sw\.js/.test(p));
console.log(`  requests that reached the server: ${served.join(', ') || 'none'}`);
check(served.every((p) => p === '/' || p === '/index.html'), 'only index.html was downloaded');

step('server down: v3 still runs');
server.kill();
await new Promise((r) => setTimeout(r, 500));
await page.reload();
await page.waitForFunction(() => /BAGONG BERSYON v3/.test(document.querySelector('#home .sub')?.textContent || ''), null, { timeout: 30000 });
check(true, 'v3 loads offline');
await page.click('#start-btn');
await page.waitForFunction(() => /Naglo-load|Magsalita/.test(document.querySelector('#u-mic').textContent), null, { timeout: 30000 });
check(true, 'Usap screen opens offline');

await browser.close();
server.kill();
rmSync(copy, { recursive: true, force: true });
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
