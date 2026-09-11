/**
 * local-chat server.mjs
 * Local AI chat app + OpenAI-compatible API server for Ollama models.
 *
 * Two modes:
 *   local  — serve chat UI + OpenAI-compatible proxy on http://localhost:PORT
 *   tunnel — additionally expose the same server through a Cloudflare quick tunnel
 *
 * The proxy is a thin passthrough to Ollama's built-in OpenAI-compatible
 * endpoints (/v1/models, /v1/chat/completions), so any OpenAI client and the
 * bundled chat UI work directly against local models.
 */

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, createReadStream, createWriteStream, copyFileSync, chmodSync, readdirSync, rmdirSync, statSync, statfsSync, writeFileSync, renameSync, unlinkSync, accessSync, constants as fsConstants } from 'fs';
import { join, dirname, resolve, relative, sep, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync, execFileSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { totalmem, freemem, cpus, loadavg, homedir } from 'os';
import { randomBytes, createHash } from 'crypto';
import qrcode from './lib/vendor/qrcode-generator.mjs';
import { portableIntegrityReport } from './lib/capsule-integrity.mjs';
import { sealVault, openVault } from './lib/capsule-vault.mjs';
import { ResearchEngine } from './lib/research-engine.mjs';
import { pullOllamaModel } from './lib/resumable-ollama-pull.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ static paths
const HTML_FILE = join(__dirname, 'index.html');
const INDEX_HTML = existsSync(HTML_FILE) ? readFileSync(HTML_FILE, 'utf8') : null;
const CAPSULE_UI_FILE = join(__dirname, 'capsule-ui.js');
const CAPSULE_UI = existsSync(CAPSULE_UI_FILE) ? readFileSync(CAPSULE_UI_FILE, 'utf8') : null;
const CAPSULE_FILE = join(__dirname, 'capsule.json');
const SKILLS_FILE = join(__dirname, 'skills.json');
const INTEGRITY_FILE = join(__dirname, 'capsule-integrity.json');
const RUNTIME_INDEX_FILE = join(__dirname, 'runtime', 'index.json');

// Set LOCAL_AI_DATA_DIR to make a fully self-contained portable installation.
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = process.env.LOCAL_AI_DATA_DIR
  ? resolve(process.env.LOCAL_AI_DATA_DIR)
  : join(ROOT_DIR, 'data');
const ENV_FILE = join(DATA_DIR, 'ai_settings.env');
const VAULT_FILE = join(DATA_DIR, 'capsule-vault.json');
const CLOUD_VAULT_FILE = join(DATA_DIR, 'capsule-cloud-vault.json');
const MODEL_VERIFICATIONS_FILE = join(DATA_DIR, 'model-verifications.json');
const MODEL_IMPORTS_FILE = join(DATA_DIR, 'model-imports.json');
const RESEARCH_DIR = join(DATA_DIR, 'research');
const PORTABLE_ROOT = join(__dirname, '.portable');
const PORTABLE_MODELS_DIR = join(PORTABLE_ROOT, 'ollama', 'models');
const OLLAMA_MODELS_DIR = resolve(process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models'));

// Local model drop folder — place .gguf (and Ollama Modelfile) files here to
// run models fully offline without any API. The server auto-detects these and
// registers them with the (bundled) local Ollama instance.
const MODELS_DIR = join(__dirname, 'models');
try { mkdirSync(MODELS_DIR, { recursive: true }); } catch {}

// In-memory track of background model downloads: id -> { spec, status, filename, downloaded, total, error }
const downloads = new Map();
const fullModelVerifications = new Map();
const localModelImports = new Map();
try {
  const saved = JSON.parse(readFileSync(MODEL_VERIFICATIONS_FILE, 'utf8'));
  for (const [name, result] of Object.entries(saved || {})) {
    if (result && typeof result === 'object') fullModelVerifications.set(name, result);
  }
} catch {}
try {
  const saved = JSON.parse(readFileSync(MODEL_IMPORTS_FILE, 'utf8'));
  for (const [name, result] of Object.entries(saved || {})) {
    if (result && typeof result === 'object') localModelImports.set(name, result);
  }
} catch {}
let downloadSeq = 0;
let modelRegistrationActive = null;
let modelUnloadActive = false;
const activeOllamaGenerations = new Map();
let remoteTunnel = { child: null, url: '', token: '', expiresAt: 0, timer: null };
let tunnelStartPromise = null;
// Held only while this app is running after the user has unlocked their Vault.
let vaultPassphrase = '';

const CURATED_MODELS = [
  {
    id: 'portable', name: 'Fast & light', model: 'huihui_ai/gemma3-abliterated:1b',
    download_gb: 0.8, memory_gb: 4, lane: 'fast', category: 'Everyday', badges: ['Uncensored', 'Abliterated', 'Gemma', 'Fast', 'Portable'], license: 'Review model card and Gemma Terms',
    agent_fit: { level: 'basic', label: 'Agent: basic', detail: 'Very small and fast; keep agent tasks short and supervised because 1B models have limited planning capacity.' },
    source_url: 'https://ollama.com/huihui_ai/gemma3-abliterated',
    description: 'A tiny abliterated Gemma model for quick text chat on low-memory computers and compact USB kits.',
  },
  {
    id: 'balanced', name: 'Balanced', model: 'hf.co/prithivMLmods/Qwen3-4B-2507-abliterated-GGUF:Q4_K_M',
    download_gb: 2.5, memory_gb: 8, lane: 'balanced', category: 'Everyday', badges: ['Uncensored', 'Abliterated', 'Balanced'], license: 'Review model card and Apache-2.0 base license',
    agent_fit: { level: 'good', label: 'Agent: good', detail: 'A good everyday fit for supervised planning, file context, and short command workflows.' },
    source_url: 'https://huggingface.co/prithivMLmods/Qwen3-4B-2507-abliterated-GGUF',
    description: 'An abliterated Qwen model for uncensored conversation, writing, and everyday help.',
  },
  {
    id: 'reasoning', name: 'Strong', model: 'dolphin3:8b-llama3.1-q4_K_M',
    download_gb: 4.9, memory_gb: 12, lane: 'reasoning', category: 'Everyday', badges: ['Uncensored', 'Strong', 'Agentic'], license: 'Review Dolphin model card and Llama 3.1 Community License',
    agent_fit: { level: 'strong', label: 'Agent: strong', detail: 'Designed for general, coding, math, function-calling, and agentic work, with more memory required.' },
    source_url: 'https://ollama.com/library/dolphin3',
    description: 'A stronger uncensored general model designed for coding, math, and agentic workflows.',
  },
  {
    id: 'coding', name: 'Coding', model: 'dolphin-mistral:7b',
    download_gb: 4.1, memory_gb: 10, lane: 'coding', category: 'Specialized', badges: ['Uncensored', 'Coding'], license: 'Review Dolphin model card and upstream Mistral license',
    agent_fit: { level: 'good', label: 'Agent: good', detail: 'An uncensored coding-focused model for supervised plans, workspace context, and command results.' },
    source_url: 'https://ollama.com/library/dolphin-mistral',
    description: 'An uncensored Dolphin model built for code explanation, writing, and debugging.',
  },
  {
    id: 'vision', name: 'Vision', model: 'huihui_ai/gemma3-abliterated:4b',
    download_gb: 8.6, memory_gb: 14, lane: 'vision', category: 'Specialized', badges: ['Uncensored', 'Abliterated', 'Vision', 'Documents'], license: 'Review model card and Gemma Terms',
    agent_fit: { level: 'basic', label: 'Agent: basic', detail: 'Optimized for visual work; use a general or coding model for longer agent workflows.' },
    source_url: 'https://ollama.com/huihui_ai/gemma3-abliterated',
    description: 'An abliterated image-and-document model for screenshots, charts, tables, and diagrams.',
  },
  {
    id: 'qwythos', name: 'Qwythos 9B', model: 'hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:Q6_K',
    download_gb: 7.6, memory_gb: 12, lane: 'reasoning', category: 'Reasoning', badges: ['Uncensored', 'Abliterated', 'Portable', 'Tools'], license: 'Apache-2.0; review the community model card',
    agent_fit: { level: 'strong', label: 'Agent: strong', detail: 'A portable reasoning and tool-use model, but still supervise commands and verify long workflows.' },
    source_url: 'https://huggingface.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF',
    description: 'A portable Qwen-based reasoning model trained on Claude Mythos-style traces, then abliterated for fewer refusals.',
  },
  {
    id: 'deepseek-r1', name: 'DeepSeek R1 14B', model: 'hf.co/tensorblock/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF:Q4_K_M',
    download_gb: 9.0, memory_gb: 16, lane: 'reasoning', category: 'Reasoning', badges: ['Uncensored', 'Abliterated', 'DeepSeek', 'Reasoning'], license: 'Review the DeepSeek base license and community model card',
    agent_fit: { level: 'strong', label: 'Agent: strong', detail: 'Reasoning-focused and capable of multi-step work; its dense 14B architecture may be slower than similarly sized MoE choices.' },
    source_url: 'https://huggingface.co/tensorblock/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF',
    description: 'A recommended Q4 build of the abliterated DeepSeek R1 Qwen distill for deeper local reasoning.',
  },
  {
    id: 'gpt-oss-heretic', name: 'GPT-OSS 20B Heretic', model: 'hf.co/mradermacher/gpt-oss-20b-heretic-ara-v3-GGUF:MXFP4_MOE',
    download_gb: 12.1, memory_gb: 16, lane: 'advanced', category: 'Advanced', badges: ['Uncensored', 'Heretic', 'MoE', 'Agentic', '128K'], license: 'Apache-2.0; community modification of OpenAI gpt-oss',
    agent_fit: { level: 'strong', label: 'Agent: strong', detail: 'Retains GPT-OSS reasoning and tool-use behavior with substantially reduced refusals; 16 GB systems should use modest context.' },
    source_url: 'https://huggingface.co/mradermacher/gpt-oss-20b-heretic-ara-v3-GGUF',
    description: 'The evidence-backed ARA v3 uncensored GPT-OSS build, preserving its native compact MoE expert format.',
  },
  {
    id: 'qwen36-moe', name: 'Qwen3.6 35B-A3B Heretic', model: 'hf.co/llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-GGUF:Q3_K_M',
    download_gb: 16.9, memory_gb: 24, lane: 'premium', category: 'Premium MoE', badges: ['Uncensored', 'Heretic', 'MoE', '3B Active', 'Vision'], license: 'Apache-2.0; review the community model card',
    agent_fit: { level: 'strong', label: 'Agent: strong', detail: 'A newer sparse model for demanding reasoning, coding, and agent workflows on higher-memory systems.' },
    source_url: 'https://huggingface.co/llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-GGUF',
    description: 'A modern 35B-total, 3B-active uncensored MoE for capable 24 GB-and-up computers; vision needs its separate projector.',
  },
  {
    id: 'qwopus', name: 'Qwopus3.6 27B Preview', model: 'hf.co/mradermacher/Qwopus3.6-27B-v1-Abliterated-preview-GGUF:Q4_K_M',
    download_gb: 16.6, memory_gb: 24, lane: 'experimental', category: 'Experimental', badges: ['Uncensored', 'Abliterated', 'Dense', 'Opus-style', 'Preview'], license: 'Apache-2.0; review the community model card',
    agent_fit: { level: 'unknown', label: 'Agent: experimental', detail: 'An early preview trained for structured reasoning style; evaluate it carefully before relying on agent or coding output.' },
    source_url: 'https://huggingface.co/mradermacher/Qwopus3.6-27B-v1-Abliterated-preview-GGUF',
    description: 'An experimental dense Qwen fine-tune using Claude-, GLM-, and Kimi-style reasoning traces; it is not Claude Opus.',
  },
  {
    id: 'dolphin-mixtral', name: 'Dolphin Mixtral 8x7B', model: 'dolphin-mixtral:8x7b-v2.7-q2_K',
    download_gb: 17.0, memory_gb: 24, lane: 'legacy', category: 'Legacy MoE', badges: ['Uncensored', 'MoE', 'Legacy', '32K'], license: 'Review Dolphin model card and upstream Mixtral license',
    agent_fit: { level: 'good', label: 'Agent: good', detail: 'An established uncensored MoE, though newer models usually offer a better portability-to-capability tradeoff.' },
    source_url: 'https://ollama.com/library/dolphin-mixtral/tags',
    description: 'The established Dolphin Mixtral option retained for comparison and variety; large even at its Q2 build.',
  },
];

// Additional uncensored community options. Model behavior and licenses vary by
// upstream project, so the source card remains part of the install decision.
const UNCENSORED_SPECTRUM = [
  { model: 'hf.co/tostideluxekaas/Llama-3.2-3B-Instruct-uncensored-GGUF:Q4_K_M', parameters: '3B', download_gb: 1.9, memory_gb: 6 },
  { model: 'dolphin-llama3:8b', parameters: '8B', download_gb: 4.7, memory_gb: 10 },
  { model: 'dolphin-llama3:70b', parameters: '70B', download_gb: 40.0, memory_gb: 80 },
];

function nearestExistingDirectory(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function fileSystemName(type) {
  if (typeof type !== 'number') return 'unknown';
  const value = type >>> 0;
  const known = new Map([
    [0x4d44, 'fat32/vfat'],
    [0x2011bab0, 'exfat'],
    [0xef53, 'ext'],
    [0x9123683e, 'btrfs'],
    [0x794c7630, 'overlay'],
    [0x01021994, 'tmpfs'],
    [0x5346544e, 'ntfs'],
  ]);
  return known.get(value) || 'unknown';
}

function storageProfileAt(targetPath) {
  const probePath = nearestExistingDirectory(targetPath);
  let freeBytes = 0, totalBytes = 0, filesystem = 'unknown', spaceKnown = false;
  try {
    const fs = statfsSync(probePath);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    totalBytes = Number(fs.blocks) * Number(fs.bsize);
    filesystem = fileSystemName(fs.type);
    spaceKnown = Number.isFinite(freeBytes) && freeBytes >= 0;
  } catch {}
  const fat32 = filesystem === 'fat32/vfat';
  return {
    probe_path: probePath,
    free_bytes: freeBytes,
    total_bytes: totalBytes,
    filesystem,
    space_known: spaceKnown,
    large_file_limit_bytes: fat32 ? 4 * 1024 ** 3 - 1 : null,
    large_files_supported: !fat32,
  };
}

function modelStorageProfile() {
  const disk = storageProfileAt(OLLAMA_MODELS_DIR);
  const portable = pathIsInside(PORTABLE_MODELS_DIR, OLLAMA_MODELS_DIR);
  const displayPath = pathIsInside(__dirname, OLLAMA_MODELS_DIR)
    ? relative(__dirname, OLLAMA_MODELS_DIR).split(sep).join('/') || '.'
    : OLLAMA_MODELS_DIR;
  return {
    ...disk,
    path: OLLAMA_MODELS_DIR,
    display_path: displayPath,
    expected_path: relative(__dirname, PORTABLE_MODELS_DIR).split(sep).join('/'),
    portable,
    writable: writableDirectory(existsSync(OLLAMA_MODELS_DIR) ? OLLAMA_MODELS_DIR : disk.probe_path),
  };
}

function modelInstallPreflight(preset, system = null) {
  const profile = system || localHardwareProfile();
  const storage = profile.storage || modelStorageProfile();
  const estimatedBytes = Math.max(0, Math.round(Number(preset.download_gb || 0) * 1_000_000_000));
  const reserveBytes = Math.max(512 * 1024 ** 2, Math.round(estimatedBytes * 0.08));
  const largestFileBytes = Math.max(0, Number(preset.largest_file_bytes ?? estimatedBytes));
  const diskKnown = storage.space_known === true;
  const fitsDisk = diskKnown && storage.free_bytes >= estimatedBytes + reserveBytes;
  const fitsFileSystem = !storage.large_file_limit_bytes || !largestFileBytes || largestFileBytes <= storage.large_file_limit_bytes;
  const fitsMemory = !preset.memory_gb || profile.memory_free_gb >= preset.memory_gb;
  const issues = [];
  if (!storage.portable) issues.push('Portable model storage is not active. Restart with the portable launcher.');
  if (!storage.writable) issues.push('The model library is not writable.');
  if (!diskKnown) issues.push('Free space could not be measured for the portable model library. Check the drive, then restart the app.');
  else if (!fitsDisk && estimatedBytes) issues.push(`The model needs about ${preset.download_gb.toFixed(1)} GB plus working space, but only ${(storage.free_bytes / 1024 ** 3).toFixed(1)} GB is free.`);
  else if (!fitsDisk) issues.push(`At least ${(reserveBytes / 1024 ** 3).toFixed(1)} GB of free working space is required before starting a model download.`);
  if (!fitsFileSystem) issues.push('This FAT32 drive cannot hold a model file larger than 4 GB. Use exFAT, NTFS, APFS, or ext4.');
  return {
    ok: storage.portable && storage.writable && fitsDisk && fitsFileSystem,
    portable: storage.portable,
    writable: storage.writable,
    fits_disk: fitsDisk,
    fits_filesystem: fitsFileSystem,
    fits_memory: fitsMemory,
    estimated_bytes: estimatedBytes,
    largest_file_bytes: largestFileBytes,
    reserve_bytes: reserveBytes,
    issues,
  };
}

function hasOllamaPartialDownloads() {
  try {
    return readdirSync(join(OLLAMA_MODELS_DIR, 'blobs')).some((name) => /partial/i.test(name));
  } catch { return false; }
}

function ollamaPullPreflight(preset, system) {
  const full = modelInstallPreflight(preset, system);
  if (full.ok || full.fits_disk || !hasOllamaPartialDownloads()) return full;
  const resume = modelInstallPreflight({ ...preset, download_gb: 0, largest_file_bytes: preset.largest_file_bytes }, system);
  const issues = [...resume.issues];
  if (!full.fits_filesystem) {
    const fileSystemIssue = full.issues.find((issue) => /FAT32/i.test(issue));
    if (fileSystemIssue && !issues.includes(fileSystemIssue)) issues.push(fileSystemIssue);
  }
  const ok = resume.portable && resume.writable && resume.fits_disk && full.fits_filesystem;
  return {
    ...full,
    ok,
    fits_disk: resume.fits_disk,
    reserve_bytes: resume.reserve_bytes,
    issues: ok ? [] : issues,
    resume_detected: true,
  };
}

function localHardwareProfile() {
  const memoryTotalGb = totalmem() / 1024 ** 3;
  const memoryFreeGb = freemem() / 1024 ** 3;
  const storage = modelStorageProfile();
  const diskFreeGb = storage.free_bytes / 1024 ** 3;
  let gpu = null;
  try {
    const rows = execSync('nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1200 }).toString().trim().split('\n').filter(Boolean);
    const devices = rows.map((row) => { const [name, total, free] = row.split(',').map((part) => part.trim()); return { name, total_vram_gb: Number(total) / 1024, free_vram_gb: Number(free) / 1024 }; });
    if (devices.length) gpu = { devices, total_vram_gb: devices.reduce((sum, device) => sum + device.total_vram_gb, 0), free_vram_gb: devices.reduce((sum, device) => sum + device.free_vram_gb, 0) };
  } catch {}
  return { memory_total_gb: memoryTotalGb, memory_free_gb: memoryFreeGb, disk_free_gb: diskFreeGb, cpu_cores: cpus().length, gpu, portable: Boolean(process.env.LOCAL_AI_DATA_DIR) && storage.portable, storage };
}

function pathIsInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..');
}

function writableDirectory(path) {
  try { accessSync(path, fsConstants.W_OK); return true; }
  catch { return false; }
}

function executableFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, fsConstants.X_OK);
    return true;
  } catch { return false; }
}

