// HTTP-level integration tests for server.mjs. Boats the real server in
// isolation (test/helpers/server-harness.mjs) against a hermetic fake Ollama
// (test/helpers/fake-ollama.mjs) and exercises the security and routing surface
// that library tests cannot reach: the multi-user auth gate, per-user chat
// stores, rate limiting, privacy enforcement, deny-egress, the Responses-API
// translation, the /v1 passthrough, and the MCP agent routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { bootServer, TEST_PASSWORD } from './helpers/server-harness.mjs';
import { startFakeOllama } from './helpers/fake-ollama.mjs';
import { mockMcpServerPath } from './helpers/mock-mcp-server.mjs';

const json = { 'Content-Type': 'application/json' };
const bearer = (token) => ({ Authorization: 'Bearer ' + token });

function collectSse(text) {
  return text.split('\n').filter((l) => l.startsWith('data: ') && l.slice(6).trim() !== '[DONE]')
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

// ── single-user baseline ────────────────────────────────────────────────────
test('single-user mode (no users.json) keeps the surface open', async (t) => {
  const ollama = await startFakeOllama(t);
  const { call } = await bootServer(t, { ollamaUrl: ollama.url, seedFiles: {} });
  const chats = await call('/api/chatstate');
  assert.equal(chats.status, 200);
  assert.deepEqual(chats.body.workspace, { chats: [], projects: [], activeId: '' });
  const models = await call('/v1/models');
  assert.equal(models.status, 200);
  assert.equal(models.body.object, 'list');
  assert.equal(models.body.data[0].id, 'fake-llama:3b');
  // The auth status probe is only defined when user accounts are enabled.
  const status = await call('/api/auth/status');
  assert.equal(status.status, 404);
});

// ── multi-user auth ─────────────────────────────────────────────────────────
test('multi-user gate protects every dynamic route but leaves the shell reachable', async (t) => {
  const gateBoot = await bootServer(t, { users: ['alice'] });
  for (const path of ['/health', '/api/chatstate', '/v1/models', '/api/models', '/api/agent/mcp/list']) {
    const r = await gateBoot.call(path);
    assert.equal(r.status, 401, path);
    assert.equal(r.body.code, 'login_required', path);
  }
  const status = await gateBoot.call('/api/auth/status');
  assert.deepEqual(status.body, { multiUser: true, username: '' });
  const shell = await fetch(gateBoot.base + '/');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<title>|Local AI/i);
});

test('login issues a bearer token and an HttpOnly cookie; logout invalidates', async (t) => {
  const { base, call } = await bootServer(t, { users: ['alice'] });

  const bad = await call('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'alice', password: 'wrong password 123' }) });
  assert.equal(bad.status, 401);

  const good = await fetch(base + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'alice', password: TEST_PASSWORD }) });
  assert.equal(good.status, 200);
  const signedIn = await good.json();
  assert.equal(signedIn.username, 'alice');
  assert.match(signedIn.token, /^[A-Za-z0-9_-]{43}$/);

  const me = await call('/api/auth/me', { headers: bearer(signedIn.token) });
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'alice');

  // The HttpOnly cookie works on its own (no bearer header).
  const cookie = (good.headers.get('set-cookie') || '').match(/capsule_session=([^;]+)/);
  assert.ok(cookie, 'login sets capsule_session');
  const viaCookie = await call('/api/auth/me', { headers: { Cookie: 'capsule_session=' + cookie[1] } });
  assert.equal(viaCookie.status, 200);

  const out = await call('/api/auth/logout', { method: 'POST', headers: bearer(signedIn.token) });
  assert.equal(out.status, 200);
  const after = await call('/api/auth/me', { headers: bearer(signedIn.token) });
  assert.equal(after.status, 401);
});

