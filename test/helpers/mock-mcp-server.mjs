import { writeFileSync } from 'fs';
import { join } from 'path';

export function mockMcpServerPath(dir) {
  const path = join(dir, 'mock-mcp-server.cjs');
  writeFileSync(path, `
// Mock MCP server over stdin/stdout JSON-RPC. Test behaviours:
//  - echo                               → returns its text argument
//  - __crash                            → process exits with code 1
//  - __flood                            → answers, then writes >8 MB of junk to stdout
//  - __big                              → returns a result larger than 1 MB
//  - MOCK_ENV_FILE env at process start → writes sorted env-var names there
if (process.env.MOCK_ENV_FILE) {
  try { require('fs').writeFileSync(process.env.MOCK_ENV_FILE, JSON.stringify(Object.keys(process.env).sort())); } catch {}
}
let buf = '';
process.stdin.setEncoding('utf8');
const keepAlive = setInterval(() => {}, 1000);
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
      {
        const name = m.params && m.params.name;
        const argText = (m.params && m.params.arguments && m.params.arguments.text) || '';
        if (name === '__crash') { process.exit(1); return; }
        if (name === '__flood') {
          send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'flooding' }] } });
          const junk = 'x'.repeat(1024 * 1024);
          const pump = () => { for (let i = 0; i < 12; i += 1) process.stdout.write(junk); setTimeout(pump, 5); };
          pump();
          return;
        }
        if (name === '__big') {
          send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'x'.repeat(1_500_000) }] } });
          return;
        }
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(argText) }] } });
      }
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