function probeRuntime(path, args) {
  if (!executableFile(path)) return { present: false, runnable: false, version: '' };
  try {
    const version = execFileSync(path, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { present: true, runnable: true, version: version.split(/\r?\n/)[0] || '' };
  } catch (error) {
    return { present: true, runnable: false, version: '', error: error.code === 'ETIMEDOUT' ? 'Version check timed out' : 'Executable could not run on this computer' };
  }
}

function chooseCuratedModel(system) {
  const enoughDisk = (preset) => modelInstallPreflight(preset, system).fits_disk;
  const fit = CURATED_MODELS.filter((preset) => enoughDisk(preset) && system.memory_free_gb >= preset.memory_gb);
  const gpuBoost = system.gpu?.free_vram_gb >= 6;
  const recommended = (gpuBoost && fit.find((preset) => preset.id === 'reasoning')) || fit.find((preset) => preset.id === 'balanced') || fit.find((preset) => preset.id === 'portable') || CURATED_MODELS[0];
  const reason = system.memory_free_gb < 6
    ? 'Free memory is limited right now, so Fast & light is the safest starting point.'
    : gpuBoost && recommended.id === 'reasoning'
      ? 'Your available NVIDIA VRAM can help with the stronger model.'
      : recommended.id === 'balanced'
        ? 'Balanced is the best everyday fit for this computer.'
        : 'Fast & light is the safest fit for this computer.';
  return { id: recommended.id, reason, enoughDisk };
}

function chooseUncensoredModel(system) {
  const candidates = UNCENSORED_SPECTRUM.filter((model) =>
    system.memory_free_gb >= model.memory_gb && (system.disk_free_gb === 0 || system.disk_free_gb >= model.download_gb + 1));
  const choice = candidates.at(-1) || UNCENSORED_SPECTRUM[0];
  return {
    id: 'uncensored', name: `Uncensored pick: ${choice.parameters}`, ...choice,
    description: 'An uncensored model option selected for this computer’s available hardware.',
    uncensored: true,
    fits_memory: system.memory_free_gb >= choice.memory_gb,
    fits_disk: system.disk_free_gb === 0 || system.disk_free_gb >= choice.download_gb + 1,
  };
}

function validateModelName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 300 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(name)
    || name.includes('://') || name.includes('\\') || name.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Use a valid Ollama model name, such as llama3.2:3b or hf.co/owner/model:Q4_K_M');
  }
  return name;
}

function normalizedModelName(value) {
  let name;
  try { name = validateModelName(value); } catch { return ''; }
  const slash = name.lastIndexOf('/');
  if (name.lastIndexOf(':') <= slash) name += ':latest';
  return name.toLowerCase();
}

function modelNamesMatch(a, b) {
  const left = normalizedModelName(a), right = normalizedModelName(b);
  return Boolean(left && right && left === right);
}

function beginOllamaGeneration(model) {
  const key = normalizedModelName(model) || '*';
  activeOllamaGenerations.set(key, Number(activeOllamaGenerations.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Number(activeOllamaGenerations.get(key) || 0) - 1;
    if (remaining > 0) activeOllamaGenerations.set(key, remaining);
    else activeOllamaGenerations.delete(key);
  };
}

function publicLoadedModel(model) {
  const name = model?.name || model?.model || '';
  return {
    name,
    model: model?.model || name,
    digest: model?.digest || '',
    size: Number(model?.size || 0),
    size_vram: Number(model?.size_vram || 0),
    expires_at: model?.expires_at || '',
    details: model?.details || {},
  };
}

function suggestedModelName(value) {
  return String(value || '')
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120) || 'imported-model';
}

function parseModelReference(value) {
  const original = validateModelName(value);
  let name = original, tag = 'latest';
  const slash = name.lastIndexOf('/'), colon = name.lastIndexOf(':');
  if (colon > slash) { tag = name.slice(colon + 1); name = name.slice(0, colon); }
  const parts = name.split('/').filter(Boolean);
  if (!parts.length) throw new Error('Invalid model name');
  const explicitRegistry = parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost';
  const registry = explicitRegistry ? parts.shift() : 'registry.ollama.ai';
  const namespace = parts.length > 1 ? parts.shift() : 'library';
  if (!parts.length) throw new Error('Invalid model name');
  return { original, registry, namespace, repository: parts, tag };
}

function modelManifestPath(name) {
  try {
    const ref = parseModelReference(name);
    const root = join(OLLAMA_MODELS_DIR, 'manifests');
    const target = join(root, ref.registry, ref.namespace, ...ref.repository, ref.tag);
    return pathIsInside(root, target) ? target : '';
  } catch { return ''; }
}

function inspectModelFiles(name, tagDigest = '') {
  const manifestPath = modelManifestPath(name);
  if (!manifestPath || !existsSync(manifestPath)) {
    return { available: false, ok: false, status: 'unavailable', method: 'manifest and blob sizes', issues: ['The model manifest was not found in the configured library.'], blob_files: [] };
  }
  try {
    const raw = readFileSync(manifestPath);
    const manifest = JSON.parse(raw.toString('utf8'));
    const descriptors = [manifest.config, ...(Array.isArray(manifest.layers) ? manifest.layers : [])]
      .filter((item) => item && /^sha256:[a-f0-9]{64}$/i.test(item.digest || ''));
    const unique = [...new Map(descriptors.map((item) => [item.digest.toLowerCase(), item])).values()];
    const manifestDigest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const normalizedTagDigest = tagDigest && String(tagDigest).includes(':') ? String(tagDigest) : tagDigest ? 'sha256:' + tagDigest : '';
    const digestMatches = !normalizedTagDigest || manifestDigest.toLowerCase() === normalizedTagDigest.toLowerCase();
    const blobFiles = unique.map((item) => {
      const path = join(OLLAMA_MODELS_DIR, 'blobs', item.digest.replace(':', '-'));
      let actualSize = 0, present = false;
      try { const stat = statSync(path); present = stat.isFile(); actualSize = present ? stat.size : 0; } catch {}
      const expectedSize = Number(item.size || 0);
      return { digest: item.digest.toLowerCase(), path, expected_size: expectedSize, actual_size: actualSize, present, size_ok: present && (!expectedSize || actualSize === expectedSize) };
    });
    const issues = [];
    if (!digestMatches) issues.push('The manifest checksum does not match Ollama’s model record.');
    const missing = blobFiles.filter((item) => !item.present).length;
    const wrongSize = blobFiles.filter((item) => item.present && !item.size_ok).length;
    if (missing) issues.push(`${missing} model blob${missing === 1 ? '' : 's'} missing.`);
    if (wrongSize) issues.push(`${wrongSize} model blob${wrongSize === 1 ? '' : 's'} has the wrong size.`);
    const ok = digestMatches && !missing && !wrongSize && blobFiles.length > 0;
    return {
      available: true,
      ok,
      status: ok ? 'checked' : 'attention',
      method: 'manifest checksum and blob sizes',
      manifest_digest: manifestDigest,
      digest_matches: digestMatches,
      blobs_present: blobFiles.filter((item) => item.present).length,
      blobs_total: blobFiles.length,
      bytes_expected: blobFiles.reduce((sum, item) => sum + item.expected_size, 0),
      issues,
      blob_files: blobFiles,
    };
  } catch (error) {
    return { available: true, ok: false, status: 'attention', method: 'manifest and blob sizes', issues: ['Could not read the model manifest: ' + error.message], blob_files: [] };
  }
}

function modelFileSnapshot(check) {
  return (check.blob_files || []).map((file) => {
    try {
      const stat = statSync(file.path);
      return { digest: file.digest, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs };
    } catch { return null; }
  }).filter(Boolean);
}

function verificationFilesMatch(check, verification) {
  if (!check.ok || !Array.isArray(verification?.files)) return false;
  const current = modelFileSnapshot(check);
  if (current.length !== check.blob_files.length || current.length !== verification.files.length) return false;
  const expected = new Map(verification.files.map((file) => [file.digest, file]));
  return current.every((file) => {
    const saved = expected.get(file.digest);
    return saved && saved.size === file.size && saved.mtime_ms === file.mtime_ms && saved.ctime_ms === file.ctime_ms;
  });
}

function modelSource(name) {
  try {
    const ref = parseModelReference(name);
    if (ref.registry === 'hf.co') {
      return { kind: 'Hugging Face', url: `https://huggingface.co/${[ref.namespace, ...ref.repository].join('/')}` };
    }
    if (ref.registry === 'registry.ollama.ai') {
      const path = ref.namespace === 'library' ? ref.repository.join('/') : [ref.namespace, ...ref.repository].join('/');
      return { kind: 'Ollama', url: `https://ollama.com/library/${path}` };
    }
    return { kind: ref.registry, url: '' };
  } catch { return { kind: 'Local', url: '' }; }
}

function summarizedLicense(show) {
  const value = Array.isArray(show?.license) ? show.license.join(', ') : show?.license;
  if (typeof value !== 'string') return '';
  const first = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  return first.length > 140 ? first.slice(0, 137) + '…' : first;
}

