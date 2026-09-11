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