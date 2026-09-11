import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

/**
 * Minimal MCP (Model Context Protocol) stdio client.
 * Connects to an MCP server via JSON-RPC 2.0 over child process stdin/stdout.
 * Used by the agent harness to register external tools.
 */
export class McpClient {
  constructor({ command, args = [], env = {}, timeout = 15_000 } = {}) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.timeout = timeout;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.tools = [];
    this._closed = false;
  }

  async connect() {
    if (this.child) return this.serverInfo;
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
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
    const res = await this._request('tools/call', { name, arguments: args });
    return res;
  }

  async close() {
    if (this.child) { this.child.kill(); this.child = null; }
    this._closed = true;
    this._rejectAll(new Error('MCP client closed'));
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
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