test('per-user chat history is sealed per account on disk', async (t) => {
  const { call, dataDir } = await bootServer(t, { users: ['alice', 'bob'] });
  const login = async (name) => (await call('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: name, password: TEST_PASSWORD }) })).body;
  const alice = await login('alice');
  const bob = await login('bob');

  const save = await call('/api/chatstate', {
    method: 'POST', headers: { ...json, ...bearer(alice.token) },
    body: JSON.stringify({ workspace: { chats: [{ id: 'chat-a1', title: 'Alice-only', messages: [{ role: 'user', content: 'top secret' }] }], projects: [], activeId: 'chat-a1' } }),
  });
  assert.equal(save.status, 200);

  const aliceState = await call('/api/chatstate', { headers: bearer(alice.token) });
  assert.equal(aliceState.body.workspace.chats.length, 1);
  assert.equal(aliceState.body.workspace.chats[0].title, 'Alice-only');

  const bobState = await call('/api/chatstate', { headers: bearer(bob.token) });
  assert.deepEqual(bobState.body.workspace.chats, []);
  // Alice's history is sealed on disk — no plaintext leaks into her store.
  assert.ok(existsSync(join(dataDir, 'users', 'alice', 'chats')));
  const onDisk = (await import('fs')).readFileSync(join(dataDir, 'users', 'alice', 'chats', 'workspace.json'), 'utf8');
  assert.doesNotMatch(onDisk, /top secret/);
});

// Pins the real brute-force path. The shared limiter is seeded with a small
// per-IP bucket (CAPSULE_RATE_PER_IP=5, refill 1/s), so a burst of bad logins
// genuinely drains it — every attempt still runs the full scrypt verify, and
// beyond the 5-token burst the bucket needs ~1 s to recover each token, which
// no login pace can outrun.
test('login endpoint rate-limits brute force with Retry-After', async (t) => {
  const { base } = await bootServer(t, {
    users: ['carol'],
    extraEnv: { CAPSULE_RATE_PER_IP: '5', CAPSULE_RATE_REFILL: '1' },
  });
  const attempt = () => fetch(base + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'carol', password: 'always wrong 123' }) });
  const responses = await Promise.all(Array.from({ length: 15 }, attempt));
  const statuses = responses.map((r) => r.status);
  assert.ok(statuses.slice(0, 5).includes(401), 'requests inside the burst capacity fail as unauthorized');
  const throttled = responses.filter((r) => r.status === 429);
  assert.ok(throttled.length >= 5, 'requests beyond the burst capacity are throttled');
  assert.ok(Number(throttled[0].headers.get('retry-after')) >= 1);
  assert.match((await throttled[0].json()).error, /Too many requests/);
});

test('Capsule Remote is refused when user accounts are enabled', async (t) => {
  const { call } = await bootServer(t, { users: ['alice'], extraEnv: { AUTH_TOKEN: 'remote-secret' } });
  const remote = await call('/remote/remote-secret');
  assert.equal(remote.status, 403);
  assert.match(remote.body.error, /Remote is disabled/);
  const keyLink = await call('/?capsule_key=remote-secret');
  assert.equal(keyLink.status, 403);
});

// ── privacy + egress ────────────────────────────────────────────────────────
const CLOUD_SEED = 'AI_PROVIDER=openai\nOPENAI_BASE_URL=http://127.0.0.1:1/v1\nOPENAI_API_KEY=sk-test\n';

