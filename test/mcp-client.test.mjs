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

test('McpClient hardening: child env stays hermetic even if legacy inherit is requested', () => {
  process.env.LOCAL_AI_TEST_SECRET = 'exists-on-host-only';
  try {
    const sealed = new McpClient({ command: 'node', env: { MY_FLAG: '1' } });
    assert.equal(sealed.env.LOCAL_AI_TEST_SECRET, undefined, 'host env must not leak into MCP children by default');
    assert.equal(sealed.env.MY_FLAG, '1', 'caller env passes through');
    assert.ok(sealed.env.PATH, 'PATH survives for command resolution');
    process.env.CAPSULE_MCP_INHERIT_ENV = '1';
    const inherited = new McpClient({ command: 'node' });
    assert.equal(inherited.env.LOCAL_AI_TEST_SECRET, undefined, 'legacy inherit flag cannot expose host secrets');
  } finally {
    delete process.env.CAPSULE_MCP_INHERIT_ENV;
    delete process.env.LOCAL_AI_TEST_SECRET;
  }
});

test('McpClient cuts off a server that floods stdout', async () => {
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  await client.connect();
  const flood = await client.callTool('__flood', {});
  assert.equal(flood.content[0].text, 'flooding');
  await assert.rejects(() => client.callTool('echo', { text: 'still there?' }), /flooded stdout past 8 MB/);
  assert.equal(client._closed, true);
});

test('McpClient refuses tool results larger than 1 MB', async () => {
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  await client.connect();
  await assert.rejects(() => client.callTool('__big', {}), /1 MB cap/);
  await client.close();
});

test('McpClient respawns a dead server with the same spec', async () => {
  const client = new McpClient({ command: process.execPath, args: [serverPath] });
  await client.connect();
  await assert.rejects(() => client.callTool('__crash', {}), /exited/i);
  assert.equal(client._closed, true);
  const revived = await client.respawn();
  assert.equal(revived._closed, false);
  const result = await revived.callTool('echo', { text: 'back again' });
  assert.equal(result.content[0].text, 'back again');
  await revived.close();
});
