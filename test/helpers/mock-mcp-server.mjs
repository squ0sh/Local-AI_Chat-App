import { writeFileSync } from 'fs';
import { join } from 'path';

export function mockMcpServerPath(dir) {
  const path = join(dir, 'mock-mcp-server.cjs');
  writeFileSync(path, `
let buf = '';
process.stdin.setEncoding('utf8');
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  switch (m.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0.1.0' } } });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'echos input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
      break;
    case 'tools/call':
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] } });
      break;
    default:
      send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
}
process.stdin.on('data', (d) => {
  buf += d;
  while (true) {
    const i = buf.indexOf('\\n');
    if (i === -1) break;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(line);
  }
});
`);
  return path;
}

export function closeMockMcpServer() {}