// Hardware capability detection. Memoized and always safe: every probe is
// wrapped so detection can never throw, and results are never fetched twice
// for the lifetime of the process. Backends (stable-diffusion.cpp, whisper,
// piper, kokoro) read this profile to pick the matching binary and a model
// sizing appropriate to the host.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached = null;

function tryJSON(fn) {
  try { return fn(); } catch { return null; }
}

// Normalizes CPUID flag names from any source (Linux kernel flags, macOS
// sysctl "AVX1.0"/"SSE4.2", the Windows cpuid helper) into a single set.
export function normalizeFlags(list) {
  const out = new Set();
  for (let flag of list) {
    if (!flag) continue;
    flag = String(flag).toLowerCase().replace(/\.+$/g, '');
    if (flag === 'avx1.0') flag = 'avx';
    if (flag === 'sse4.1') flag = 'sse4_1';
    if (flag === 'sse4.2') flag = 'sse4_2';
    out.add(flag);
  }
  return out;
}

function readCpuFlags() {
  const platform = process.platform;
  if (platform === 'linux') {
    const text = tryJSON(() => readFileSync('/proc/cpuinfo', 'utf8'));
    if (text) {
      const lines = text.split('\n').filter((l) => /^flags\s*:/i.test(l) || /^model name\s*:/i.test(l));
      const model = lines.find((l) => /^model name\s*:/i.test(l))?.split(':').slice(1).join(':').trim() || '';
      const flags = new Set(lines.filter((l) => /^flags\s*:/i.test(l)).join(' ').split(/\s+/).filter(Boolean));
      const cores = lines.filter((l) => /^flags\s*:/i.test(l)).length;
      return { cores, model, flags };
    }
  }
  if (platform === 'darwin') {
    const sysctl = (key) => tryJSON(() => execFileSync('sysctl', ['-n', key], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
    const flags = normalizeFlags(String(sysctl('machdep.cpu.features') || '').split(/\s+/).filter(Boolean));
    for (const flag of normalizeFlags(String(sysctl('machdep.cpu.leaf7_features') || '').split(/\s+/).filter(Boolean))) flags.add(flag);
    const cores = Number(sysctl('hw.logicalcpu')) || Number(sysctl('hw.ncpu')) || cpus().length || 1;
    const model = sysctl('machdep.cpu.brand_string') || '';
    return { cores, model, flags };
  }
  if (platform === 'win32') {
    const helper = win32CpuidHelper();
    if (helper) return { cores: helper.cores, model: helper.model || '', flags: normalizeFlags(helper.flags) };
    return { cores: cpus().length || 1, model: '', flags: new Set() };
  }
  return { cores: cpus().length || 1, model: '', flags: new Set() };
}

// Windows has no /proc/cpuinfo or sysctl. An optional cpuid.exe helper
// (source in tools/cpuid.c, built with tools/build-cpuid.ps1) reports SIMD
// flags cleanly; without it we fall back to counting cores and reporting
// 'baseline' rather than guessing wrongly.
function win32CpuidHelper() {
  const exe = join(__dirname, '..', 'runtime', 'platforms', `${process.platform}-${process.arch}`, 'cpuid.exe');
  if (!existsSync(exe)) return null;
  return tryJSON(() => {
    const lines = execFileSync(exe, [], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const flags = [];
    let cores = cpus().length || 1;
    let model = '';
    for (const line of lines) {
      if (line.startsWith('flags:')) flags.push(...line.slice(6).trim().split(/\s+/).filter(Boolean));
      else if (line.startsWith('cores:')) { const n = Number(line.slice(6).trim()); if (n > 0) cores = n; }
      else if (line.startsWith('model:')) model = line.slice(6).trim();
    }
    return flags.length ? { flags, cores, model } : null;
  });
}

function cpuProfile() {
  const info = readCpuFlags();
  const has = (f) => info.flags.has(f);
  const arch = process.arch;
  const capability = has('avx512f') ? 'avx512' : has('avx2') ? 'avx2' : has('avx') ? 'avx' : has('sse4_2') ? 'sse4_2' : 'baseline';
  return {
    model: info.model || '',
    arch,
    cores: info.cores || 1,
    simd: capability,
    sapphire_rapids: has('amx_bf16') ? true : false,
  };
}

function nvidiaProfile() {
  return tryJSON(() => {
    const rows = execSync('nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1200 }).toString().trim().split('\n').filter(Boolean);
    if (!rows.length) return null;
    const devices = rows.map((row) => {
      const [name, total, free] = row.split(',').map((part) => part.trim());
      return { name, type: 'cuda', total_vram_gb: Number(total) / 1024, free_vram_gb: Number(free) / 1024 };
    });
    return { devices, total_vram_gb: devices.reduce((s, d) => s + d.total_vram_gb, 0), free_vram_gb: devices.reduce((s, d) => s + d.free_vram_gb, 0) };
  });
}

function visibleVulkanText() {
  return tryJSON(() => execFileSync('vulkaninfo', ['--summary'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }));
}

function vulkanProfile() {
  const summary = visibleVulkanText();
  if (!summary) return null;
  const names = [...summary.matchAll(/\bdeviceName\s*=\s*([^\n]+)/gi)].map((m) => m[1].trim()).filter(Boolean);
  const drivers = [...summary.matchAll(/\bdriverName\s*=\s*([^\n]+)/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (!names.length) return null;
  return { devices: names.map((name, i) => ({ index: 'vulkan' + i, name, type: 'vulkan', driver: drivers[i] || '' })), available: true };
}

function rocmProfile() {
  const kfd = existsSync('/dev/kfd');
  const rocm = tryJSON(() => execSync('rocm-smi --showproductname', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString()) || '';
  if (!kfd && !/AMD Radeon/i.test(rocm)) return null;
  const name = (rocm.match(/^\s*GPU\s*\[[^\]]*\]\s*:\s*(.+)$/im)?.[1] || 'AMD GPU').trim();
  return { devices: [{ name, type: 'rocm' }], available: true };
}

function npuProfile() {
  if (existsSync('/dev/accel/accel0')) return { available: true, device: '/dev/accel/accel0', type: 'openvino' };
  return null;
}

function pickImageBackend(gpu, cpu) {
  if (gpu?.devices?.some((d) => d.type === 'cuda')) return 'cuda';
  if (gpu?.available) return 'vulkan';
  if (gpu?.type === 'cuda') return 'cuda';
  if (gpu?.available && (gpu.type === 'vulkan' || gpu.type === 'rocm')) return gpu.type;
  return 'cpu';
}

function gpuProfile() {
  const nvidia = nvidiaProfile();
  if (nvidia) return { type: 'cuda', ...nvidia };
  const vulkan = vulkanProfile();
  if (vulkan) return { type: 'vulkan', ...vulkan };
  const rocm = rocmProfile();
  if (rocm) return { type: 'rocm', ...rocm };
  return { type: 'none', devices: [], total_vram_gb: 0, free_vram_gb: 0 };
}

export function hardwareInfo() {
  if (cached) return cached;
  const cpu = cpuProfile();
  const gpu = gpuProfile();
  const npu = npuProfile();
  const imageBackend = pickImageBackend(gpu, cpu);
  const vramGt6 = (gpu.total_vram_gb || 0) >= 6;
  cached = {
    cpu,
    gpu,
    npu,
    image_backend: imageBackend,
    sd_preset: vramGt6 ? 'sdxl' : 'sd15',
    generated_at: Date.now(),
  };
  return cached;
}

export function hardwareSummary() {
  const h = hardwareInfo();
  const dev = h.gpu.devices?.[0];
  const gpuLabel = h.gpu.type === 'none'
    ? ''
    : (dev ? ` · GPU ${dev.name}` : '');
  return `CPU ${h.cpu.cores}×${h.cpu.simd}${gpuLabel} · image: ${h.image_backend}${h.npu?.available ? ' · NPU' : ''}`;
}

export function resetHardwareProfile() {
  cached = null;
}