// tools/ui-probes.mjs — browser-level UX regression probes.
//
// Spawns an isolated app server (temp data dir, dead Ollama_URL) plus a
// headless Chromium over CDP, then runs the assertion suite that guards the
// guided-UX behaviors (first-run model nudge, humanized errors, status dialog,
// launcher labels, voice setup view, image panel states, agent Retry, remote
// fold, FreeLLMAPI router row against a local mock).
//
// Usage:  npm run ui-probe
//         CHROME_BIN=/path/to/chromium node tools/ui-probes.mjs
//
// Skips cleanly (exit 0 with a notice) when no Chromium/Chrome binary exists.
import { spawn } from 'child_process';
import { createServer } from 'http';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
};

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function findChromium() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && existsSync(p)) return p;
    } catch {}
  }
  return '';
}

const chrome = findChromium();
if (!chrome) {
  console.log('ui-probe: SKIPPED — no Chromium/Chrome found. Install chromium or set CHROME_BIN, then run again.');
  process.exit(0);
}

const appPort = await freePort();
const cdpPort = await freePort();
const routerPort = await freePort();
const dataDir = mkdtempSync(join(tmpdir(), 'ui-probe-data-'));
const profileDir = mkdtempSync(join(tmpdir(), 'ui-probe-chrome-'));
const stickDir = mkdtempSync(join(tmpdir(), 'ui-probe-stick-'));

// A minimal FreeLLMAPI-shaped mock so the router row has something to see.
const mockRouter = createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"object":"list","data":[]}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
});
await new Promise((resolve) => mockRouter.listen(routerPort, '127.0.0.1', resolve));

const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(appPort)], {
  cwd: repoRoot,
  env: { ...process.env, LOCAL_AI_DATA_DIR: dataDir, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_USB_SCAN_ROOTS: stickDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check',
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const cleanup = async (code) => {
  try { browser.kill('SIGKILL'); } catch {}
  try { server.kill(); } catch {}
  try { mockRouter.close(); } catch {}
  // Chromium can still be writing its profile for a beat after SIGKILL; retry.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(stickDir, { recursive: true, force: true });
      break;
    } catch {}
  }
  process.exit(code);
};
process.on('SIGINT', () => { cleanup(130); });

