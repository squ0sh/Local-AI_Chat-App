import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

const MAX_STDOUT_BUFFER = 8 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TMPDIR', 'TMP', 'TEMP', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL',
];

function childEnvironment(extra) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof value === 'string' && value.length <= 16_384) env[key] = value;
  }
  return env;
}

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
    this.command = command;
    this.args = args;
    this.userEnv = { ...env };
    this.env = childEnvironment(env);
    this.timeout = timeout;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.tools = [];
    this._closed = false;
    this._bufferOverflow = null;
  }

  async connect() {
    if (this.child) return this.serverInfo;
    if (typeof this.command !== 'string' || !this.command || this.command.length > 1024) {
      throw new Error('A valid MCP executable is required');
    }
    if (!Array.isArray(this.args) || this.args.some((arg) => typeof arg !== 'string' || arg.length > 8192)) {
      throw new Error('MCP arguments must be bounded strings');
    }
    this._closed = false;
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      shell: false,
    });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (chunk) => {
      if (this.stderr.length < 16_384) this.stderr += chunk.toString();
    });
    this.child.on('error', (e) => this._fail(e));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      const wasClosed = this._closed;
      this._closed = true;
      if (!wasClosed) {
        const detail = this.stderr.trim() ? ': ' + this.stderr.trim().slice(0, 1000) : '';
        this._rejectAll(new Error('MCP server exited with code ' + code + (signal ? ' (' + signal + ')' : '') + detail));
      }
    });
    const res = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capsule-agent', version: '1.0.0' },
    });
    this.serverInfo = res.serverInfo || {};
    this.serverCapabilities = res.capabilities || {};
    this._notify('notifications/initialized', {});
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
      try { child.stdin.end(); } catch {}
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
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_STDOUT_BUFFER) {
      this._bufferOverflow = new Error('MCP server flooded stdout past 8 MB — cut off to protect the Capsule');
      this.buffer = '';
      this._fail(this._bufferOverflow);
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
      } catch (error) {
        this._fail(new Error('MCP server emitted malformed JSON: ' + error.message));
        return;
      }
    }
  }

  _request(method, params) {
    if (this._closed || !this.child?.stdin?.writable) return Promise.reject(new Error('MCP client closed'));
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timeout: ' + method)); }, this.timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.child.stdin.write(msg + '\n', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  _notify(method, params) {
    if (this._closed || !this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', () => {});
  }

  _fail(error) {
    this._rejectAll(error);
    this._closed = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
