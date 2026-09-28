import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mockMcpServerPath,
  closeMockMcpServer,
} from './helpers/mock-mcp-server.mjs';
import { McpClient } from '../lib/mcp-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

let dir;
let serverPath;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  serverPath = mockMcpServerPath(dir);
});
test.after(() => {
  closeMockMcpServer();
  rmSync(dir, { recursive: true, force: true });
});

test('McpClient rejects when server is not found', async () => {
  const client = new McpClient({ command: '/nonexistent/mcp-server-abc' });
  await assert.rejects(() => client.connect(), /exit|spawn|ENOENT/i);
});

test('McpClient connects to a mock stdio server, lists tools, and calls one', async () => {
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  const info = await client.connect();
  assert.equal(info.name, 'mock');
  assert.equal(client.tools.length, 1);
  assert.equal(client.tools[0].name, 'echo');
  const result = await client.callTool('echo', { text: 'hello' });
  assert.equal(result.content[0].text, 'hello');
  await client.close();
  assert.equal(client._closed, true);
});

test('McpClient callTool rejects after close', async () => {
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  await client.connect();
  await client.close();
  await assert.rejects(() => client.callTool('echo', { text: 'x' }), /closed/i);
});

test('McpClient does not inherit application secrets', async () => {
  const path = join(dir, 'mcp-env.cjs');
  writeFileSync(path, `
const keepAlive = setInterval(() => {}, 1000);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id == null) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env-check' } }
      : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`);
  const previous = process.env.AUTH_TOKEN;
  process.env.AUTH_TOKEN = 'must-not-reach-mcp';
  const client = new McpClient({ command: process.execPath, args: [path], timeout: 500 });
  try {
    await client.connect();
    assert.equal(client.env.AUTH_TOKEN, undefined);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = previous;
  }
});

test('McpClient terminates oversized unframed stdout', async () => {
  const path = join(dir, 'mcp-overflow.cjs');
  writeFileSync(path, `process.stdout.write('x'.repeat(1_100_000)); setInterval(() => {}, 1000);`);
  const client = new McpClient({ command: process.execPath, args: [path], timeout: 1000 });
  await assert.rejects(() => client.connect(), /1 MB|exceeded/i);
  await client.close();
});

test('McpClient times out and clears a pending request', async () => {
  const path = join(dir, 'mcp-timeout.cjs');
  writeFileSync(path, `process.stdin.resume(); setInterval(() => {}, 1000);`);
  const client = new McpClient({ command: process.execPath, args: [path], timeout: 50 });
  await assert.rejects(() => client.connect(), /timeout/i);
  assert.equal(client.pending.size, 0);
  await client.close();
});