// CDP plumbing
const waitFor = async (fn, tries = 60, gap = 250) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, gap)); } return null; };
const version = await waitFor(async () => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json()), 60, 250);
if (!version) { console.error('ui-probe: Chromium did not start.\n' + serverLog.slice(-500)); cleanup(1); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
const sendCdp = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const { targetId } = await sendCdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await sendCdp('Target.attachToTarget', { targetId, flatten: true });
const tab = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const ev = async (expression) => {
  const r = await tab('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page-eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await tab('Page.enable');
// Deterministic new-user environment: no stored state, no browser speech APIs
// (forces the voice "guided setup" path), silenced alerts.
await tab('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.clear();sessionStorage.clear()}catch(e){}; window.alert=(m)=>{window.__lastAlert=String(m)}; delete window.SpeechRecognition; delete window.webkitSpeechRecognition; delete window.SpeechSynthesisUtterance; delete window.speechSynthesis;" });
await tab('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });

const booted = await waitFor(() => ev("!!document.getElementById('input') && !!document.getElementById('model-installer-launch')"));
if (!booted) { console.error('ui-probe: app did not boot.\n' + serverLog.slice(-800)); cleanup(1); }
await sleep(1200);

// ── First-run / Batch A ──────────────────────────────────────────────────────
ok('launcher labels present (model/vault/remote/cloud)', await ev("!!document.getElementById('model-installer-launch') && !!document.getElementById('vault-launch') && !!document.getElementById('remote-launch') && !!document.getElementById('cloud-launch')"));
ok('empty model select is actionable', /install|Engine off/i.test(await ev("document.getElementById('model-select').options[0]?.textContent || ''")));

await ev("document.getElementById('input').value='first-run probe';document.getElementById('send').click()");
await sleep(2500);
ok('no-model send shows guidance row', await ev("!!document.querySelector('.nudge')"));
ok('guidance names the situation', /No local model yet/i.test(await ev("document.querySelector('.nudge')?.textContent || ''")));
ok('typed message is preserved', (await ev("document.getElementById('input').value")) === 'first-run probe');
ok('install CTA exists in guidance', /Install/i.test(await ev("document.querySelector('.nudge .plain-btn')?.textContent || ''")));
await ev("document.querySelector('.nudge .plain-btn')?.click()");
await sleep(1000);
ok('CTA opens the model library', await ev("!!document.querySelector('#model-library-dialog[open], dialog[open]')"));
await ev("[...document.querySelectorAll('dialog[open]')].forEach(d=>d.close())");

ok('humanizer: engine down', /local engine is not answering/i.test(await ev("window.humanizeErrorText('TypeError: fetch failed')")));
ok('humanizer: 401 key', /API key was rejected/i.test(await ev("window.humanizeErrorText('HTTP 401')")));
ok('humanizer: rate limit', /rate limit/i.test(await ev("window.humanizeErrorText('HTTP 429')")));

const connText = await ev("document.getElementById('connection-text').textContent");
ok('status line has no “Ollama offline” jargon', !/Ollama offline/i.test(connText), connText);
await ev("document.getElementById('connection').click()");
await sleep(900);
ok('status dialog offers a plain verdict', /not reachable|Everything is running|Cloud mode|Cannot reach/i.test(await ev("document.querySelector('#engine-kind')?.textContent || ''")));
await ev("document.querySelector('#engine-close')?.click()");

// ── Setup checklist on the welcome screen ────────────────────────────────────
await sleep(1200);
ok('setup checklist appears on empty chat', await ev("!!document.querySelector('.welcome .setup-card')"));
const checklistText = await ev("document.querySelector('.welcome .setup-card')?.textContent || ''");
ok('checklist flags the missing engine+model', /Start the local engine/i.test(checklistText) && /Install your first model/i.test(checklistText), checklistText.slice(0, 120));
ok('checklist offers optional extras', /Optional/i.test(checklistText) && /FreeLLMAPI/i.test(checklistText));
await ev("document.querySelector('.setup-card .setup-head .plain-btn')?.click()");
await sleep(300);
ok('checklist hides on demand', !(await ev("!!document.querySelector('.welcome .setup-card')")));

// ── Voice guided setup (speech APIs were removed above) ─────────────────────
await ev("window.__lastAlert=''; document.getElementById('mic-button').click()");
await sleep(1200);
ok('voice without model → nudge, not alert', (await ev("!!document.querySelector('.nudge')")) && !(await ev("!!window.__lastAlert")));
await ev("const s=document.getElementById('model-select');s.innerHTML='<option value=\"stub\">stub-model</option>';s.value='stub';");
await ev("document.getElementById('mic-button').click()");
await sleep(2200);
ok('voice opens guided setup view (no alert)', (await ev("document.querySelector('.voice-mode').dataset.state || ''")) === 'setup' && !(await ev("window.__lastAlert||''")).length, await ev("window.__lastAlert||''"));
ok('setup view explains itself', /one-time setup/i.test(await ev("document.querySelector('.voice-mode .voice-state')?.textContent || ''")));
ok('setup view shows the install CTA', !(await ev("document.querySelector('.voice-install').hidden")));
await ev("document.querySelector('.voice-mode .end')?.click()");
await sleep(400);

// ── Image mode states ────────────────────────────────────────────────────────
await ev("document.getElementById('mode-images').click()");
await sleep(1800);
ok('image install panel shown when engine missing', !(await ev("document.getElementById('img-install').hidden")));
ok('install progress bar exists and starts hidden', (await ev("document.getElementById('img-install-bar')") && await ev("document.getElementById('img-install-bar').hidden")) === true);
ok('empty gallery explains the prerequisite', /once the image engine is installed/i.test(await ev("document.getElementById('img-gallery').textContent")));

// ── Agent failure gets a real Retry ──────────────────────────────────────────
await ev("document.getElementById('mode-chat').click()");
await sleep(400);
await ev("(() => { const s=document.getElementById('model-select'); if (![...s.options].some(o=>o.value==='stub')) s.innerHTML='<option value=\"stub\">stub-model</option>'; s.value='stub'; })()");
await ev("window.runAgentTask('ui-probe task — expected to fail')");
await sleep(8000);
ok('agent failure cards carry a Retry button', await ev("[...document.querySelectorAll('.agent-terminal-event.error .plain-btn')].some(b=>b.textContent==='Retry')"), await ev("[...document.querySelectorAll('.agent-terminal-event')].map(x=>x.querySelector('.agent-event-title')?.textContent).join(';')"));

// ── Critic chip ──────────────────────────────────────────────────────────────
ok('critic chip exists', await ev("!!document.getElementById('agent-critic-toggle')"));
await ev("window.__agentBodies=[];const _f=window.fetch;window.fetch=(u,i={})=>{if(String(u).includes('/api/agent/loop')&&i.body){try{window.__agentBodies.push(!!JSON.parse(i.body).critic)}catch{}}return _f(u,i)}",);
await ev("document.getElementById('agent-critic-toggle').click()"); // default → explicit choice
await sleep(400);
ok('critic chip toggle persists choice', await ev("localStorage.getItem('local-ai-agent-critic')") === '1' || await ev("localStorage.getItem('local-ai-agent-critic')") === '0');
await ev("(() => { const s=document.getElementById('model-select'); if (![...s.options].some(o=>o.value==='stub')) s.innerHTML='<option value=\"stub\">stub-model</option>'; s.value='stub'; })()");
await ev("window.runAgentTask('critic probe run')");
await sleep(2500);
ok('agent loop request carries the critic flag', await ev("window.__agentBodies.length > 0"));

// ── Teach once: save-approach flow + suggestion chip ────────────────────────
await ev("window.agentSetEnabled && window.agentSetEnabled(true)");
await sleep(400);
await ev("window.openProcedureSaveDialog({task:'probe: resize screenshots',content:'done by resizing to 1024px',trail:['list_dir','run_command']})");
await sleep(1600);
ok('save-approach dialog opens with offline template', await ev("!!document.querySelector('dialog[open]')") && /run_command/.test(await ev("document.querySelector('#proc-steps')?.value || ''")));
await ev("document.querySelector('#proc-name').value='Screenshot resize ritual'");
await ev("document.querySelector('#proc-save').click()");
await sleep(1000);
ok('procedure saved server-side', (await ev("(async()=>(await fetch('/api/agent/procedures')).json())()")).procedures?.length >= 1);
await ev("[...document.querySelectorAll('dialog[open]')].forEach(d=>d.close())");
await ev("(() => { const i=document.getElementById('input'); i.value='please resize my screenshots into smaller images'; i.dispatchEvent(new Event('input')); })()");
await sleep(1500);
ok('suggestion chip appears for a matching task', /Use your procedure/.test(await ev("[...document.querySelectorAll('#agent-procedure-chips button')].map(b=>b.textContent).join(' ')")));
await ev("[...document.querySelectorAll('#agent-procedure-chips button')].find(b=>/Use/.test(b.textContent))?.click()");
await sleep(400);
ok('using the chip stages the procedure for the next run', /resize/i.test(await ev("window.__pendingProcedurePrompt||''")));
ok('use counted server-side', (await (await fetch(`http://127.0.0.1:${appPort}/api/agent/procedures`)).json()).procedures?.[0]?.uses >= 1);

// ── Remote dialog ────────────────────────────────────────────────────────────
await ev("document.getElementById('remote-launch').click()");
await sleep(900);
ok('remote idle copy says what Start does', /Start it to get a shareable link/i.test(await ev("document.getElementById('remote-details').textContent")));
ok('advanced internals folded away while idle', (await ev("!!document.getElementById('remote-advanced')")) && (await ev("document.getElementById('remote-advanced').hidden")));
await ev("document.querySelector('#remote-close')?.click()");

// ── USB kit builder in the Pack dialog ───────────────────────────────────────
await ev("document.getElementById('portable-launch').click()");
await sleep(2000);
ok('usb block renders in Pack dialog', await ev("!!document.querySelector('.usb-block')"));
ok('detected drive listed', await ev("[...document.querySelectorAll('.usb-drive')].length === 1"));
await ev("document.querySelector('.usb-drive input')?.click()");
await sleep(1500);
ok('payload options render after selecting a drive', await ev("[...document.querySelectorAll('[data-usb-opt]')].length >= 5"));
ok('size estimate shown', /Kit size ≈/.test(await ev("document.querySelector('#usb-status')?.textContent || ''")));
ok('private data is off by default', await ev("[...document.querySelectorAll('[data-usb-opt]')].find(x=>x.dataset.usbOpt==='data')?.checked === false"));
// Keep the probe fast: app files only (runtimes off → target self-heals them).
await ev("(() => { for (const k of ['runtimes','models']) { const el=document.querySelector(`[data-usb-opt='${k}']`); if (el && el.checked) { el.checked=false; el.dispatchEvent(new Event('change')); } } })()");
await ev("document.getElementById('usb-start').click()");
await sleep(1500);
let done = false;
for (let i = 0; i < 60; i++) { const t = await ev("document.querySelector('#usb-status')?.textContent || ''"); if (/Done —/.test(t)) { done = true; break; } if (/failed|error/i.test(t)) break; await sleep(700); }
ok('usb kit copied + verified', done, await ev("document.querySelector('#usb-status')?.textContent || ''"));
await ev("document.querySelector('#portable-close')?.click()");

// ── FreeLLMAPI row against the local mock ────────────────────────────────────
await ev("document.getElementById('cloud-launch').click()");
await sleep(500);
await ev("(() => { const p=document.getElementById('cloud-provider'); p.value='freellmapi'; p.dispatchEvent(new Event('change')); })()");
await sleep(300);
await ev(`(() => { const b=document.getElementById('cloud-base-url'); b.value='http://127.0.0.1:${routerPort}/v1'; b.dispatchEvent(new Event('input')); })()`);
await sleep(1500);
ok('router row reports the mock as Running', /Running/.test(await ev("document.getElementById('rf-text').textContent")), await ev("document.getElementById('rf-text').textContent"));
ok('dashboard link derives from base URL', (await ev("document.getElementById('rf-open').getAttribute('href')")) === `http://127.0.0.1:${routerPort}/`);
ok('guide points at the unified key', /Keys/.test(await ev("document.getElementById('rf-guide').textContent")));
ok('start hidden while router runs', await ev("document.getElementById('rf-start').hidden"));
await ev("(() => { const b=document.getElementById('cloud-base-url'); b.value='http://127.0.0.1:" + (await freePort()) + "/v1'; b.dispatchEvent(new Event('input')); })()");
await sleep(1500);
ok('dead port reports Not running', /Not running/.test(await ev("document.getElementById('rf-text').textContent")));

console.log(`\nui-probe: ${pass} passed, ${fail} failed`);
cleanup(fail ? 1 : 0);
