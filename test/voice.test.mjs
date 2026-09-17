import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { cleanSpeechText, speechChunks, speechDecision } from '../lib/voice.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netCreateServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

test('cleanSpeechText trims filler and collapses whitespace', () => {
  assert.equal(cleanSpeechText('  okay so let’s deploy the fix now.  '), 'let’s deploy the fix now.');
  assert.equal(cleanSpeechText('Hey, can you review this project?'), 'can you review this project?');
  assert.equal(cleanSpeechText('   '), '');
});

test('speechChunks returns whole short lines and buckets long ones', () => {
  assert.deepEqual(speechChunks('Run the tests and tell me the result.'), ['Run the tests and tell me the result.']);
  const long = 'First whole sentence that fits. '.repeat(20);
  const chunks = speechChunks(long);
  assert.ok(chunks.length > 1, 'long input splits into multiple chunks');
  for (const c of chunks) assert.ok(c.length <= 320, 'each chunk respects the cap');
  assert.equal(chunks.join(' ').length, long.trim().length, 'splitting preserves text length 1:1');
});

test('speechDecision parses yes/no/none from a transcript', () => {
  assert.equal(speechDecision('yes'), 'yes');
  assert.equal(speechDecision('Go ahead'), 'yes');
  assert.equal(speechDecision('I approve'), 'yes');
  assert.equal(speechDecision('sounds good'), 'yes');
  assert.equal(speechDecision('no'), 'no');
  assert.equal(speechDecision('not now'), 'no');
  assert.equal(speechDecision('honor the defer'), 'no');
  assert.equal(speechDecision('nope'), 'no');
  assert.equal(speechDecision('deploy the server update now'), null);
  assert.equal(speechDecision('what is the weather'), null);
  assert.equal(speechDecision(''), null);
});

test('speech endpoints: status and install report idle without touching the network', async () => {
  const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'voice-server-data-'));
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, init);
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const waitReady = async () => {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/health'); if (r.status < 500) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready\n' + logs);
  };

  try {
    await waitReady();
    const jsonInit = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const status = await call('/api/speech/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.whisper, false, 'no whisper-cli in the test environment');
    assert.equal(status.body.piper, false, 'no piper in the test environment');
    assert.equal(status.body.installing, false);
    assert.ok('whisper_model' in status.body && 'piper_voice' in status.body, 'status carries the engine paths');

    const install = await call('/api/speech/install');
    assert.equal(install.status, 200);
    assert.equal(install.body.status, 'idle');
    assert.equal(install.body.installing, false);
    assert.equal(existsSync(join(dataDir, 'speech')), false, 'reading install status does not create the speech dir');

    const transcribe = await call('/api/speech/transcribe', jsonInit({ audioBase64: 'AAAA' }));
    assert.equal(transcribe.status, 400, 'transcribe refuses without whisper.cpp');
    assert.match(transcribe.body.error, /whisper\.cpp not detected/);

    const tts = await call('/api/speech/tts', jsonInit({ text: 'hello' }));
    assert.equal(tts.status, 400, 'tts refuses without piper');
    assert.match(tts.body.error, /piper not detected/);
  } finally {
    server.kill('SIGTERM');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});