async function ollamaJSON(method, path, payload, timeout = 8000) {
  const response = await upstreamRequest(method, path, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    timeout,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data.error || text.slice(0, 300) || `Ollama returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function ollamaTags() {
  return (await ollamaJSON('GET', '/api/tags')).models || [];
}

async function ollamaLoadedModels() {
  const result = await ollamaJSON('GET', '/api/ps');
  return Array.isArray(result.models) ? result.models.map(publicLoadedModel).filter((model) => model.name) : [];
}

async function waitForOllamaUnload(modelNames, attempts = 30) {
  const requested = new Set(modelNames.map(normalizedModelName).filter(Boolean));
  let loaded = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    loaded = await ollamaLoadedModels();
    const remaining = loaded.filter((model) => requested.has(normalizedModelName(model.name)));
    if (!remaining.length) return [];
    if (attempt < attempts - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return loaded.filter((model) => requested.has(normalizedModelName(model.name)));
}

async function waitForOllamaLoad(modelName, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const loaded = await ollamaLoadedModels();
    const match = loaded.find((model) => modelNamesMatch(model.name, modelName));
    if (match) return match;
    if (attempt < attempts - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return null;
}

function publicModelJob(job) {
  const { controller, layer_progress: layerProgress, ...safe } = job;
  if (layerProgress) {
    const layers = Object.values(layerProgress);
    const completed = layers.reduce((sum, layer) => sum + Number(layer.completed || 0), 0);
    const knownTotal = layers.reduce((sum, layer) => sum + Number(layer.total || 0), 0);
    const total = Number(job.estimated_total || 0) || knownTotal;
    safe.downloaded = completed;
    safe.total = total;
    safe.known_total = knownTotal;
    safe.progress_percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
  } else if (job.total) {
    safe.progress_percent = Math.min(100, Math.round(Number(job.downloaded || 0) / Number(job.total) * 100));
  }
  return safe;
}

function activeModelJob(job) {
  return ['starting', 'downloading', 'reconnecting', 'registering', 'verifying', 'finalizing', 'cancelling'].includes(job.status);
}

function activeStorageJob() {
  return modelRegistrationActive || [...downloads.values()].find((job) =>
    (job.kind === 'ollama-pull' || job.kind === 'gguf-download') && activeModelJob(job));
}

function pruneModelJobs() {
  const old = [...downloads.values()]
    .filter((job) => !activeModelJob(job))
    .sort((a, b) => Number(a.finished_at || a.started_at || 0) - Number(b.finished_at || b.started_at || 0));
  while (downloads.size > 40 && old.length) downloads.delete(old.shift().id);
}

function saveFullModelVerifications() {
  mkdirSync(dirname(MODEL_VERIFICATIONS_FILE), { recursive: true });
  const temporary = MODEL_VERIFICATIONS_FILE + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(fullModelVerifications), null, 2) + '\n', 'utf8');
  renameSync(temporary, MODEL_VERIFICATIONS_FILE);
}

function rememberFullModelVerification(name, result) {
  fullModelVerifications.set(normalizedModelName(name), result);
  try { saveFullModelVerifications(); } catch (error) { log('Could not save model verification result:', error.message); }
}

function forgetFullModelVerification(name) {
  fullModelVerifications.delete(normalizedModelName(name));
  try { saveFullModelVerifications(); } catch (error) { log('Could not update model verification results:', error.message); }
}

function saveLocalModelImports() {
  mkdirSync(dirname(MODEL_IMPORTS_FILE), { recursive: true });
  const temporary = MODEL_IMPORTS_FILE + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(localModelImports), null, 2) + '\n', 'utf8');
  renameSync(temporary, MODEL_IMPORTS_FILE);
}

function rememberLocalModelImport(name, files) {
  localModelImports.set(normalizedModelName(name), {
    kind: 'Local GGUF',
    files: files.map((file) => basename(file)),
    imported_at: Date.now(),
  });
  try { saveLocalModelImports(); } catch (error) { log('Could not save local model provenance:', error.message); }
}

function forgetLocalModelImport(name) {
  localModelImports.delete(normalizedModelName(name));
  try { saveLocalModelImports(); } catch (error) { log('Could not update local model provenance:', error.message); }
}

function recommendationsFor(system, installed = []) {
  const recommendation = chooseCuratedModel(system);
  const installedNames = new Set(installed.map((model) => normalizedModelName(model.name)).filter(Boolean));
  const presets = CURATED_MODELS.map((preset) => {
    const preflight = modelInstallPreflight(preset, system);
    return {
      ...preset,
      recommended: preset.id === recommendation.id,
      installed: installedNames.has(normalizedModelName(preset.model)),
      fits_memory: preflight.fits_memory,
      fits_disk: preflight.fits_disk,
      installable: preflight.ok,
      preflight,
    };
  });
  const installedUncensored = installed.find((item) => /uncensored|dolphin/i.test(item.name || item.model || ''));
  const uncensored = installedUncensored ? {
    id: 'uncensored',
    name: `Uncensored · ${installedUncensored.details?.parameter_size || 'installed'}`,
    model: installedUncensored.name || installedUncensored.model,
    parameters: installedUncensored.details?.parameter_size || '',
    download_gb: Number(installedUncensored.size || 0) / 1_000_000_000,
    memory_gb: Math.max(6, Math.ceil(Number(installedUncensored.size || 0) / 1_000_000_000 + 3)),
    description: 'The uncensored model already carried in this portable library.',
    uncensored: true,
  } : chooseUncensoredModel(system);
  const uncensoredPreflight = modelInstallPreflight(uncensored, system);
  return {
    presets,
    system: { ...system, available_memory_gb: Math.floor(system.memory_free_gb), total_memory_gb: Math.floor(system.memory_total_gb) },
    recommendation: { id: recommendation.id, reason: recommendation.reason },
    uncensored_option: {
      ...uncensored,
      badges: ['Uncensored'],
      agent_fit: { level: 'unknown', label: 'Agent: not evaluated', detail: 'Community and uncensored variants differ widely in instruction following; test with supervised, low-risk tasks first.' },
      installed: installedNames.has(normalizedModelName(uncensored.model)),
      installable: uncensoredPreflight.ok,
      preflight: uncensoredPreflight,
    },
  };
}

async function buildModelLibrary() {
  const system = localHardwareProfile();
  const [tags, versionResult, runningResult] = await Promise.all([
    ollamaTags(),
    ollamaJSON('GET', '/api/version').catch(() => ({})),
    ollamaJSON('GET', '/api/ps').catch((error) => ({ models: [], unavailable: error.message })),
  ]);
  const loadedModels = (runningResult.models || []).map(publicLoadedModel).filter((model) => model.name);
  const runningByName = new Map(loadedModels.map((model) => [normalizedModelName(model.name), model]));
  const installed = await Promise.all(tags.map(async (tag) => {
    const name = tag.name || tag.model;
    const runtime = runningByName.get(normalizedModelName(name)) || null;
    const provenance = localModelImports.get(normalizedModelName(name)) || null;
    let show = null, showError = '';
    try { show = await ollamaJSON('POST', '/api/show', { model: name }, 12000); }
    catch (error) { showError = error.message; }
    const quick = inspectModelFiles(name, tag.digest);
    const deep = fullModelVerifications.get(normalizedModelName(name));
    const deeplyVerified = Boolean(deep && verificationFilesMatch(quick, deep) && (!tag.digest || deep.model_digest === tag.digest));
    const { blob_files, ...quickPublic } = quick;
    const details = { ...(tag.details || {}), ...(show?.details || show?.model?.details || {}) };
    const capabilities = [...new Set([...(tag.capabilities || []), ...(show?.capabilities || [])])];
    const contextEntry = Object.entries(show?.model_info || {}).find(([key]) => key.endsWith('.context_length'));
    const curated = CURATED_MODELS.find((preset) => modelNamesMatch(preset.model, name));
    return {
      name,
      size: Number(tag.size || quick.bytes_expected || 0),
      digest: tag.digest || quick.manifest_digest || '',
      modified_at: tag.modified_at || show?.modified_at || '',
      details,
      capabilities,
      context_length: Number(contextEntry?.[1] || 0),
      license: summarizedLicense(show),
      source: provenance ? { kind: provenance.kind, url: '' } : modelSource(name),
      provenance,
      running: Boolean(runtime),
      runtime,
      curated_id: curated?.id || '',
      agent_fit: curated?.agent_fit || { level: 'unknown', label: 'Agent: not evaluated', detail: 'This model has not been evaluated for instruction following in Capsule Agent mode. It can still be used with supervision.' },
      verification: deeplyVerified
        ? { ...quickPublic, ok: true, status: 'verified', method: deep.method, verified_at: deep.verified_at, issues: [] }
        : { ...quickPublic, show_ok: Boolean(show), show_error: showError },
    };
  }));
  const imports = scanModels().filter((model) => model.kind === 'gguf').map((model) => {
    const preflight = modelInstallPreflight({
      download_gb: Number(model.size || 0) / 1_000_000_000,
      memory_gb: 0,
      largest_file_bytes: Math.max(0, ...(model.shards || []).map((shard) => Number(shard.size || 0)), Number(model.shards?.length ? 0 : model.size || 0)),
    }, system);
    const issues = [...preflight.issues];
    if (!model.complete) issues.push(model.shard_issue || 'This GGUF shard set is incomplete.');
    const importPreflight = { ...preflight, ok: preflight.ok && model.complete, issues };
    return {
      ...model,
      suggested_name: suggestedModelName(model.name),
      registered: installed.some((tag) => modelNamesMatch(tag.name, model.name) || modelNamesMatch(tag.name, suggestedModelName(model.name))),
      installable: importPreflight.ok,
      preflight: importPreflight,
    };
  });
  pruneModelJobs();
  return {
    ollama: { online: true, version: versionResult.version || '' },
    loaded: {
      available: !runningResult.unavailable,
      error: runningResult.unavailable || '',
      models: loadedModels,
      count: loadedModels.length,
      size: loadedModels.reduce((sum, model) => sum + model.size, 0),
      size_vram: loadedModels.reduce((sum, model) => sum + model.size_vram, 0),
    },
    storage: system.storage,
    system,
    installed,
    catalog: recommendationsFor(system, tags),
    imports,
    import_folder: MODELS_DIR,
    jobs: [...downloads.values()]
      .filter((job) => job.kind === 'ollama-pull' || job.kind === 'model-verify')
      .map(publicModelJob),
  };
}

async function hashFile(path, job) {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { signal: job.controller.signal });
  for await (const chunk of stream) {
    hash.update(chunk);
    job.downloaded += chunk.length;
  }
  return 'sha256:' + hash.digest('hex');
}

async function runFullModelVerification(job, tag) {
  const check = inspectModelFiles(job.model, tag.digest);
  if (!check.ok) throw new Error(check.issues.join(' ') || 'The quick model-file check failed');
  job.total = check.blob_files.reduce((sum, file) => sum + file.expected_size, 0);
  job.downloaded = 0;
  const verifiedFiles = [];
  for (const file of check.blob_files) {
    job.detail = 'Hashing ' + file.digest.slice(0, 19) + '…';
    const before = statSync(file.path);
    const digest = await hashFile(file.path, job);
    const after = statSync(file.path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('A model file changed while it was being verified. Stop other model operations and try again.');
    }
    if (digest.toLowerCase() !== file.digest.toLowerCase()) throw new Error('Checksum mismatch for ' + file.digest);
    verifiedFiles.push({ digest: file.digest, size: after.size, mtime_ms: after.mtimeMs, ctime_ms: after.ctimeMs });
  }
  const verified = { model_digest: tag.digest || check.manifest_digest, verified_at: Date.now(), method: 'full SHA-256 file verification', files: verifiedFiles };
  rememberFullModelVerification(job.model, verified);
  return verified;
}

// ------------------------------------------------------------------ provider config
function readConfig() {
  if (!existsSync(ENV_FILE)) return {};
  const raw = readFileSync(ENV_FILE, 'utf-8');
  const config = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    config[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return config;
}

function saveConfig(updates) {
  let lines = [];
  try { lines = readFileSync(ENV_FILE, 'utf8').split('\n'); } catch {}
  const keys = new Set(Object.keys(updates));
  lines = lines.filter((line) => !keys.has(line.trim().split('=')[0]));
  for (const [key, value] of Object.entries(updates)) {
    if (value) lines.push(`${key}=${value}`);
  }
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, lines.filter(Boolean).join('\n') + '\n', 'utf8');
}

function cloudCredentials() {
  return {
    provider: cfg.aiProvider || '', model: cfg.model || '', baseUrl: cfg.openaiBaseUrl || '',
    openaiApiKey: cfg.openaiApiKey || '', anthropicApiKey: cfg.anthropicApiKey || '', geminiApiKey: cfg.geminiApiKey || '',
  };
}

function hasCloudCredentials() {
  return Boolean(cfg.openaiApiKey || cfg.anthropicApiKey || cfg.geminiApiKey);
}

function applyCloudCredentials(saved = {}) {
  cfg.aiProvider = saved.provider || '';
  cfg.model = saved.model || '';
  cfg.openaiBaseUrl = saved.baseUrl || '';
  cfg.openaiApiKey = saved.openaiApiKey || '';
  cfg.anthropicApiKey = saved.anthropicApiKey || '';
  cfg.geminiApiKey = saved.geminiApiKey || '';
}

function saveCloudVault() {
  if (!vaultPassphrase) throw new Error('Unlock the Capsule Vault before remembering a cloud connection');
  mkdirSync(dirname(CLOUD_VAULT_FILE), { recursive: true });
  writeFileSync(CLOUD_VAULT_FILE, JSON.stringify(sealVault(JSON.stringify(cloudCredentials()), vaultPassphrase)), 'utf8');
  // Keep only non-secret display settings outside the vault.
  saveConfig({ AI_PROVIDER: cfg.aiProvider, AI_DISPLAY_MODEL: cfg.model, OPENAI_BASE_URL: cfg.openaiBaseUrl, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
}

// ------------------------------------------------------------------ local models folder
// Locate the bundled Ollama binary (used to serve .gguf models from models/).
function ollamaBin() {
  const candidates = [];
  if (process.env.LOCAL_AI_OLLAMA_BIN) candidates.push(resolve(process.env.LOCAL_AI_OLLAMA_BIN));
  candidates.push(join(__dirname, 'runtime', 'platforms', `${process.platform}-${process.arch}`, 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama'));
  if (existsSync(DATA_DIR)) {
    const plat = process.platform;
    candidates.push(join(DATA_DIR, 'ollama', 'ollama'));
    candidates.push(join(DATA_DIR, 'ollama', `ollama-${plat}`));
    if (plat === 'win32') candidates.push(join(DATA_DIR, 'ollama', 'ollama.exe'));
  }
  candidates.push('ollama'); // fall back to PATH
  for (const c of candidates) {
    if (c === 'ollama') return c;
    try { if (existsSync(c)) return c; } catch {}
  }
  return 'ollama';
}

// Matches a GGUF shard name of the form `<base>-NNNNN-of-MMMMM.gguf`.
const SHARD_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;

// Group GGUF files into logical models. Single-file models (no shard suffix)
// map to one entry; multi-shard models (e.g. foo-00001-of-00002.gguf +
// foo-00002-of-00002.gguf) are grouped under their shared base name with the
// shards listed in order.
function groupGgufModels(entries) {
  const files = [];
  for (const name of entries.sort()) {
    if (!/\.gguf$/i.test(name)) continue;
    let st;
    try { st = statSync(join(MODELS_DIR, name)); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ file: name, size: st.size });
  }

  const single = new Map();
  const sharded = new Map(); // base -> array of { file, size, idx, total }
  for (const f of files) {
    const m = f.file.match(SHARD_RE);
    if (m) {
      const base = m[1];
      const idx = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      if (!sharded.has(base)) sharded.set(base, []);
      sharded.get(base).push({ ...f, idx, total });
    } else {
      single.set(f.file.replace(/\.gguf$/i, ''), f);
    }
  }

  const out = [];
  for (const [name, f] of single) {
    out.push({ name, files: [f.file], size: f.size, kind: 'gguf', complete: true, missing_shards: [] });
  }
  for (const [base, shards] of sharded) {
    shards.sort((a, b) => a.idx - b.idx);
    const totalSize = shards.reduce((s, x) => s + x.size, 0);
    const expectedTotal = shards[0]?.total || 0;
    const totalsAgree = expectedTotal > 0 && shards.every((shard) => shard.total === expectedTotal);
    const present = new Set(shards.map((shard) => shard.idx));
    const invalidIndices = shards.map((shard) => shard.idx).filter((index) => index < 1 || index > expectedTotal);
    const missingShards = totalsAgree
      ? Array.from({ length: expectedTotal }, (_, index) => index + 1).filter((index) => !present.has(index))
      : [];
    const complete = totalsAgree && invalidIndices.length === 0 && missingShards.length === 0
      && shards.length === expectedTotal && present.size === expectedTotal;
    const shardIssue = !totalsAgree
      ? 'The GGUF shard filenames disagree about how many files belong to this model.'
      : invalidIndices.length
        ? `GGUF shard indices must be between 00001 and ${String(expectedTotal).padStart(5, '0')}.`
        : missingShards.length
          ? `Missing GGUF shard${missingShards.length === 1 ? '' : 's'}: ${missingShards.map((index) => String(index).padStart(5, '0')).join(', ')}`
          : complete ? '' : `Expected exactly ${expectedTotal} GGUF shard${expectedTotal === 1 ? '' : 's'}.`;
    out.push({
      name: base,
      files: shards.map((s) => s.file),
      size: totalSize,
      kind: 'gguf',
      shards,
      complete,
      missing_shards: missingShards,
      shard_issue: shardIssue,
    });
  }
  return out;
}

// List local model files (gguf, safetensors) + Ollama Modelfile entries in models/.
function scanModels() {
  let entries = [];
  try { entries = readdirSync(MODELS_DIR); } catch { return []; }

  const out = groupGgufModels(entries);

  // Also surface Modelfile files as informational entries.
  for (const name of entries.sort()) {
    if (!/\.safetensors$/i.test(name)) continue;
    let st;
    try { st = statSync(join(MODELS_DIR, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name: name.replace(/\.safetensors$/i, ''), files: [name], size: st.size, kind: 'safetensors' });
  }

  return out;
}

// Resolve the absolute paths of a model's GGUF shard(s).
function resolveModelFiles(m) {
  if (m.files && m.files.length) return m.files.map((f) => join(MODELS_DIR, f));
  return [join(MODELS_DIR, m.name + '.gguf')];
}

// Register a local .gguf model into the bundled Ollama instance via
// `ollama create <name> -f <Modelfile>`. Supports multi-shard GGUF models by
// emitting multiple `FROM` lines. Returns {ok, name} or throws.
function registerLocalModel(name, files) {
  let registration = null;
  const task = new Promise((resolve, reject) => {
    try { name = validateModelName(name); }
    catch (error) { reject(error); return; }
    const bin = ollamaBin();
    const paths = files || [join(MODELS_DIR, name + '.gguf')];
    for (const p of paths) {
      if (!existsSync(p)) return reject(new Error(`No .gguf found for "${name}" in ${MODELS_DIR}`));
      if (!pathIsInside(MODELS_DIR, p) || /[\r\n]/.test(p)) return reject(new Error('Model files must stay inside the local models folder'));
    }
    if (modelRegistrationActive) return reject(new Error(`Another GGUF model is already ${modelRegistrationActive.status}`));
    registration = { kind: 'gguf-register', status: 'registering', model: name };
    modelRegistrationActive = registration;
    const fromLines = paths.map((p) => `FROM ${p.replace(/\\/g, '/')}`).join('\n');
    const modelfile = fromLines + '\n';
    try {
      const proc = spawn(bin, ['create', name, '-f', '-'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdin.write(modelfile);
      proc.stdin.end();
      proc.on('error', (e) => reject(new Error(e.message)));
      proc.on('close', (code) => {
        if (code === 0) { rememberLocalModelImport(name, paths); resolve({ ok: true, name }); }
        else reject(new Error(stderr.trim() || `ollama create exited with code ${code}`));
      });
    } catch (e) {
      reject(e);
    }
  });
  return task.finally(() => { if (modelRegistrationActive === registration) modelRegistrationActive = null; });
}

// Register all .gguf models in models/ that are not yet in Ollama's registry.
async function autoRegisterLocalModels() {
  const local = scanModels().filter((m) => m.kind === 'gguf');
  if (!local.length) return;
  // Query Ollama registry to see what's already registered.
  let existing = new Set();
  try {
    const r = await upstreamRequest('GET', '/api/tags', { timeout: 4000 });
    if (r.ok) {
      const j = JSON.parse(await r.text());
      for (const t of (j.models || [])) existing.add(normalizedModelName(t.name));
    }
  } catch {}
  for (const m of local) {
    const modelName = suggestedModelName(m.name);
    if (existing.has(normalizedModelName(modelName))) continue;
    if (!m.complete) {
      console.log(`  [models] skipped ${m.name}: ${m.shard_issue || 'the GGUF shard set is incomplete'}`);
      continue;
    }
    const preflight = modelInstallPreflight({
      download_gb: Number(m.size || 0) / 1_000_000_000,
      memory_gb: 0,
      largest_file_bytes: Math.max(0, ...(m.shards || []).map((shard) => Number(shard.size || 0)), Number(m.shards?.length ? 0 : m.size || 0)),
    });
    if (!preflight.ok) {
      console.log(`  [models] skipped ${m.name}: ${preflight.issues.join(' ') || 'portable storage preflight failed'}`);
      continue;
    }
    try {
      await registerLocalModel(modelName, resolveModelFiles(m));
      console.log(`  [models] registered ${modelName} from ${m.files.join(', ')}`);
    } catch (e) {
      console.log(`  [models] could not register ${m.name}: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ CLI/config
function parseArgs(argv) {
  const cfg = {
    mode: 'local',
    // Bind locally by default. Public/LAN exposure should always be explicit.
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 5173),
    ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    authToken: process.env.AUTH_TOKEN || '',
    cloudflaredPath: process.env.CLOUDFLARED_PATH || '',
  };
  // Merge saved provider config (data/ai_settings.env) for cross-provider support.
  const env = readConfig();
  cfg.aiProvider = env.AI_PROVIDER || '';
  cfg.model = env.OPENAI_MODEL || env.AI_DISPLAY_MODEL || '';
  cfg.openaiBaseUrl = env.OPENAI_BASE_URL || '';
  cfg.openaiApiKey = env.OPENAI_API_KEY || '';
  cfg.anthropicApiKey = env.ANTHROPIC_API_KEY || '';
  cfg.geminiApiKey = env.GEMINI_API_KEY || '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mode' || a === '-m') cfg.mode = next() || 'local';
    else if (a === '--port' || a === '-p') cfg.port = Number(next() || 5173);
    else if (a === '--host') cfg.host = next() || null;
    else if (a === '--ollama-url' || a === '-u') cfg.ollamaUrl = (next() || cfg.ollamaUrl).replace(/\/+$/, '');
    else if (a === '--auth-token') cfg.authToken = next() || '';
    else if (a === '--cloudflared') cfg.cloudflaredPath = next() || '';
    else if (a === 'local' || a === 'tunnel') cfg.mode = a;
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  if (!/^https?:\/\//.test(cfg.ollamaUrl)) cfg.ollamaUrl = 'http://' + cfg.ollamaUrl;
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));
const researchEngine = new ResearchEngine({
  dataDir: RESEARCH_DIR,
  complete: researchModelCompletion,
  searxngUrl: process.env.RESEARCH_SEARXNG_URL || '',
});

