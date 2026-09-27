import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

/**
 * Minimal MCP (Model Context Protocol) stdio client.
 * Connects to an MCP server via JSON-RPC 2.0 over child process stdin/stdout.
 * Used by the agent harness to register external tools.
 *
 * Hardening notes:
 * - Children get a hermetic environment by default (PATH + home only); the full
 *   server process env (which may carry AUTH_TOKEN / provider keys on self-hosts)
 *   is merged in only when CAPSULE_MCP_INHERIT_ENV=1 is set explicitly. The HTTP
 *   route additionally refuses sensitive-looking user env keys outright.
 * - stdout is buffered at most 8 MB at a time — a flooding server is killed and
 *   its pending requests rejected instead of pinning the host's memory.
 * - Tool results larger than 1 MB are refused.
 * - close() escalates SIGTERM → SIGKILL; respawn() recreates a dead client.
 */
const MAX_STDIO_BUFFER = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const SENSITIVE_ENV_RE = /(key|token|secret|passw)/i;

export function looksSensitiveEnvKey(key) {
  return SENSITIVE_ENV_RE.test(String(key));
}

// Minimal base environment every MCP child needs to run at all: enough for
// PATH resolution, caches, and Windows system roots, nothing secret-bearing.
export function baseChildEnv() {
  const source = process.env;
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_PATH'];
  const out = {};
  for (const key of keep) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

export class McpClient {
  constructor({ command, args = [], env = {}, timeout = 15_000 } = {}) {
    this.command = String(command);
    this.args = args.map(String);
    this.userEnv = { ...env };
    const inherit = process.env.CAPSULE_MCP_INHERIT_ENV === '1';
    const base = inherit ? { ...process.env } : baseChildEnv();
    this.env = { ...base, ...env };
    this.timeout = timeout;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.tools = [];
    this._closed = false;
    this._bufferOverflow = null;
  }

  async connect() {
    if (this.child) return this.serverInfo;
    // Windows cannot spawn .cmd/.bat shims (npx, uvx) directly.
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(this.command);
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      shell: useShell,
    });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', () => {});
    this.child.on('error', (e) => this._rejectAll(e));
    this.child.on('exit', (code) => { this._closed = true; this._rejectAll(new Error('MCP server exited with code ' + code)); });
    const res = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capsule-agent', version: '1.0.0' },
    });
    this.serverInfo = res.serverInfo || {};
    this.serverCapabilities = res.capabilities || {};
    await this._request('notifications/initialized', {});
    if (this.serverCapabilities?.tools) {
      const list = await this._request('tools/list', {});
      this.tools = list.tools || [];
    }
    return this.serverInfo;
  }

  async callTool(name, args = {}) {
    if (!this.child || this._closed) throw new Error('MCP client is closed');
    if (this._bufferOverflow) throw this._bufferOverflow;
    const res = await this._request('tools/call', { name, arguments: args });
    const bytes = Buffer.byteLength((typeof res === 'string' ? res : JSON.stringify(res ?? {})));
    if (bytes > MAX_RESULT_BYTES) throw new Error('MCP tool result exceeds the 1 MB cap — the server must paginate its output');
    return res;
  }

  async close() {
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.kill('SIGTERM'); } catch {}
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      killer.unref?.();
    }
    this._closed = true;
    this._rejectAll(new Error('MCP client closed'));
  }

  async respawn() {
    const revived = new McpClient({ command: this.command, args: [...this.args], env: { ...this.userEnv }, timeout: this.timeout });
    await revived.connect();
    return revived;
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_STDIO_BUFFER) {
      this._bufferOverflow = new Error('MCP server flooded stdout past 8 MB — cut off to protect the Capsule');
      this.buffer = '';
      this._closed = true;
      this._rejectAll(this._bufferOverflow);
      try { this.child?.kill('SIGKILL'); } catch {}
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else if (this._bufferOverflow) reject(this._bufferOverflow);
          else resolve(msg.result);
        }
      } catch {}
    }
  }

  _request(method, params) {
    if (this._closed) return Promise.reject(new Error('MCP client closed'));
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timeout: ' + method)); }, this.timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.child.stdin.write(msg + '\n');
    });
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}