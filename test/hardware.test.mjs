import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { hardwareInfo, hardwareSummary, resetHardwareProfile, normalizeFlags } from '../lib/hardware.mjs';

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

test('hardwareInfo returns a complete profile and stays memoized', () => {
  const h = hardwareInfo();
  assert.equal(typeof h.cpu.model, 'string');
  assert.ok(Number.isInteger(h.cpu.cores) && h.cpu.cores >= 1, 'cpu cores is a positive integer');
  assert.ok(['avx512', 'avx2', 'avx', 'sse4_2', 'baseline'].includes(h.cpu.simd), 'simd capability is one of the known tiers');
  assert.ok(['cuda', 'vulkan', 'rocm', 'none'].includes(h.gpu.type), 'gpu type is one of the known kinds');
  assert.ok(['cpu', 'cuda', 'vulkan', 'rocm'].includes(h.image_backend), 'image backend follows gpu detection');
  assert.ok(['sd15', 'sdxl'].includes(h.sd_preset), 'sd preset is sized to vram');
  assert.equal(typeof h.generated_at, 'number');
  assert.equal(hardwareInfo(), h, 'second read returns the memoized profile');
  resetHardwareProfile();
  assert.notEqual(hardwareInfo(), h, 'reset clears the memo');
  resetHardwareProfile();
});

test('hardwareSummary renders a compact one-line label', () => {
  resetHardwareProfile();
  const summary = hardwareSummary();
  assert.match(summary, /^CPU \d+×[a-z0-9_]+( · GPU [^·]+)? · image: (cpu|cuda|vulkan|rocm)( · NPU)?$/);
  resetHardwareProfile();
});

test('normalizeFlags maps macOS/Windows flag spellings onto the Linux set', () => {
  const mac = normalizeFlags(['AVX1.0', 'SSE4.2', 'SSE4.1', 'AVX2', 'F16C', 'RDSEED.', 'CLEARDBI.']);
  assert.ok(mac.has('avx'), 'AVX1.0 maps to avx');
  assert.ok(mac.has('sse4_2'), 'SSE4.2 maps to sse4_2');
  assert.ok(mac.has('sse4_1'), 'SSE4.1 maps to sse4_1');
  assert.ok(mac.has('avx2'), 'AVX2 maps lowercased');
  assert.ok(mac.has('rdseed'), 'trailing dots are stripped');
  assert.ok(!mac.has('avx1.0'), 'the raw spelling is not kept');
  const win = normalizeFlags(['avx512f', 'avx2', 'amx_bf16', 'gfni']);
  assert.ok(win.has('avx512f') && win.has('amx_bf16') && win.has('gfni'));
  const linux = normalizeFlags(['avx', 'sse4_2', 'sse4_2', '']);
  assert.equal(linux.size, 2, 'duplicates and empties collapse');
});

test('hardware endpoints: /api/hardware and /health perf are available', async () => {
  const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'hardware-server-data-'));
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const call = async (path) => {
    const r = await fetch(base + path);
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

    const hw = await call('/api/hardware');
    assert.equal(hw.status, 200);
    assert.ok(Number.isInteger(hw.body.cpu?.cores) && hw.body.cpu?.cores >= 1, 'hardware endpoint reports cores');
    assert.ok(['cpu', 'cuda', 'vulkan', 'rocm'].includes(hw.body.image_backend), 'hardware endpoint reports an image backend');
    assert.ok(['cuda', 'vulkan', 'rocm', 'none'].includes(hw.body.gpu?.type), 'hardware endpoint reports gpu kind');

    const health = await call('/health');
    assert.equal(health.status, 200);
    assert.ok(Number.isFinite(health.body.perf?.cpu_percent), 'perf carries cpu percent');
    assert.ok(health.body.perf?.memory_total_gb > 0, 'perf carries memory');
    assert.equal(typeof health.body.lan_url, 'string', 'lan_url field is present (empty on loopback)');
    assert.equal(health.body.hardware?.image_backend, hw.body.image_backend, 'health echoes the hardware backend');
  } finally {
    server.kill('SIGTERM');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});