if (cfg.mode === 'tunnel' && !cfg.authToken) {
  throw new Error('Tunnel mode requires AUTH_TOKEN. Example: AUTH_TOKEN="choose-a-long-secret" npm run tunnel');
}

// ------------------------------------------------------------------ utilities
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const RESP_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS };

const isWin = () => process.platform === 'win32';

function log(...args) { console.log(new Date().toISOString(), ...args); }

function sendJSON(res, code, obj) {
  res.writeHead(code, RESP_HEADERS);
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body exceeds the 1 MB limit'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Remote tunnels arrive with their public hostname. Sensitive controls deliberately
// require a direct localhost request, even when the caller knows the remote key.
function isDirectLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  // Cloudflare adds this header at the edge; its presence always means the
  // request came through the public tunnel, not from the local browser.
  if (req.headers['cf-connecting-ip']) return false;
  return host === 'localhost' || host === '127.0.0.1'
    || host === `localhost:${cfg.port}` || host === `127.0.0.1:${cfg.port}`;
}

// Agent tools are intentionally restricted to this app's own project folder.
// They are local-only and every write/command request must carry a UI approval.
function agentToolsAllowed(req) {
  if (cfg.mode !== 'local' || !isDirectLocalRequest(req)) return false;
  const origin = req.headers.origin || '';
  return !origin || origin === `http://${req.headers.host}`;
}

function localControlAllowed(req) {
  if (!isDirectLocalRequest(req)) return false;
  const origin = String(req.headers.origin || '');
  return !origin || origin === `http://${req.headers.host}`;
}

function stopRemote(reason = 'stopped') {
  if (remoteTunnel.timer) clearTimeout(remoteTunnel.timer);
  const child = remoteTunnel.child;
  remoteTunnel = { child: null, url: '', token: '', expiresAt: 0, timer: null };
  cfg.authToken = '';
  if (child && !child.killed) child.kill('SIGTERM');
  log('Capsule Remote ' + reason);
}

function armRemoteExpiry() {
  if (remoteTunnel.timer) clearTimeout(remoteTunnel.timer);
  const remaining = Math.max(0, remoteTunnel.expiresAt - Date.now());
  remoteTunnel.timer = setTimeout(() => {
    if (remoteTunnel.expiresAt && Date.now() >= remoteTunnel.expiresAt) stopRemote('expired');
  }, remaining + 25);
}

function agentWorkspacePath(requested = '') {
  const target = resolve(__dirname, requested || '.');
  const rel = relative(__dirname, target);
  if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith('.git' + sep) || rel === '.git' || rel.startsWith('.portable' + sep) || rel === '.portable') {
    throw new Error('Path is outside the approved agent workspace');
  }
  return target;
}

