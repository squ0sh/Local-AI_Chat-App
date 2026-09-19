// Hardware capability detection. Memoized and always safe: every probe is
// wrapped so detection can never throw, and results are never fetched twice
// for the lifetime of the process. Backends (stable-diffusion.cpp, whisper,
// piper, kokoro) read this profile to pick the matching binary and a model
// sizing appropriate to the host.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let cached = null;

function tryJSON(fn) {
  try { return fn(); } catch { return null; }
}

function readCpuFlags() {
  const text = tryJSON(() => readFileSync('/proc/cpuinfo', 'utf8'));
  if (!text) return { cores: 0, flags: new Set() };
  const lines = text.split('\n').filter((l) => /^flags\s*:/i.test(l) || /^model name\s*:/i.test(l));
  const model = lines.find((l) => /^model name\s*:/i.test(l))?.split(':').slice(1).join(':').trim() || '';
  const flags = new Set(lines.filter((l) => /^flags\s*:/i.test(l)).join(' ').split(/\s+/).filter(Boolean));
  const cores = lines.filter((l) => /^flags\s*:/i.test(l)).length;
  return { cores, model, flags };
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