test('privacy flag blocks cloud providers before any egress', async (t) => {
  const { base, call } = await bootServer(t, { seedFiles: { 'ai_settings.env': CLOUD_SEED } });
  const blocked = await call('/api/chat', { method: 'POST', headers: json, body: JSON.stringify({ mode: 'cloud', privacy: 'local', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /local-only/);
  // Control: privacy 'cloud' passes the gate, then fails on the dead backend as
  // a streamable error event — proving this test only guards the privacy branch.
  const cloud = await fetch(base + '/api/chat', { method: 'POST', headers: json, body: JSON.stringify({ mode: 'cloud', privacy: 'cloud', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(cloud.status, 200);
  const events = collectSse(await cloud.text());
  assert.ok(events.some((e) => e.type === 'error'), 'cloud control should fail on the dead upstream, not on privacy');
});

test('deny-egress refuses non-loopback upstreams', async (t) => {
  const r = await bootServer(t, {
    extraEnv: { CAPSULE_DENY_EGRESS: '1' },
    seedFiles: { 'ai_settings.env': 'AI_PROVIDER=openai\nOPENAI_BASE_URL=http://203.0.113.9/v1\nOPENAI_API_KEY=sk-test\n' },
  });
  const res = await r.call('/v1/chat/completions', { method: 'POST', headers: json, body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.ok(res.status >= 400);
  assert.match(JSON.stringify(res.body), /Egress denied/);
});

// ── Responses API translation + passthrough (fake Ollama) ───────────────────
test('/v1/responses translates to Ollama chat completions (non-stream)', async (t) => {
  const ollama = await startFakeOllama(t);
  const { call } = await bootServer(t, { ollamaUrl: ollama.url });
  const r = await call('/v1/responses', { method: 'POST', headers: json, body: JSON.stringify({ model: 'fake-llama:3b', instructions: 'be terse', input: 'hi' }) });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^resp_/);
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.output[0].type, 'message');
  assert.equal(r.body.output[0].content[0].text, 'hello world');
  assert.equal(r.body.usage.total_tokens, 5);
  // The unit hit Ollama's OpenAI surface with the translated messages.
  assert.equal(ollama.calls.length, 1);
  assert.equal(ollama.calls[0].path, '/v1/chat/completions');
  assert.deepEqual(ollama.calls[0].body.messages, [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }]);
  assert.equal(ollama.calls[0].body.stream, false);
});

test('/v1/responses streams the Responses event sequence', async (t) => {
  const ollama = await startFakeOllama(t);
  const { base } = await bootServer(t, { ollamaUrl: ollama.url });
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers: json, body: JSON.stringify({ model: 'fake-llama:3b', input: 'hi', stream: true }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = collectSse(await r.text());
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'response.created');
  assert.equal(types.filter((t) => t === 'response.output_text.delta').length, 3);
  const done = events.find((e) => e.type === 'response.content_part.done');
  assert.equal(done.part.text, 'hello world');
  assert.equal(types.at(-2), 'response.completed');
});

test('/v1/responses maps input items and tools to chat completions', async (t) => {
  const ollama = await startFakeOllama(t);
  const { call } = await bootServer(t, { ollamaUrl: ollama.url });
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'menu?' }] },
    { type: 'function_call', name: 'lookup', call_id: 'c1', arguments: { q: 'x' } },
    { type: 'function_call_output', call_id: 'c1', output: '42' },
  ];
  const tools = [{ type: 'function', name: 'lookup', description: 'look things up', parameters: { type: 'object', properties: {} } }];
  const r = await call('/v1/responses', { method: 'POST', headers: json, body: JSON.stringify({ model: 'fake-llama:3b', input, tools }) });
  assert.equal(r.status, 200);
  const sent = ollama.calls[0].body;
  assert.equal(sent.messages.length, 3);
  assert.deepEqual(sent.messages[0], { role: 'user', content: 'menu?' });
  assert.equal(sent.messages[1].role, 'assistant');
  assert.equal(sent.messages[1].tool_calls[0].function.name, 'lookup');
  assert.equal(sent.messages[1].tool_calls[0].function.arguments, '{"q":"x"}');
  assert.deepEqual(sent.messages[2], { role: 'tool', tool_call_id: 'c1', content: '42' });
  assert.deepEqual(sent.tools, [{ type: 'function', function: { name: 'lookup', description: 'look things up', parameters: { type: 'object', properties: {} } } }]);
});

test('/v1/chat/completions passes the SSE stream through', async (t) => {
  const ollama = await startFakeOllama(t);
  const { base } = await bootServer(t, { ollamaUrl: ollama.url });
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: json, body: JSON.stringify({ model: 'fake-llama:3b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.equal((text.match(/^data: /gm) || []).length, 4); // 3 token chunks + [DONE]
  assert.ok(text.includes('hello'));
  assert.ok(text.includes('data: [DONE]'));
});

test('/api/chat streams local tokens when privacy is local', async (t) => {
  const ollama = await startFakeOllama(t);
  const { base } = await bootServer(t, { ollamaUrl: ollama.url });
  const r = await fetch(base + '/api/chat', { method: 'POST', headers: json, body: JSON.stringify({ mode: 'local', privacy: 'local', model: 'fake-llama:3b', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(r.status, 200);
  const events = collectSse(await r.text());
  assert.equal(events.filter((e) => e.type === 'delta').length, 3);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.fullText, 'hello world');
});

// ── MCP over HTTP ───────────────────────────────────────────────────────────
test('mcp server end-to-end: register, list, call, unregister', async (t) => {
  const { root, call } = await bootServer(t);
  const mockDir = join(root, 'mock');
  mkdirSync(mockDir);
  const mock = mockMcpServerPath(mockDir);

  const reg = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ id: 'test-mock', command: process.execPath, args: [mock], env: {} }) });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.id, 'test-mock');
  assert.equal(reg.body.tools[0].name, 'echo');

  const list = await call('/api/agent/mcp/list');
  assert.equal(list.body.clients.length, 1);
  assert.equal(list.body.clients[0].id, 'test-mock');
  assert.equal(list.body.clients[0].serverInfo.name, 'mock');

  const called = await call('/api/agent/mcp/call', { method: 'POST', headers: json, body: JSON.stringify({ clientId: 'test-mock', tool: 'echo', arguments: { text: 'ping' } }) });
  assert.equal(called.status, 200);
  assert.equal(called.body.result.content[0].text, 'ping');

  const unreg = await call('/api/agent/mcp/unregister', { method: 'POST', headers: json, body: JSON.stringify({ id: 'test-mock' }) });
  assert.equal(unreg.status, 200);
  const after = await call('/api/agent/mcp/list');
  assert.deepEqual(after.body.clients, []);
});

// ── MCP hardening ───────────────────────────────────────────────────────────
test('mcp register rejects commands outside CAPSULE_MCP_ALLOW', async (t) => {
  const { call } = await bootServer(t);
  const notAllowed = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ command: 'bash', args: ['-c', 'echo hi'] }) });
  assert.equal(notAllowed.status, 403);
  assert.match(notAllowed.body.error, /not allowlisted/);
  assert.match(notAllowed.body.error, /CAPSULE_MCP_ALLOW/);
});