function upstreamRequest(method, path, { body, headers = {}, timeout = 120000 } = {}) {
  const url = cfg.ollamaUrl + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const h = { 'Content-Type': 'application/json', ...headers };
  if (body != null) h['Content-Length'] = String(Buffer.byteLength(body));
  return fetch(url, { method, headers: h, body, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function findOnPath(name) {
  const paths = (process.env.PATH || '').split(isWin() ? ';' : ':').filter(Boolean);
  const exts = isWin() ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// ------------------------------------------------------------------ handlers
function authorize(req, url) {
  if (!cfg.authToken) return [];
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const cookies = [];
  try {
    for (const pair of String(req.headers.cookie || '').split(';').map((part) => part.trim())) {
      if (pair.startsWith('capsule_remote_token=')) cookies.push(decodeURIComponent(pair.slice('capsule_remote_token='.length)));
    }
  } catch {}
  const query = url.searchParams.get('auth_token') || '';
  return [header, ...cookies, query].filter(Boolean);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Browsers cannot attach a bearer token to CORS preflight requests.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Path-based Remote links survive Safari, Messages, email clients, and QR
  // scanners more reliably than fragments or query-only magic links. Validate
  // the key before serving the shell, inject it into this response only, and
  // establish an HTTP-only cookie as a second authentication path. The page
  // removes /remote/<key> from its address bar as soon as it initializes.
  if (req.method === 'GET' && p.startsWith('/remote/')) {
    let key = '';
    try { key = decodeURIComponent(p.slice('/remote/'.length).replace(/\/$/, '')); } catch {}
    if (!key || !cfg.authToken || key !== cfg.authToken) {
      return sendJSON(res, 401, { error: 'Remote link is invalid or has expired' });
    }
    if (INDEX_HTML === null) return sendJSON(res, 500, { error: 'index.html not found' });
    const remainingSeconds = remoteTunnel.expiresAt
      ? Math.max(1, Math.ceil((remoteTunnel.expiresAt - Date.now()) / 1000))
      : 2 * 60 * 60;
    const cookie = 'capsule_remote_token=' + encodeURIComponent(key)
      + '; Path=/; Max-Age=' + remainingSeconds + '; HttpOnly; Secure; SameSite=Lax';
    const bootstrap = 'const serverBootstrapToken=' + JSON.stringify(key) + ';';
    const html = INDEX_HTML.replace("const serverBootstrapToken='';", bootstrap);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  }

  // Browser-friendly Remote login. Validate the temporary magic-link key on
  // the server and establish an HTTP-only same-origin session. Serve the app
  // shell in the same response so its startup code can also capture the key
  // before removing it from the address bar. The cookie and bearer header are
  // complementary fallbacks for mobile browsers.
  if (req.method === 'GET' && (p === '/' || p === '/index.html') && url.searchParams.has('capsule_key')) {
    const key = url.searchParams.get('capsule_key') || '';
    if (!cfg.authToken || key !== cfg.authToken) return sendJSON(res, 401, { error: 'Remote link is invalid or has expired' });
    const remainingSeconds = remoteTunnel.expiresAt
      ? Math.max(1, Math.ceil((remoteTunnel.expiresAt - Date.now()) / 1000))
      : 2 * 60 * 60;
    const cookie = 'capsule_remote_token=' + encodeURIComponent(key)
      + '; Path=/; Max-Age=' + remainingSeconds + '; HttpOnly; Secure; SameSite=Lax';
    if (INDEX_HTML === null) return sendJSON(res, 500, { error: 'index.html not found' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    });
    return res.end(INDEX_HTML);
  }

  // A tunnel hostname by itself is not the private share link. Fail clearly
  // instead of loading a chat shell that can only report a later 401.
  if (req.method === 'GET' && (p === '/' || p === '/index.html') && cfg.authToken && !isDirectLocalRequest(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Incomplete Capsule Remote link</title><body style="margin:0;background:#090b10;color:#edf2fb;font:16px/1.5 system-ui"><main style="max-width:560px;margin:15vh auto;padding:24px"><h1>Incomplete Remote link</h1><p>This is only the Cloudflare address. Open the complete <strong>Private chat link</strong> copied from Capsule Remote on the home computer.</p></main></body>');
  }

  // Keep the shell reachable so a user can enter AUTH_TOKEN in the UI.
  // All dynamic routes below remain protected.
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    if (INDEX_HTML === null) return sendJSON(res, 500, { error: 'index.html not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(INDEX_HTML);
  }
  if (req.method === 'GET' && p === '/capsule-ui.js') {
    if (CAPSULE_UI === null) return sendJSON(res, 500, { error: 'capsule-ui.js not found' });
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(CAPSULE_UI);
  }

  const provided = authorize(req, url);
  const remoteExpired = remoteTunnel.expiresAt && Date.now() > remoteTunnel.expiresAt;
  const requiredToken = cfg.authToken || (p.startsWith('/v1/') ? remoteTunnel.token : '');
  if (remoteExpired && p.startsWith('/v1/')) return sendJSON(res, 401, { error: 'Remote session expired' });
  // The local app must keep working when Capsule Remote turns authentication on
  // mid-session. Tunnel requests still require the token; direct loopback
  // requests never leave this machine and Cloudflare requests are excluded by
  // isDirectLocalRequest via cf-connecting-ip.
  const directLocalRequest = isDirectLocalRequest(req);
  if (requiredToken && !provided.includes(requiredToken) && !directLocalRequest) {
    return sendJSON(res, 401, { error: 'Unauthorized: missing or invalid AUTH_TOKEN' });
  }

  // These panels manage secrets, local files, or the tunnel itself. They never
  // need to be reachable by a person using the shared chat link.
  if (p.startsWith('/api/models/') && !localControlAllowed(req)) {
    return sendJSON(res, 403, { error: 'Model management is available only in the local app' });
  }
  if ((p.startsWith('/api/cloud/') || p.startsWith('/api/vault/') || p.startsWith('/api/portable/') || p.startsWith('/api/research')) && !isDirectLocalRequest(req)) {
    return sendJSON(res, 403, { error: 'This Capsule control is available only from the local app' });
  }

  // ── Health probe (drives the UI connection pill) ─────────────────────────
  if (req.method === 'GET' && p === '/health') {
    let ollama = false, version = '';
    if (!isCloudProvider()) {
      try {
        const u = await fetch(cfg.ollamaUrl + '/api/version', { signal: AbortSignal.timeout(4000) });
        if (u.ok) { ollama = true; const j = await u.json().catch(() => ({})); version = j.version || ''; }
      } catch {}
    }
    return sendJSON(res, 200, {
      ok: true,
      ollama,
      ollama_url: cfg.ollamaUrl,
      version,
      mode: cfg.mode,
      provider: cfg.aiProvider || 'ollama',
      model: cfg.model || '',
    });
  }

  // ── Cloud connection settings ────────────────────────────────────────────
  // Keys are accepted by the local server and are never returned to the browser.
  if (req.method === 'GET' && p === '/api/vault/status') return sendJSON(res, 200, { exists: existsSync(VAULT_FILE), unlocked: Boolean(vaultPassphrase), cloud_credentials_remembered: existsSync(CLOUD_VAULT_FILE) });
  if (req.method === 'POST' && p === '/api/vault/save') {
    let payload; try { payload = JSON.parse(await readBody(req, 2_000_000)); } catch { return sendJSON(res, 400, { error: 'Invalid vault data' }); }
    if (typeof payload.passphrase !== 'string' || payload.passphrase.length < 12 || typeof payload.data !== 'string') return sendJSON(res, 400, { error: 'Use a passphrase of at least 12 characters' });
    mkdirSync(dirname(VAULT_FILE), { recursive: true }); writeFileSync(VAULT_FILE, JSON.stringify(sealVault(payload.data, payload.passphrase)), 'utf8');
    vaultPassphrase = payload.passphrase;
    if (hasCloudCredentials() && !existsSync(CLOUD_VAULT_FILE)) saveCloudVault();
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/vault/unlock') {
    let payload; try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid request' }); }
    try {
      const passphrase = payload.passphrase || '';
      const data = openVault(JSON.parse(readFileSync(VAULT_FILE, 'utf8')), passphrase);
      vaultPassphrase = passphrase;
      if (existsSync(CLOUD_VAULT_FILE)) applyCloudCredentials(JSON.parse(openVault(JSON.parse(readFileSync(CLOUD_VAULT_FILE, 'utf8')), passphrase)));
      else if (hasCloudCredentials()) saveCloudVault(); // one-time migration from older plain settings
      return sendJSON(res, 200, { data, cloud_credentials_restored: existsSync(CLOUD_VAULT_FILE) });
    }
    catch { return sendJSON(res, 401, { error: 'Incorrect passphrase or unreadable vault' }); }
  }
  if (req.method === 'GET' && p === '/api/cloud/status') {
    return sendJSON(res, 200, {
      connected: Boolean(cfg.aiProvider && (cfg.openaiApiKey || cfg.anthropicApiKey || cfg.geminiApiKey)), vault_unlocked: Boolean(vaultPassphrase),
      cloud_credentials_remembered: existsSync(CLOUD_VAULT_FILE), provider: cfg.aiProvider || '', model: cfg.model || '', baseUrl: cfg.openaiBaseUrl || '',
    });
  }

  // ── Portable kit readiness ───────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/portable/readiness') {
    let ollama = false, models = [];
    let manifest = null, manifestError = '';
    try { manifest = JSON.parse(readFileSync(CAPSULE_FILE, 'utf8')); }
    catch (e) { manifestError = e.message; }
    try {
      const upstream = await upstreamRequest('GET', '/api/tags', { timeout: 4000 });
      if (upstream.ok) { ollama = true; models = (JSON.parse(await upstream.text()).models || []).map((m) => ({ name: m.name, size: m.size || 0 })); }
    } catch {}
    const portableRoot = join(__dirname, manifest?.portable_data_dir || '.portable');
    const portableModels = join(portableRoot, 'ollama', 'models');
    const runtimeId = `${process.platform}-${process.arch}`;
    const runtimeRoot = join(__dirname, 'runtime', 'platforms', runtimeId);
    const nodePath = process.platform === 'win32' ? join(runtimeRoot, 'node', 'node.exe') : join(runtimeRoot, 'node', 'bin', 'node');
    const ollamaPath = join(runtimeRoot, 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    const launcherPath = join(__dirname, process.platform === 'win32' ? 'start-portable.cmd' : 'start-portable.sh');
    const bundledNode = probeRuntime(nodePath, ['--version']);
    const bundledOllama = probeRuntime(ollamaPath, ['--version']);
    const launcherReady = executableFile(launcherPath);
    const isolatedData = Boolean(process.env.LOCAL_AI_DATA_DIR);
    const portable = isolatedData && pathIsInside(portableRoot, DATA_DIR);
    const modelStorage = process.env.OLLAMA_MODELS ? resolve(process.env.OLLAMA_MODELS) : '';
    const portableModelStorage = Boolean(modelStorage) && pathIsInside(portableModels, modelStorage);
    const storageWritable = writableDirectory(portableRoot) && writableDirectory(DATA_DIR);
    const requiredModels = manifest?.offline_profile?.required_models || 1;
    const integrity = portableIntegrityReport(__dirname, INTEGRITY_FILE, { platform: runtimeId });
    let runtimeIndex = null;
    try { runtimeIndex = JSON.parse(readFileSync(RUNTIME_INDEX_FILE, 'utf8')); } catch {}
    const supportedPlatforms = Array.isArray(runtimeIndex?.platforms) ? runtimeIndex.platforms : [];
    const platformCompatible = supportedPlatforms.includes(runtimeId);
    const bundleLabel = supportedPlatforms.length ? `${supportedPlatforms.length} desktop targets` : 'not declared';
    let diskFree = 0;
    try { const fs = statfsSync(portableRoot); diskFree = Number(fs.bavail) * Number(fs.bsize); } catch {}
    const modelBytes = models.reduce((sum, model) => sum + Number(model.size || 0), 0);
    const minMemory = Number(manifest?.offline_profile?.minimum_memory_gb || 8) * 1_000_000_000;
    const memoryOkay = totalmem() >= minMemory;
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const checks = [
      { id: 'server', label: 'App server', ok: nodeMajor >= 18, scope: 'here', detail: `Node ${process.versions.node} is running`, fix: 'Install Node.js 18 or newer.' },
      { id: 'portable_data', label: 'Portable data mode', ok: portable, scope: 'both', detail: portable ? 'App data stays inside .portable' : isolatedData ? 'The configured data folder is outside this Capsule' : 'The app was not started with the portable launcher', fix: 'Start the app with start-portable.sh or start-portable.cmd.' },
      { id: 'writable', label: 'Writable storage', ok: storageWritable, scope: 'both', detail: storageWritable ? 'Portable data folders are writable' : 'The portable data folder is read-only or unavailable', fix: 'Move the Capsule to a writable drive or fix its folder permissions.' },
      { id: 'ollama_live', label: 'Local AI service', ok: ollama, scope: 'here', detail: ollama ? 'Ollama answered the local health check' : 'Ollama did not answer locally', fix: 'Start Ollama with the portable launcher.' },
      { id: 'model', label: 'Local model', ok: models.length >= requiredModels, scope: 'both', detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} available (${(modelBytes / 1_000_000_000).toFixed(1)} GB)` : 'No local model is available', fix: 'Install at least one local model.' },
      { id: 'portable_model', label: 'Portable model storage', ok: portableModelStorage && models.length >= requiredModels, scope: 'transfer', detail: portableModelStorage ? models.length >= requiredModels ? 'Ollama is using .portable/ollama/models' : 'Portable model storage is configured, but it has no available model' : 'The active Ollama model library is not confirmed inside this Capsule', fix: portableModelStorage ? 'Install a model while the app is running from its portable launcher.' : 'Launch through the portable launcher so OLLAMA_MODELS points inside .portable.' },
      { id: 'platform', label: 'Runtime compatibility', ok: platformCompatible, scope: 'transfer', detail: runtimeIndex ? `This computer matches ${runtimeId}` : 'The runtime index is unavailable', fix: `Add a runtime bundle for ${runtimeId}.` },
      { id: 'node_runtime', label: 'Bundled Node runtime', ok: bundledNode.runnable, scope: 'transfer', detail: bundledNode.runnable ? bundledNode.version : bundledNode.present ? bundledNode.error : 'Runtime executable is missing', fix: `Add the ${process.platform}/${process.arch} Node runtime at ${relative(__dirname, nodePath)}.` },
      { id: 'ollama_runtime', label: 'Bundled Ollama runtime', ok: bundledOllama.runnable, scope: 'transfer', detail: bundledOllama.runnable ? bundledOllama.version : bundledOllama.present ? bundledOllama.error : 'Runtime executable is missing', fix: `Add the ${process.platform}/${process.arch} Ollama runtime at ${relative(__dirname, ollamaPath)}.` },
      { id: 'launcher', label: 'Portable launcher', ok: launcherReady, scope: 'transfer', detail: launcherReady ? `${relative(__dirname, launcherPath)} is ready` : `${relative(__dirname, launcherPath)} is missing or not executable`, fix: process.platform === 'win32' ? 'Restore start-portable.cmd.' : 'Restore start-portable.sh and make it executable.' },
      { id: 'integrity', label: 'Capsule files', ok: integrity.verified, scope: 'transfer', detail: integrity.verified ? `${integrity.files.length} release files verified` : 'Files are missing or changed since the integrity manifest was made', fix: 'Restore missing release files or regenerate the manifest after intentional changes.' },
    ];
    const worksHere = checks.filter((check) => check.scope === 'here' || check.scope === 'both').every((check) => check.ok);
    const transferReady = worksHere && checks.filter((check) => check.scope === 'transfer' || check.scope === 'both').every((check) => check.ok);
    return sendJSON(res, 200, {
      portable,
      isolated_data: isolatedData,
      data_dir: DATA_DIR,
      node: process.versions.node,
      bundled_node: bundledNode.runnable,
      bundled_ollama: bundledOllama.runnable,
      ollama,
      models,
      model_bytes: modelBytes,
      portable_model_storage: portableModelStorage,
      manifest,
      manifest_error: manifestError,
      memory_total: totalmem(),
      memory_ok: memoryOkay,
      disk_free: diskFree,
      platform: { os: process.platform, arch: process.arch, id: runtimeId, label: `${process.platform} ${process.arch}`, bundle: bundleLabel, compatible: platformCompatible, supported: supportedPlatforms },
      runtime_source: {
        node: process.env.LOCAL_AI_NODE_BIN || process.execPath,
        ollama: process.env.LOCAL_AI_OLLAMA_BIN || 'unknown',
      },
      checks,
      works_here: worksHere,
      transfer_ready: transferReady,
      offline_ready: transferReady,
    });
  }
  if (req.method === 'GET' && p === '/api/portable/integrity') {
    return sendJSON(res, 200, portableIntegrityReport(__dirname, INTEGRITY_FILE));
  }
  if (req.method === 'GET' && p === '/api/portable/handoff-preview') {
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(CAPSULE_FILE, 'utf8')); } catch {}
    const excluded = new Set(['.git', '.portable', 'node_modules']);
    const include = readdirSync(__dirname)
      .filter((name) => !excluded.has(name))
      .sort()
      .map((name) => ({ name, type: statSync(join(__dirname, name)).isDirectory() ? 'directory' : 'file' }));
    if (existsSync(join(__dirname, '.portable', 'ollama', 'models'))) include.push({ name: '.portable/ollama/models', type: 'directory' });
    return sendJSON(res, 200, {
      include,
      excluded: manifest.handoff?.exclude_by_default || ['.portable/data', '.portable/logs', '.portable/ollama/models'],
      note: manifest.handoff?.include_notice || '',
      recipient_guidance: [
        'The included runtimes are for Linux x64; another platform needs its own matching bundle.',
        'Keep .portable/ollama/models in the handoff so the Capsule remains offline-ready.',
        'Leave personal data, logs, Vault files, and cloud credentials out of a shared copy.',
        'Run Portable Readiness on the recipient machine before using the Capsule.',
      ],
    });
  }
  if (req.method === 'GET' && p === '/api/remote/status') {
    if (!isDirectLocalRequest(req)) return sendJSON(res, 403, { error: 'Capsule Remote controls are available only from the local app' });
    return sendJSON(res, 200, { active: Boolean(remoteTunnel.child), url: remoteTunnel.url, token: remoteTunnel.token, expires_at: remoteTunnel.expiresAt || 0, api_url: remoteTunnel.url ? remoteTunnel.url + '/v1' : '' });
  }
  if (req.method === 'GET' && p === '/api/remote/qr') {
    if (!isDirectLocalRequest(req)) return sendJSON(res, 403, { error: 'Capsule Remote controls are available only from the local app' });
    if (!remoteTunnel.child || !remoteTunnel.url || !remoteTunnel.token) return sendJSON(res, 409, { error: 'Start Remote before requesting its QR code' });
    const qr = qrcode(0, 'M');
    qr.addData(remoteTunnel.url + '/remote/' + encodeURIComponent(remoteTunnel.token));
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(svg);
  }
  if (req.method === 'POST' && p === '/api/remote/start') {
    if (!isDirectLocalRequest(req)) return sendJSON(res, 403, { error: 'Capsule Remote controls are available only from the local app' });
    if (cfg.mode !== 'local') return sendJSON(res, 400, { error: 'Capsule Remote starts only from local mode' });
    if (!remoteTunnel.child) {
      remoteTunnel.token = randomBytes(24).toString('base64url');
      remoteTunnel.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
      cfg.authToken = remoteTunnel.token;
      armRemoteExpiry();
      await startTunnel();
    }
    return sendJSON(res, 200, { active: Boolean(remoteTunnel.child), token: remoteTunnel.token, expires_at: remoteTunnel.expiresAt, url: remoteTunnel.url, api_url: remoteTunnel.url ? remoteTunnel.url + '/v1' : '' });
  }
  if (req.method === 'POST' && p === '/api/remote/stop') {
    if (!isDirectLocalRequest(req)) return sendJSON(res, 403, { error: 'Capsule Remote controls are available only from the local app' });
    stopRemote();
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/skills') {
    try { return sendJSON(res, 200, JSON.parse(readFileSync(SKILLS_FILE, 'utf8'))); }
    catch { return sendJSON(res, 500, { error: 'Offline skill library is unavailable' }); }
  }

  // Deep Research uses the selected local Ollama model while its web sources
  // and reports stay in portable data. It is never available through Remote.
  if (p === '/api/research' && req.method === 'POST') {
    if (!localControlAllowed(req)) return sendJSON(res, 403, { error: 'Deep Research is available only in the local app' });
    if ([...researchEngine.jobs.values()].some((job) => job.status === 'running')) return sendJSON(res, 409, { error: 'Finish or cancel the current research run before starting another' });
    let payload;
    try { payload = JSON.parse(await readBody(req, 20_000)); } catch { return sendJSON(res, 400, { error: 'Invalid research request' }); }
    try { return sendJSON(res, 202, researchEngine.start({ query: String(payload.query || '').trim(), model: String(payload.model || '').trim(), mode: payload.mode || 'quick' })); }
    catch (error) { return sendJSON(res, 400, { error: error.message }); }
  }
  if (p === '/api/research' && req.method === 'GET') {
    return sendJSON(res, 200, { reports: researchEngine.list() });
  }
  if (p.startsWith('/api/research/')) {
    const id = p.slice('/api/research/'.length);
    if (!/^[a-f0-9-]{30,50}$/i.test(id)) return sendJSON(res, 400, { error: 'Invalid research id' });
    if (req.method === 'DELETE') {
      const cancelled = researchEngine.cancel(id);
      return sendJSON(res, cancelled ? 202 : 409, cancelled ? { ok: true } : { error: 'Research is not running' });
    }
    if (req.method === 'GET') {
      const result = researchEngine.get(id, url.searchParams.get('include') === 'report');
      return result ? sendJSON(res, 200, result) : sendJSON(res, 404, { error: 'Research report not found' });
    }
  }
  if (req.method === 'POST' && p === '/api/cloud/connect') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const provider = String(payload.provider || '').toLowerCase();
    if (!['openai', 'anthropic', 'gemini'].includes(provider)) return sendJSON(res, 400, { error: 'Choose OpenAI, Anthropic, or Gemini' });
    const key = String(payload.apiKey || '').trim();
    if (!key || key.length < 12) return sendJSON(res, 400, { error: 'Enter a valid API key' });
    cfg.aiProvider = provider;
    cfg.model = String(payload.model || '').trim();
    cfg.openaiBaseUrl = String(payload.baseUrl || '').trim();
    cfg.openaiApiKey = provider === 'openai' ? key : '';
    cfg.anthropicApiKey = provider === 'anthropic' ? key : '';
    cfg.geminiApiKey = provider === 'gemini' ? key : '';
    if (payload.remember) {
      try { saveCloudVault(); }
      catch (e) { return sendJSON(res, 409, { error: e.message }); }
    }
    return sendJSON(res, 200, { ok: true, provider: cfg.aiProvider, model: cfg.model, remembered: Boolean(payload.remember) });
  }
  if (req.method === 'POST' && p === '/api/cloud/disconnect') {
    cfg.aiProvider = ''; cfg.model = ''; cfg.openaiBaseUrl = ''; cfg.openaiApiKey = ''; cfg.anthropicApiKey = ''; cfg.geminiApiKey = '';
    saveConfig({ AI_PROVIDER: '', AI_DISPLAY_MODEL: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
    try { if (existsSync(CLOUD_VAULT_FILE)) unlinkSync(CLOUD_VAULT_FILE); } catch {}
    return sendJSON(res, 200, { ok: true });
  }

  // ── Local model cockpit ─────────────────────────────────────────────────
  // This intentionally exposes only coarse local machine stats plus Ollama's
  // own running-model metadata; it never uploads machine or model information.
  if (req.method === 'GET' && p === '/api/cockpit') {
    let running = [];
    let ollama = false;
    try {
      const u = await upstreamRequest('GET', '/api/ps', { timeout: 4000 });
      if (u.ok) {
        const j = JSON.parse(await u.text());
        running = (j.models || []).map((m) => ({
          name: m.name || '',
          size: m.size || 0,
          size_vram: m.size_vram || 0,
          expires_at: m.expires_at || '',
        }));
        ollama = true;
      }
    } catch {}
    return sendJSON(res, 200, {
      ollama,
      system: {
        memory_total: totalmem(),
        memory_free: freemem(),
        cpu_cores: cpus().length,
        load_average: loadavg(),
      },
      running,
    });
  }

  // ── Supervised local agent tools ─────────────────────────────────────────
  if (p.startsWith('/api/agent/')) {
    if (!agentToolsAllowed(req)) return sendJSON(res, 403, { error: 'Agent tools are available only from the local app, never through a tunnel.' });

    if (req.method === 'GET' && p === '/api/agent/files') {
      try {
        const target = agentWorkspacePath(url.searchParams.get('path') || '');
        const st = statSync(target);
        if (st.isDirectory()) {
          const entries = readdirSync(target, { withFileTypes: true })
            .filter((entry) => !['.git', '.portable', 'node_modules'].includes(entry.name))
            .slice(0, 200)
            .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
          return sendJSON(res, 200, { path: relative(__dirname, target) || '.', type: 'directory', entries });
        }
        if (st.size > 300_000) return sendJSON(res, 413, { error: 'File is over the 300 KB agent-read limit' });
        return sendJSON(res, 200, { path: relative(__dirname, target), type: 'file', content: readFileSync(target, 'utf8') });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }

    if (req.method === 'POST' && p === '/api/agent/write') {
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
      if (payload.approval !== 'write') return sendJSON(res, 403, { error: 'Explicit write approval is required' });
      if (typeof payload.content !== 'string' || payload.content.length > 1_000_000) return sendJSON(res, 400, { error: 'Content must be text under 1 MB' });
      try {
        const target = agentWorkspacePath(payload.path || '');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, payload.content, 'utf8');
        return sendJSON(res, 200, { ok: true, path: relative(__dirname, target) });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }

    if (req.method === 'POST' && p === '/api/agent/command') {
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
      const command = typeof payload.command === 'string' ? payload.command.trim() : '';
      if (payload.approval !== 'run') return sendJSON(res, 403, { error: 'Explicit command approval is required' });
      if (!command || command.length > 500) return sendJSON(res, 400, { error: 'Command must be between 1 and 500 characters' });
      const output = await new Promise((resolve) => {
        const proc = spawn(command, { cwd: __dirname, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, 30_000);
        proc.stdout.on('data', (d) => { if (stdout.length < 60_000) stdout += d; });
        proc.stderr.on('data', (d) => { if (stderr.length < 60_000) stderr += d; });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout, stderr }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: !timedOut && code === 0, code, timedOut, stdout, stderr }); });
      });
      return sendJSON(res, 200, output);
    }

    return sendJSON(res, 404, { error: 'Unknown agent tool' });
  }

  // ── Local-only Model Library ─────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/models/library') {
    try { return sendJSON(res, 200, await buildModelLibrary()); }
    catch (error) { return sendJSON(res, 503, { error: 'Could not reach the local Ollama library: ' + error.message }); }
  }

  if (req.method === 'POST' && p === '/api/models/load') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 20_000)); }
    catch { return sendJSON(res, 400, { error: 'Invalid load request' }); }
    let requested;
    try { requested = validateModelName(payload?.model); }
    catch (error) { return sendJSON(res, 400, { error: error.message }); }
    if (modelUnloadActive) return sendJSON(res, 409, { error: 'Another model memory operation is already running' });
    modelUnloadActive = true;
    try {
      if (activeOllamaGenerations.size) {
        return sendJSON(res, 409, { error: 'Finish or stop the active response before loading another model' });
      }
      let tags;
      try { tags = await ollamaTags(); }
      catch (error) { return sendJSON(res, 503, { error: 'Portable Ollama is not available: ' + error.message }); }
      const installed = tags.find((tag) => modelNamesMatch(tag.name || tag.model, requested));
      if (!installed) return sendJSON(res, 404, { error: 'That model is not installed' });
      const canonical = installed.name || installed.model;
      let loaded;
      try { loaded = await ollamaLoadedModels(); }
      catch (error) { return sendJSON(res, 503, { error: 'Could not read Ollama memory state: ' + error.message }); }
      const existing = loaded.find((model) => modelNamesMatch(model.name, canonical));
      if (existing) return sendJSON(res, 200, { ok: true, model: existing, already_loaded: true });
      try {
        await ollamaJSON('POST', '/api/generate', { model: canonical, prompt: '', stream: false, keep_alive: -1 }, 10 * 60_000);
      } catch (error) {
        return sendJSON(res, 502, { error: 'Ollama could not load this model: ' + error.message });
      }
      let runtime;
      try { runtime = await waitForOllamaLoad(canonical); }
      catch (error) { return sendJSON(res, 502, { error: 'The final Ollama memory state could not be verified: ' + error.message }); }
      if (!runtime) return sendJSON(res, 504, { error: 'Ollama finished loading but did not report the model in memory. Try again.' });
      return sendJSON(res, 200, { ok: true, model: runtime, already_loaded: false });
    } finally {
      modelUnloadActive = false;
    }
  }

  if (req.method === 'POST' && p === '/api/models/unload') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 20_000)); }
    catch { return sendJSON(res, 400, { error: 'Invalid unload request' }); }
    const unloadAll = payload?.all === true;
    if (unloadAll && payload.model) return sendJSON(res, 400, { error: 'Choose one model or unload all, not both' });
    let requested = '';
    if (!unloadAll) {
      try { requested = validateModelName(payload?.model); }
      catch (error) { return sendJSON(res, 400, { error: error.message }); }
    }
    if (modelUnloadActive) return sendJSON(res, 409, { error: 'Another model memory operation is already running' });
    modelUnloadActive = true;
    try {
      if (activeOllamaGenerations.size) {
        return sendJSON(res, 409, { error: 'Finish or stop the active response before unloading model memory' });
      }

      let canonical = requested;
      if (!unloadAll) {
        let tags;
        try { tags = await ollamaTags(); }
        catch (error) { return sendJSON(res, 503, { error: 'Portable Ollama is not available: ' + error.message }); }
        const installed = tags.find((tag) => modelNamesMatch(tag.name || tag.model, requested));
        if (!installed) return sendJSON(res, 404, { error: 'That model is not installed' });
        canonical = installed.name || installed.model;
      }

      let loaded;
      try { loaded = await ollamaLoadedModels(); }
      catch (error) { return sendJSON(res, 503, { error: 'Could not read Ollama memory state: ' + error.message }); }
      const targets = unloadAll
        ? [...new Map(loaded.map((model) => [normalizedModelName(model.name), model.name])).values()]
        : loaded.filter((model) => modelNamesMatch(model.name, canonical)).map((model) => model.name).slice(0, 1);
      if (!targets.length) {
        return sendJSON(res, 200, {
          ok: true,
          unloaded: [],
          already_unloaded: unloadAll ? [] : [canonical],
          still_running: [],
        });
      }

      const failures = [];
      for (const model of targets) {
        try { await ollamaJSON('POST', '/api/generate', { model, keep_alive: 0 }, 30000); }
        catch (error) { failures.push({ model, error: error.message }); }
      }

      let stillRunning;
      try { stillRunning = await waitForOllamaUnload(targets); }
      catch (error) {
        return sendJSON(res, 502, {
          ok: false,
          error: 'The final Ollama memory state could not be verified: ' + error.message,
          unloaded: [],
          failures,
          requested: targets,
          still_running: null,
        });
      }
      const remainingNames = stillRunning.map((model) => model.name);
      const unloaded = targets.filter((model) => !remainingNames.some((name) => modelNamesMatch(name, model)));
      if (remainingNames.length) {
        return sendJSON(res, 504, {
          ok: false,
          error: 'Ollama still reports one or more models loaded. Wait a moment and try again.',
          unloaded,
          failures,
          still_running: remainingNames,
        });
      }
      return sendJSON(res, 200, {
        ok: true,
        unloaded,
        already_unloaded: [],
        still_running: [],
        warnings: failures.map((failure) => `${failure.model}: ${failure.error}`),
      });
    } finally {
      modelUnloadActive = false;
    }
  }

  // Backward-compatible recommendation endpoint used by older Capsule UIs.
  if (req.method === 'GET' && p === '/api/models/recommended') {
    const system = localHardwareProfile();
    let installed = [];
    try { installed = await ollamaTags(); } catch {}
    return sendJSON(res, 200, recommendationsFor(system, installed));
  }

  if (req.method === 'POST' && p === '/api/models/install') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid installer request' }); }
    const system = localHardwareProfile();
    let preset = CURATED_MODELS.find((item) => item.id === payload.preset)
      || (payload.preset === 'uncensored' ? chooseUncensoredModel(system) : null);
    if (!preset && payload.model) {
      try {
        const model = validateModelName(payload.model);
        preset = { id: 'custom', name: model, model, download_gb: 0, memory_gb: 0, description: 'Custom Ollama model' };
      } catch (error) { return sendJSON(res, 400, { error: error.message }); }
    }
    if (!preset) return sendJSON(res, 400, { error: 'Choose a recommended model or enter an Ollama model name' });

    let installed;
    try { installed = await ollamaTags(); }
    catch (error) { return sendJSON(res, 503, { error: 'Portable Ollama is not available: ' + error.message }); }
    const alreadyInstalled = installed.find((item) => modelNamesMatch(item.name || item.model, preset.model));
    if (alreadyInstalled) return sendJSON(res, 200, { id: '', status: 'ready', model: alreadyInstalled.name || alreadyInstalled.model, already_installed: true });

    const existing = [...downloads.values()].find((job) => job.kind === 'ollama-pull' && modelNamesMatch(job.model, preset.model) && activeModelJob(job));
    if (existing) return sendJSON(res, 200, { ...publicModelJob(existing), existing: true });
    const storageJob = activeStorageJob();
    if (storageJob) return sendJSON(res, 409, { error: `Another model download is already ${storageJob.status}. Wait for it to finish or cancel it first.` });

    const preflight = ollamaPullPreflight(preset, system);
    if (!preflight.ok) {
      const diskProblem = !preflight.fits_disk || !preflight.fits_filesystem;
      return sendJSON(res, diskProblem ? 507 : 409, { error: preflight.issues.join(' ') || 'This model cannot be installed yet', preflight });
    }

    const id = 'pull-' + (++downloadSeq);
    const controller = new AbortController();
    const job = {
      id, kind: 'ollama-pull', preset: preset.id, model: preset.model, name: preset.name,
      status: 'starting', detail: 'Contacting Ollama…', downloaded: 0, total: 0,
      estimated_total: preflight.estimated_bytes, layer_progress: {}, error: null,
      resumable: true, preflight, started_at: Date.now(), controller,
    };
    downloads.set(id, job);
    (async () => {
      try {
        const pull = await pullOllamaModel({
          baseUrl: cfg.ollamaUrl,
          model: preset.model,
          signal: controller.signal,
          onUpdate(update, progress) {
          const rawStatus = String(update.status || 'downloading');
          job.detail = rawStatus;
          job.reconnects = progress.reconnects;
          job.last_progress_at = progress.lastProgressAt;
          if (update.digest) {
            const layerTotal = Number(update.total || 0);
            const layerCompleted = Number(update.completed || 0);
            job.layer_progress[update.digest] = {
              completed: layerCompleted,
              total: layerTotal,
            };
            const storageNow = modelStorageProfile();
            const remaining = Math.max(0, layerTotal - layerCompleted);
            if (!storageNow.space_known) {
              throw new Error('Portable free space could no longer be measured. Check the drive, then retry the model download.');
            }
            if (remaining + job.preflight.reserve_bytes > storageNow.free_bytes) {
              throw new Error('The current model layer is larger than the remaining portable storage. Free space, then retry; Ollama will resume partial layers.');
            }
            if (storageNow.large_file_limit_bytes && layerTotal > storageNow.large_file_limit_bytes) {
              throw new Error('This model contains a file larger than FAT32 supports. Move the Capsule to exFAT, NTFS, APFS, or ext4, then retry.');
            }
          }
          if (rawStatus === 'success') job.status = 'verifying';
          else if (/verifying/i.test(rawStatus)) job.status = 'verifying';
          else if (/writing manifest/i.test(rawStatus)) job.status = 'finalizing';
          else if (update.digest || /pulling|download/i.test(rawStatus)) job.status = 'downloading';
          },
          onReconnect({ reconnects, maxReconnects, error }) {
            job.status = 'reconnecting';
            job.reconnects = reconnects;
            job.detail = `Connection stalled — reconnecting (${reconnects}/${maxReconnects}). Downloaded data is safe.`;
            job.last_reconnect_error = String(error?.message || error).slice(0, 240);
          },
        });
        const sawSuccess = pull.sawSuccess;
        job.status = 'verifying';
        job.detail = sawSuccess ? 'Confirming the installed model…' : 'The download stream ended; confirming the model before marking it ready…';
        await ollamaJSON('POST', '/api/show', { model: preset.model }, 15000);
        const refreshed = await ollamaTags();
        const installedTag = refreshed.find((item) => modelNamesMatch(item.name || item.model, preset.model));
        if (!installedTag) throw new Error('Ollama finished the pull but the model is not present in its library');
        const fileCheck = inspectModelFiles(installedTag.name || installedTag.model, installedTag.digest);
        if (fileCheck.available && !fileCheck.ok) throw new Error(fileCheck.issues.join(' ') || 'Installed model files need attention');
        rememberFullModelVerification(installedTag.name || installedTag.model, {
          model_digest: installedTag.digest || fileCheck.manifest_digest,
          verified_at: Date.now(),
          method: 'Ollama SHA-256 verification during pull',
          files: modelFileSnapshot(fileCheck),
        });
        job.model = installedTag.name || installedTag.model;
        job.status = 'ready';
        job.detail = 'Ready to use';
        job.finished_at = Date.now();
      } catch (error) {
        const cancelled = Boolean(job.cancel_requested);
        job.error = cancelled ? 'Installation cancelled. Retry this model later to resume its partial download.' : error.message;
        job.status = cancelled ? 'cancelled' : 'error';
        job.detail = cancelled ? 'Cancelled' : 'Installation stopped';
        job.finished_at = Date.now();
        if (!controller.signal.aborted) controller.abort();
      } finally { delete job.controller; pruneModelJobs(); }
    })();
    return sendJSON(res, 202, publicModelJob(job));
  }

  if (req.method === 'GET' && p === '/api/models/install') {
    const job = downloads.get(url.searchParams.get('id') || '');
    if (!job || job.kind !== 'ollama-pull') return sendJSON(res, 404, { error: 'Unknown installation' });
    return sendJSON(res, 200, publicModelJob(job));
  }
  if (req.method === 'DELETE' && p === '/api/models/install') {
    const job = downloads.get(url.searchParams.get('id') || '');
    if (!job || job.kind !== 'ollama-pull') return sendJSON(res, 404, { error: 'Unknown installation' });
    if (!activeModelJob(job)) return sendJSON(res, 409, { error: 'This installation is no longer running' });
    job.cancel_requested = true;
    job.status = 'cancelling';
    job.detail = 'Stopping after the current write…';
    if (job.controller) job.controller.abort();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/models/verify') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'Invalid verification request' }); }
    let requested;
    try { requested = validateModelName(payload.model); }
    catch (error) { return sendJSON(res, 400, { error: error.message }); }
    let tags;
    try { tags = await ollamaTags(); }
    catch (error) { return sendJSON(res, 503, { error: 'Portable Ollama is not available: ' + error.message }); }
    const tag = tags.find((item) => modelNamesMatch(item.name || item.model, requested));
    if (!tag) return sendJSON(res, 404, { error: 'That model is not installed' });
    const model = tag.name || tag.model;
    const existing = [...downloads.values()].find((job) => job.kind === 'model-verify' && modelNamesMatch(job.model, model) && activeModelJob(job));
    if (existing) return sendJSON(res, 200, { ...publicModelJob(existing), existing: true });
    const id = 'verify-' + (++downloadSeq), controller = new AbortController();
    const job = { id, kind: 'model-verify', model, name: 'Verify ' + model, status: 'verifying', detail: 'Reading the model files…', downloaded: 0, total: 0, error: null, started_at: Date.now(), controller };
    downloads.set(id, job);
    (async () => {
      try {
        const result = await runFullModelVerification(job, tag);
        job.status = 'ready';
        job.detail = 'Every model file passed SHA-256 verification';
        job.verification = result;
      } catch (error) {
        const cancelled = Boolean(job.cancel_requested);
        job.status = cancelled ? 'cancelled' : 'error';
        job.error = cancelled ? 'Verification cancelled' : error.message;
      } finally { job.finished_at = Date.now(); delete job.controller; pruneModelJobs(); }
    })();
    return sendJSON(res, 202, publicModelJob(job));
  }
  if (req.method === 'GET' && p === '/api/models/verify') {
    const job = downloads.get(url.searchParams.get('id') || '');
    if (!job || job.kind !== 'model-verify') return sendJSON(res, 404, { error: 'Unknown verification' });
    return sendJSON(res, 200, publicModelJob(job));
  }
  if (req.method === 'DELETE' && p === '/api/models/verify') {
    const job = downloads.get(url.searchParams.get('id') || '');
    if (!job || job.kind !== 'model-verify') return sendJSON(res, 404, { error: 'Unknown verification' });
    if (!activeModelJob(job)) return sendJSON(res, 409, { error: 'This verification is no longer running' });
    job.cancel_requested = true;
    job.status = 'cancelling';
    if (job.controller) job.controller.abort();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && p === '/api/models/library') {
    let payload;
    try { payload = JSON.parse(await readBody(req, 20_000)); } catch { return sendJSON(res, 400, { error: 'Invalid removal request' }); }
    let requested;
    try { requested = validateModelName(payload.model); }
    catch (error) { return sendJSON(res, 400, { error: error.message }); }
    if (payload.confirm !== requested) return sendJSON(res, 400, { error: 'Removal requires the exact model name as confirmation' });
    let tags;
    try { tags = await ollamaTags(); }
    catch (error) { return sendJSON(res, 503, { error: 'Portable Ollama is not available: ' + error.message }); }
    const tag = tags.find((item) => modelNamesMatch(item.name || item.model, requested));
    if (!tag) return sendJSON(res, 404, { error: 'That model is not installed' });
    const model = tag.name || tag.model;
    const busy = [...downloads.values()].find((job) => modelNamesMatch(job.model, model) && activeModelJob(job));
    if (busy) return sendJSON(res, 409, { error: 'Wait for the active model job to finish or cancel it before removing this model' });
    let running;
    try { running = await ollamaJSON('GET', '/api/ps'); }
    catch (error) {
      return sendJSON(res, 503, { error: 'Could not confirm whether this model is loaded, so nothing was removed. Try again when portable Ollama is responding.' });
    }
    if ((running.models || []).some((item) => modelNamesMatch(item.name || item.model, model))) {
      return sendJSON(res, 409, { error: 'This model is currently loaded. Wait for Ollama to unload it, then try again.' });
    }
    try { await ollamaJSON('DELETE', '/api/delete', { model }, 30000); }
    catch (error) { return sendJSON(res, error.status === 404 ? 404 : 502, { error: 'Ollama could not remove the model: ' + error.message }); }
    forgetFullModelVerification(model);
    forgetLocalModelImport(model);
    return sendJSON(res, 200, { ok: true, model });
  }

  // ── Native model list ────────────────────────────────────────────────────
  if (req.method === 'GET' && (p === '/api/models' || p === '/models')) {
    if (cfg.aiProvider === 'openai' || cfg.aiProvider === 'anthropic' || cfg.aiProvider === 'gemini') {
      return sendJSON(res, 200, { models: cfg.model ? [{ name: cfg.model }] : [] });
    }
    return listModels(res);
  }

  // ── Local model folder listing ───────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/models/local') {
    return sendJSON(res, 200, { models: scanModels(), folder: MODELS_DIR });
  }

  // ── Register a local .gguf model into Ollama (creates an importable model) ─
  if (req.method === 'POST' && p === '/api/models/register') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload = {};
    try { payload = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const source = String(payload.source || payload.name || '').trim();
    if (!source) return sendJSON(res, 400, { error: 'Choose a detected GGUF file' });
    try {
      const model = scanModels().find((item) => item.kind === 'gguf' && item.name === source);
      if (!model) return sendJSON(res, 404, { error: 'That GGUF file is no longer in the import folder' });
      if (!model.complete) return sendJSON(res, 409, { error: model.shard_issue || 'This GGUF shard set is incomplete' });
      const storageJob = activeStorageJob();
      if (storageJob) return sendJSON(res, 409, { error: `Wait for the active model download to finish before importing this GGUF.` });
      const preflight = modelInstallPreflight({
        download_gb: Number(model.size || 0) / 1_000_000_000,
        memory_gb: 0,
        largest_file_bytes: Math.max(0, ...(model.shards || []).map((shard) => Number(shard.size || 0)), Number(model.shards?.length ? 0 : model.size || 0)),
      });
      if (!preflight.ok) {
        const diskProblem = !preflight.fits_disk || !preflight.fits_filesystem;
        return sendJSON(res, diskProblem ? 507 : 409, { error: preflight.issues.join(' ') || 'This GGUF cannot be registered yet', preflight });
      }
      const name = validateModelName(payload.model || payload.model_name || suggestedModelName(source));
      const result = await registerLocalModel(name, resolveModelFiles(model));
      await ollamaJSON('POST', '/api/show', { model: name }, 15000);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: 'Registration failed: ' + e.message });
    }
  }

  // ── Download a model (.gguf) from HuggingFace or a direct URL ────────────
  if (req.method === 'POST' && p === '/api/models/download') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload = {};
    try { payload = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const spec = (payload.spec || '').trim();
    if (!spec) return sendJSON(res, 400, { error: 'Missing spec (HuggingFace repo id, file path, or URL)' });
    const storageJob = activeStorageJob();
    if (storageJob) return sendJSON(res, 409, { error: `Another model download is already ${storageJob.status}. Wait for it to finish or cancel it first.` });
    const preflight = modelInstallPreflight({ download_gb: 0, memory_gb: 0 });
    if (!preflight.ok) {
      const diskProblem = !preflight.fits_disk || !preflight.fits_filesystem;
      return sendJSON(res, diskProblem ? 507 : 409, { error: preflight.issues.join(' ') || 'Portable model storage is not ready', preflight });
    }
    if (!writableDirectory(MODELS_DIR)) return sendJSON(res, 409, { error: 'The local GGUF import folder is not writable' });

    const id = 'dl-' + (++downloadSeq);
    const job = { id, kind: 'gguf-download', spec, status: 'starting', filename: null, downloaded: 0, total: 0, error: null, started_at: Date.now() };
    downloads.set(id, job);

    (async () => {
      try {
        const result = await downloadModel(spec, (p) => {
          job.downloaded = p.downloaded;
          job.total = p.total;
          job.filename = p.filename || job.filename;
          job.status = 'downloading';
        });
        job.filename = result.filenames.join(', ');
        job.base = result.base;
        job.status = 'registering';
        job.model = suggestedModelName(result.base);
        const downloadedSizes = result.filenames.map((name) => {
          try { return statSync(join(MODELS_DIR, name)).size; } catch { return 0; }
        });
        const downloadedBytes = downloadedSizes.reduce((sum, size) => sum + size, 0);
        const registrationPreflight = modelInstallPreflight({
          download_gb: downloadedBytes / 1_000_000_000,
          memory_gb: 0,
          largest_file_bytes: Math.max(0, ...downloadedSizes),
        });
        if (!registrationPreflight.ok) throw new Error(registrationPreflight.issues.join(' ') || 'There is not enough portable storage to register this GGUF');
        await registerLocalModel(job.model, result.filenames.map((name) => join(MODELS_DIR, name)));
        await ollamaJSON('POST', '/api/show', { model: job.model }, 15000);
        job.status = 'ready';
        job.finished_at = Date.now();
      } catch (e) {
        job.error = e.message;
        job.status = 'error';
        job.finished_at = Date.now();
      }
    })();

    return sendJSON(res, 200, { id, status: job.status });
  }

  if (req.method === 'GET' && p === '/api/models/download') {
    const id = url.searchParams.get('id') || '';
    const job = id ? downloads.get(id) : null;
    if (!job) return sendJSON(res, 404, { error: 'Unknown download id' });
    return sendJSON(res, 200, publicModelJob(job));
  }

  if (req.method === 'GET' && p === '/api/models/downloads') {
    return sendJSON(res, 200, { downloads: [...downloads.values()].map(publicModelJob) });
  }

  // ── Native streaming chat (used by the bundled UI) ───────────────────────
  if (p === '/api/chat' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    return streamChat(payload, res);
  }

  // ── Provider routing for /v1/* endpoints ────────────────────────────────
  // If a non-Ollama provider is configured, translate OpenAI-compatible
  // requests to that provider's native API instead of proxying to Ollama.
  if (p === '/v1/models') {
    if (isCloudProvider()) return proxyCloud('GET', '/v1/models', null, res);
    return proxyV1('GET', '/v1/models', null, res);
  }
  if (p === '/v1/chat/completions' || p === '/v1/completions' || p === '/v1/embeddings') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    if (isCloudProvider()) return proxyCloud(req.method, p, body, res);
    return proxyV1(req.method, p, body, res);
  }
  if (p.startsWith('/v1/')) {
    let body = null;
    if (req.method !== 'GET') { try { body = await readBody(req); } catch {} }
    if (isCloudProvider()) return proxyCloud(req.method, p, body, res);
    return proxyV1(req.method, p, body, res);
  }

  sendJSON(res, 404, { error: 'Not found' });
}

function isCloudProvider() {
  return cfg.aiProvider === 'openai' || cfg.aiProvider === 'anthropic' || cfg.aiProvider === 'gemini';
}

async function researchModelCompletion({ model, messages, signal }) {
  if (modelUnloadActive) throw new Error('A model memory operation is running. Try research again in a moment.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const releaseGeneration = beginOllamaGeneration(model);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.OLLAMA_API_KEY) headers.Authorization = 'Bearer ' + process.env.OLLAMA_API_KEY;
    const response = await fetch(cfg.ollamaUrl + '/v1/chat/completions', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.2 }),
    });
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('The local model returned an empty research step');
    return content;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Research cancelled', 'AbortError');
    if (error?.name === 'AbortError') throw new Error('The local model took too long during a research step');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    releaseGeneration();
  }
}

// Keep the chat selector limited to models Ollama can actually load. GGUF files
// waiting in models/ are surfaced by the owner-only Model Library instead.
async function listModels(res) {
  try {
    const tags = await ollamaTags();
    const models = tags.map((tag) => ({
      name: tag.name || tag.model,
      model: tag.model || tag.name,
      source: 'ollama',
      size: Number(tag.size || 0),
      digest: tag.digest || '',
      modified_at: tag.modified_at || '',
      details: tag.details || {},
      capabilities: tag.capabilities || [],
    }));
    return sendJSON(res, 200, { models });
  } catch {
    return sendJSON(res, 200, { models: [], ollama_online: false });
  }
}

async function proxyV1(method, path, body, res) {
  // Ollama's OpenAI-compatible surface grows over time (for example,
  // /v1/responses). Conservatively serialize every mutating /v1 request with
  // memory unloads so a newly supported generation route cannot be interrupted.
  const inferenceRequest = method !== 'GET' && path.startsWith('/v1/');
  let requestedModel = '';
  if (inferenceRequest) {
    try { requestedModel = JSON.parse(body || '{}').model || ''; } catch {}
    if (modelUnloadActive) return sendJSON(res, 409, { error: 'A model memory operation is running. Try the request again in a moment.' });
  }
  const releaseGeneration = inferenceRequest ? beginOllamaGeneration(requestedModel) : () => {};
  try {
    const headers = { Accept: '*/*' };
    const upKey = process.env.OLLAMA_API_KEY;
    if (upKey) headers['Authorization'] = 'Bearer ' + upKey;

    const r = await upstreamRequest(method, path, {
      body,
      headers,
      timeout: 300000,
    });

    for (const [k, v] of ['content-type', 'cache-control', 'connection', 'transfer-encoding']) {
      const val = r.headers.get(k);
      if (val) res.setHeader(k, val);
    }
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.writeHead(r.status);
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    try { sendJSON(res, 502, { error: 'Upstream proxy error: ' + e.message }); } catch {}
  } finally { releaseGeneration(); }
}

// ------------------------------------------------- cross-provider support
// Mirrors dashboard/server.mjs provider dispatch so the chat-app reuses the
// provider already saved in data/ai_settings.env (no re-entering credentials).

function anthropicBase() {
  return 'https://api.anthropic.com/v1';
}

function geminiUrl(model, stream) {
  const m = model || 'gemini-2.0-pro-exp-02-05';
  const op = stream ? 'streamGenerateContent' : 'generateContent';
  return `https://generativelanguage.googleapis.com/v1beta/models/${m}:${op}?key=${cfg.geminiApiKey}`;
}

function openaiBase() {
  return (cfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

// Convert OpenAI chat-completions message list into Anthropic's wire format.
function toAnthropicMessages(messages) {
  let system = '';
  const filtered = [];
  for (const m of messages) {
    if (m.role === 'system') system = (system ? system + '\n' : '') + m.content;
    else filtered.push({ role: m.role, content: m.content });
  }
  return { system, filtered };
}

// Convert OpenAI chat-completions message list into Gemini's wire format.
function toGeminiContents(messages) {
  const contents = [];
  let system = '';
  for (const m of messages) {
    if (m.role === 'system') { system = (system ? system + '\n' : '') + m.content; continue; }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  return { contents, system };
}

// Route /v1/* OpenAI-compatible requests to the active cloud provider.
async function proxyCloud(method, path, body, res) {
  const mapped = mapProviderPath(path, method, body);
  if (!mapped) return sendJSON(res, 404, { error: 'Unsupported endpoint for provider: ' + cfg.aiProvider });
  const { url, headers } = mapped;
  try {
    const h = { ...(mapped.body != null ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const r = await fetch(url, { method, headers: h, ...(mapped.body != null ? { body: mapped.body } : {}) });
    for (const [k, v] of ['content-type', 'cache-control', 'connection', 'transfer-encoding']) {
      const val = r.headers.get(k);
      if (val) res.setHeader(k, val);
    }
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.writeHead(r.status);
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    try { sendJSON(res, 502, { error: 'Provider proxy error: ' + e.message }); } catch {}
  }
}

// Build the provider-specific request for a given OpenAI-compatible path.
function mapProviderPath(path, method, body) {
  let payload;
  try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

  if (cfg.aiProvider === 'openai') {
    const url = openaiBase() + path;
    const headers = { 'Authorization': 'Bearer ' + (cfg.openaiApiKey || '') };
    if (openaiBase().includes('openrouter')) {
      headers['HTTP-Referer'] = 'http://localhost:5173';
      headers['X-Title'] = 'Local AI Chat';
    }
    return { url, headers, body };
  }

  if (cfg.aiProvider === 'anthropic') {
    if (path === '/v1/models') return null; // Anthropic has no OpenAI-style models endpoint
    const model = (payload.model || cfg.model || 'claude-3-5-sonnet-20241022');
    const { system, filtered } = toAnthropicMessages(payload.messages || []);
    const ap = {
      model,
      messages: filtered,
      max_tokens: payload.max_tokens || 4096,
      stream: Boolean(payload.stream),
    };
    if (system) ap.system = system;
    const headers = {
      'x-api-key': cfg.anthropicApiKey || '',
      'anthropic-version': '2023-06-01',
    };
    return { url: anthropicBase() + '/messages', headers, body: JSON.stringify(ap) };
  }

  if (cfg.aiProvider === 'gemini') {
    if (path === '/v1/models') {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.geminiApiKey}`,
        headers: {},
        body: null,
      };
    }
    const stream = Boolean(payload.stream);
    const model = payload.model || cfg.model || 'gemini-2.0-pro-exp-02-05';
    const { contents, system } = toGeminiContents(payload.messages || []);
    const gp = { contents };
    if (system) gp.system_instruction = { parts: [{ text: system }] };
    return { url: geminiUrl(model, stream), headers: {}, body: JSON.stringify(gp) };
  }

  return null;
}

// Native streaming chat for the bundled UI. Emits OpenAI-style SSE tokens.
async function streamChat(payload, res) {
  const provider = payload.mode === 'local' ? 'ollama' : (cfg.aiProvider || 'ollama');
  // Cloud mode is a clean-room boundary: only the current user message may
  // leave the Capsule. Local history, project excerpts, prompts, and tool
  // output are discarded server-side even if a browser misbehaves.
  const incomingMessages = payload.messages || [];
  const messages = payload.mode === 'cloud'
    ? incomingMessages.filter((m) => m && m.role === 'user').slice(-1)
    : incomingMessages;

  if (provider === 'ollama' && modelUnloadActive) {
    return sendJSON(res, 409, { error: 'A model memory operation is running. Try again in a moment.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...CORS,
  });
  const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  const finish = (fullText) => { sendSSE({ type: 'done', fullText }); res.end(); };
  const fail = (msg) => { sendSSE({ type: 'error', content: msg }); res.end(); };

  if (provider === 'anthropic') {
    const model = payload.model || cfg.model || 'claude-3-5-sonnet-20241022';
    const { system, filtered } = toAnthropicMessages(messages);
    const body = JSON.stringify({
      model,
      messages: filtered,
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.anthropicApiKey || '',
      'anthropic-version': '2023-06-01',
    };
    let fullText = '';
    try {
      const r = await fetch(anthropicBase() + '/messages', { method: 'POST', headers, body });
      if (!r.ok) return fail('Anthropic HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
      const text = await r.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          const delta = parsed.delta?.text || '';
          if (parsed.type === 'error') return fail(parsed.error?.message || 'Anthropic stream error');
          if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
        } catch {}
      }
      return finish(fullText);
    } catch (e) { return fail(e.message); }
  }

  if (provider === 'gemini') {
    const model = payload.model || cfg.model || 'gemini-2.0-pro-exp-02-05';
    const { contents, system } = toGeminiContents(messages);
    const body = JSON.stringify({ contents, ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}) });
    const headers = { 'Content-Type': 'application/json' };
    let fullText = '';
    try {
      const r = await fetch(geminiUrl(model, true), { method: 'POST', headers, body });
      if (!r.ok) return fail('Gemini HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
      const chunks = await r.text();
      // Gemini SSE: each data line is a JSON object; text lives in candidates[].content.parts[].text
      for (const line of chunks.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6).trim());
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const prt of parts) {
            if (prt.text) { fullText += prt.text; sendSSE({ type: 'delta', content: prt.text }); }
          }
        } catch {}
      }
      return finish(fullText);
    } catch (e) { return fail(e.message); }
  }

  // OpenAI-compatible: OpenAI / OpenRouter / Ollama / LM Studio / custom API.
  const baseUrl = provider === 'ollama'
    ? cfg.ollamaUrl
    : openaiBase();
  const apiKey = provider === 'ollama' ? (process.env.OLLAMA_API_KEY || '') : cfg.openaiApiKey;
  const model = payload.model || cfg.model || '';
  const body = JSON.stringify({ model, messages, stream: true });
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}),
  };
  if (baseUrl.includes('openrouter')) {
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'Local AI Chat';
  }
  let fullText = '';
  const releaseGeneration = provider === 'ollama' ? beginOllamaGeneration(model) : () => {};
  const upstreamController = provider === 'ollama' ? new AbortController() : null;
  const abortUpstream = () => upstreamController?.abort();
  if (upstreamController) res.once('close', abortUpstream);
  try {
    const chatPath = provider === 'ollama' ? '/v1/chat/completions' : '/chat/completions';
    const r = await fetch(baseUrl + chatPath, {
      method: 'POST', headers, body,
      ...(upstreamController ? { signal: upstreamController.signal } : {}),
    });
    if (!r.ok) return fail('Upstream HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consumeLine = (line) => {
      if (!line.startsWith('data: ')) return;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
      } catch {}
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    if (buffer) consumeLine(buffer);
    return finish(fullText);
  } catch (e) { return fail(e.message); }
  finally {
    if (upstreamController) res.off('close', abortUpstream);
    releaseGeneration();
  }
}

// ------------------------------------------------------- tunnel support
function bundledBin() {
  return join(DATA_DIR, 'bin', isWin() ? 'cloudflared.exe' : 'cloudflared');
}

function spawnCloudflared() {
  const found = cfg.cloudflaredPath || findOnPath('cloudflared') || (existsSync(bundledBin()) ? bundledBin() : '');
  if (!found) return null;
  const args = ['tunnel', '--url', 'http://localhost:' + cfg.port, '--no-autoupdate'];
  const child = spawn(found, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => {
    const line = d.toString();
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { remoteTunnel.url = m[0]; console.log('\n  🌍 Public URL: ' + m[0] + '\n'); }
    process.stdout.write(line);
  });
  child.stderr.on('data', (d) => { const line = d.toString(); const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) remoteTunnel.url = m[0]; process.stderr.write(line); });
  child.on('error', (e) => log('cloudflared error:', e.message));
  child.on('exit', (c) => {
    if (remoteTunnel.child === child) stopRemote('ended');
    log('cloudflared exited with code', c);
  });
  remoteTunnel.child = child;
  return child;
}

async function downloadCloudflared() {
  const cwd = join(DATA_DIR, 'bin');
  mkdirSync(cwd, { recursive: true });
  let asset;
  if (isWin()) asset = 'cloudflared-windows-amd64.exe';
  else if (process.platform === 'darwin')
    asset = process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  else asset = process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';

  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset;
  const dest = bundledBin();
  const downloadTmp = dest + '.download-' + process.pid + '-' + randomBytes(6).toString('hex');
  const executableTmp = process.platform === 'darwin' ? downloadTmp + '.executable' : downloadTmp;
  console.log('  ⬇  Downloading Cloudflare tunnel binary (' + asset + ') …');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(downloadTmp));
    if (process.platform === 'darwin') {
      const extractDir = downloadTmp + '.dir';
      mkdirSync(extractDir, { recursive: true });
      try {
        execSync('tar -xzf "' + downloadTmp + '" -C "' + extractDir + '"');
        copyFileSync(join(extractDir, 'cloudflared'), executableTmp);
      } finally {
        try { unlinkSync(join(extractDir, 'cloudflared')); } catch {}
        try { rmdirSync(extractDir); } catch {}
      }
    }
    if (!isWin()) chmodSync(executableTmp, 0o755);
    renameSync(executableTmp, dest);
  } finally {
    try { existsSync(downloadTmp) && unlinkSync(downloadTmp); } catch {}
    if (executableTmp !== downloadTmp) {
      try { existsSync(executableTmp) && unlinkSync(executableTmp); } catch {}
    }
  }
  console.log('  ✅  Saved to ' + dest);
  return dest;
}

// Resolve a model download spec into a list of files to fetch. Accepts:
//   - a direct URL (filename taken from the URL path, must end in .gguf)
//   - a HuggingFace repo id `owner/repo` (streams main-branch file tree)
//   - a HuggingFace file path `owner/repo/file.gguf`
// For a `owner/repo` spec, we prefer a single non-sharded .gguf; if the repo
// only contains shards, we download ALL shards of one base quantization.
// Returns { files: [{ url, filename }], base } where `base` is the model name
// (shard suffix stripped) and `files` is in shard order.
function safeGgufFilename(value) {
  const name = decodeURIComponent(String(value || ''));
  if (!name || basename(name) !== name || /[\\/\0\r\n]/.test(name) || !/\.gguf$/i.test(name)) {
    throw new Error('Model downloads must use a safe .gguf filename');
  }
  return name;
}

async function resolveModelDownload(spec) {
  spec = (spec || '').trim();
  if (/^https?:\/\//i.test(spec)) {
    const parsed = new URL(spec);
    const name = safeGgufFilename(parsed.pathname.split('/').pop() || '');
    return { files: [{ url: spec, filename: name }], base: name.replace(/\.gguf$/i, '') };
  }
  const parts = spec.split('/');
  if (parts.length < 2) throw new Error('Expected a URL or "owner/repo" HuggingFace id');
  if (![parts[0], parts[1]].every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part) && part !== '.' && part !== '..')) throw new Error('Invalid HuggingFace repository id');
  const repo = parts[0] + '/' + parts[1];

  const toItem = (path) => ({
    filename: safeGgufFilename(path.split('/').pop()),
    url: 'https://huggingface.co/' + repo + '/resolve/main/' + encodeURIComponent(path),
    path,
  });

  // Explicit file path e.g. `owner/repo/sub/file.gguf`
  if (parts.length > 2) {
    const rel = parts.slice(2).join('/');
    if (!/\.gguf$/i.test(rel)) throw new Error('HuggingFace file must be a .gguf file');
    const item = toItem(rel);
    return { files: [item], base: item.filename.replace(/\.gguf$/i, '') };
  }

  // Repo id — resolve the .gguf file(s) from the tree.
  const r = await fetch('https://huggingface.co/api/models/' + repo + '/tree/main');
  if (!r.ok) throw new Error('HF repo not found: HTTP ' + r.status);
  const files = await r.json();
  const ggufs = files.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path));
  if (!ggufs.length) throw new Error('No .gguf files found in repo ' + repo);

  const nonSharded = ggufs.filter((f) => !/-of-\d{5}\.gguf$/i.test(f.path));
  if (nonSharded.length) {
    const item = toItem(nonSharded[0].path);
    return { files: [item], base: item.filename.replace(/\.gguf$/i, '') };
  }

  // All sharded: pick the first shard's base and download the full set.
  const SHARD_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;
  const first = ggufs[0].path;
  const m = first.match(/(^|\/)([^/]+)-0*1-of-\d{5}\.gguf$/i);
  const base = m ? m[2] : first.split('/').pop().replace(SHARD_RE, '$1');
  const items = ggufs
    .filter((f) => f.path.includes(base))
    .map((f) => ({ ...toItem(f.path), path: f.path }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  if (!items.length) throw new Error('Could not resolve shards for ' + repo);
  return { files: items, base: base.replace(/\.gguf$/i, '') };
}

async function downloadModel(spec, onProgress) {
  const { files, base } = await resolveModelDownload(spec);
  const filenames = [];
  let grandTotal = 0;
  let grandDone = 0;

  console.log('  ⬇  Downloading model ' + base + ' …');

  for (const item of files) {
    const dest = join(MODELS_DIR, item.filename);
    const tmp = dest + '.part';
    console.log('     ' + item.url);

    let partialBytes = 0;
    try { partialBytes = statSync(tmp).size; } catch {}
    const headers = partialBytes ? { Range: `bytes=${partialBytes}-` } : {};
    const r = await fetch(item.url, { redirect: 'follow', headers });
    if (!r.ok || !r.body) throw new Error('Download failed: HTTP ' + r.status + ' for ' + item.filename);
    const resumed = partialBytes > 0 && r.status === 206;
    if (!resumed) partialBytes = 0;
    const contentLength = parseInt(r.headers.get('content-length') || '0', 10);
    const contentRangeTotal = Number((r.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1] || 0);
    const total = contentRangeTotal || (contentLength ? partialBytes + contentLength : 0);
    const reserveBytes = 512 * 1024 ** 2;
    const initialStorage = storageProfileAt(MODELS_DIR);
    if (!initialStorage.space_known) throw new Error('Could not measure free space in the GGUF import folder');
    const initialRemaining = total ? Math.max(0, total - partialBytes) : 0;
    if (initialStorage.free_bytes < initialRemaining + reserveBytes) throw new Error('Not enough free space for this GGUF download and working space');
    if (initialStorage.large_file_limit_bytes && total > initialStorage.large_file_limit_bytes) {
      throw new Error('This GGUF is larger than FAT32 can store. Use exFAT, NTFS, APFS, or ext4.');
    }
    grandTotal += total;
    grandDone += partialBytes;
    let downloaded = partialBytes;

    const meter = new Transform({
      transform(chunk, encoding, callback) {
        try {
          const chunkBytes = chunk.length;
          const storageNow = storageProfileAt(MODELS_DIR);
          if (!storageNow.space_known) throw new Error('Could not recheck free space in the GGUF import folder');
          const remainingIncludingChunk = total ? Math.max(0, total - downloaded) : chunkBytes;
          if (storageNow.free_bytes < remainingIncludingChunk + reserveBytes) throw new Error('The GGUF download reached the portable drive’s free-space reserve. Free space, then retry to resume.');
          if (storageNow.large_file_limit_bytes && downloaded + chunkBytes > storageNow.large_file_limit_bytes) {
            throw new Error('This GGUF is larger than FAT32 can store. Use exFAT, NTFS, APFS, or ext4.');
          }
          downloaded += chunkBytes;
          grandDone += chunkBytes;
          if (onProgress) onProgress({ downloaded: grandDone, total: grandTotal || 0, filename: item.filename });
          callback(null, chunk);
        } catch (error) { callback(error); }
      },
    });
    try {
      await pipeline(Readable.fromWeb(r.body), meter, createWriteStream(tmp, { flags: resumed ? 'a' : 'w' }));
    } catch (error) { throw new Error('Could not save ' + item.filename + ': ' + error.message); }
    if (total > 0 && downloaded < total) throw new Error('Download incomplete: ' + downloaded + '/' + total + ' bytes. Retry to resume it.');
    try { renameSync(tmp, dest); } catch (e) { throw new Error('Could not finalize download: ' + e.message); }
    filenames.push(item.filename);
    console.log('  ✅  Saved ' + item.filename + ' (' + (downloaded / 1e9).toFixed(2) + ' GB)');
  }

  return { base, filenames };
}

async function startTunnel() {
  if (remoteTunnel.child) return remoteTunnel.child;
  if (tunnelStartPromise) return tunnelStartPromise;
  tunnelStartPromise = (async () => {
    const existing = spawnCloudflared();
    if (existing) return existing;
    console.log('\n  ⚠  cloudflared not found — starting LOCAL while downloading it…');
    try {
      cfg.cloudflaredPath = await downloadCloudflared();
      return spawnCloudflared();
    } catch (e) {
      console.log('  ⚠  Could not download cloudflared: ' + e.message);
      console.log('     Install it, then run:  npm run tunnel');
      return null;
    }
  })();
  try {
    return await tunnelStartPromise;
  } finally {
    tunnelStartPromise = null;
  }
}

// ------------------------------------------------------------------ bootstrap
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('Request error:', e);
    try { sendJSON(res, 500, { error: e.message }); } catch {}
  });
});

server.on('error', (e) => {
  log('Server error:', e.message);
  process.exitCode = 1;
});

server.listen(cfg.port, cfg.host, async () => {
  console.log('\n  ⚡ Local AI Chat  ·  OpenAI-compatible server');
  console.log('  ───────────────────────────────────────────────');
  console.log('  Chat UI         : http://localhost:' + cfg.port);
  console.log('  OpenAI base URL : http://localhost:' + cfg.port + '/v1');
  console.log('  Provider        : ' + (cfg.aiProvider || 'ollama'));
  console.log('  Backend         : ' + (isCloudProvider() ? openaiBase() : cfg.ollamaUrl));
  console.log('  Mode            : ' + cfg.mode + (cfg.authToken ? '  (auth token enabled)' : ''));
  console.log('  Models folder   : ' + MODELS_DIR);
  if (cfg.mode === 'tunnel') await startTunnel();
  // Auto-register any .gguf files dropped into the models folder (local providers).
  if (!isCloudProvider()) {
    try { await autoRegisterLocalModels(); } catch (e) { log('Local model auto-register error:', e); }
  }
  console.log('  Press Ctrl+C to stop\n');
});