test('mcp register refuses secret-looking env keys outright', async (t) => {
  const { call } = await bootServer(t);
  const sensitive = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ command: 'node', args: ['server.js'], env: { AWS_SECRET_KEY: 'x' } }) });
  assert.equal(sensitive.status, 400);
  assert.match(sensitive.body.error, /secret-bearing/);
  assert.match(sensitive.body.error, /AWS_SECRET_KEY/);
});

test('plan mode blocks mcp register (it starts a process)', async (t) => {
  const { call } = await bootServer(t);
  const plan = await call('/api/agent/mode', { method: 'POST', headers: json, body: JSON.stringify({ mode: 'plan' }) });
  assert.equal(plan.status, 200);
  const register = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ command: 'node', args: ['server.js'] }) });
  assert.equal(register.status, 409);
  assert.equal(register.body.requiresBuild, true);
  await call('/api/agent/mode', { method: 'POST', headers: json, body: JSON.stringify({ mode: 'build' }) });
});

test('mcp children get a hermetic environment by default', async (t) => {
  const { root, call } = await bootServer(t);
  const mockDir = join(root, 'mock');
  mkdirSync(mockDir);
  const mock = mockMcpServerPath(mockDir);
  const envFile = join(root, 'mcp-env.json');
  const reg = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ id: 'env-mock', command: process.execPath, args: [mock], env: { MOCK_ENV_FILE: envFile } }) });
  assert.equal(reg.status, 200);
  const childEnv = JSON.parse(readFileSync(envFile, 'utf8'));
  assert.ok(Array.isArray(childEnv));
  assert.ok(childEnv.includes('PATH'), 'PATH survives for command resolution');
  assert.ok(childEnv.includes('MOCK_ENV_FILE'), 'caller env passes through');
  assert.ok(!childEnv.includes('LOCAL_AI_DATA_DIR'), 'server-internal env must not leak into the child');
});

test('a crashed mcp server is revived on the next call and journaled', async (t) => {
  const { root, dataDir, call } = await bootServer(t);
  const mockDir = join(root, 'mock');
  mkdirSync(mockDir);
  const mock = mockMcpServerPath(mockDir);
  const reg = await call('/api/agent/mcp/register', { method: 'POST', headers: json, body: JSON.stringify({ id: 'crasher', command: process.execPath, args: [mock], env: {} }) });
  assert.equal(reg.status, 200);

  const crashed = await call('/api/agent/mcp/call', { method: 'POST', headers: json, body: JSON.stringify({ clientId: 'crasher', tool: '__crash' }) });
  assert.equal(crashed.status, 502);
  assert.match(crashed.body.error, /exited/i);

  const revived = await call('/api/agent/mcp/call', { method: 'POST', headers: json, body: JSON.stringify({ clientId: 'crasher', tool: 'echo', arguments: { text: 'came back' } }) });
  assert.equal(revived.status, 200);
  assert.equal(revived.body.result.content[0].text, 'came back');

  const list = await call('/api/agent/mcp/list');
  assert.equal(list.body.clients[0].alive, true);

  const audit = readFileSync(join(dataDir, 'agent', 'mcp.log'), 'utf8');
  assert.match(audit, /"action":"register"/);
  assert.match(audit, /"action":"call"/);
  assert.match(audit, /"action":"respawn"/);
});