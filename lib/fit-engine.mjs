/**
 * Fit engine — the Capsule's own settings.
 *
 * Measures this machine's speed with a small dependency-free benchmark,
 * normalizes it against a reference desktop (the development machine, an
 * Intel Core i5-3570 on single-channel DDR3-1600 = 1.0×), and maps a single
 * Fit level (frugal / balanced / max) to coherent choices: which local model
 * to run, how big generated images can be, which voice engine to prefer, and
 * how many CPU threads to hand to the image engine.
 *
 * The clever part is that the estimate is self-correcting: every real image
 * job (minutes per megapixel) and every real Ollama stream (tokens per
 * second) is observed, blended into a bounded history, and used ahead of the
 * static prediction from then on. Everything is pure JS over the `os` and
 * `path` modules, so the same code behaves on Linux, Windows, and macOS,
 * x64 and arm64 — no native dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// ── Reference calibration ───────────────────────────────────────────────────
// Reference = the machine used to build this (i5-3570 @ 3.4 GHz, 4 threads,
// single-channel DDR3). Constants are tuned so that machine reports ≈1.0×.
// They are deliberately static so results are comparable across machines.
const REF_ALU_MS = 208;   // time for one ALU round on the reference
const REF_MEM_MS = 58;    // time for one memory round on the reference
const MEM_ROUND_BYTES = 64 * 1024 * 1024;   // read 32 MB + write 32 MB per round
export const REF_MPIX_PER_MIN = 0.0175;     // 512×512 (0.26 MP) ≈ 15 min on ref
export const REF_TOK_PER_S_AT_1GB = 30;     // ~6 tok/s for a 4.9 GB 8B Q4 on ref

// ── Fit levels ──────────────────────────────────────────────────────────────
// Each level is one knob that produces a whole bundle of coherent choices.
export const FIT_LEVELS = {
  frugal: {
    label: 'Frugal',
    summary: 'Smallest footprint — light voice, smaller images, faster replies.',
    max_model_gb: 7,
    interactive_floor: 5,
    image_default: 384, image_max: 512, image_hires: false,
    tts: 'piper', threads_to_cpu: 0.75, research: 'quick',
  },
  balanced: {
    label: 'Balanced',
    summary: 'Best everyday mix of speed, size, and quality.',
    max_model_gb: 12,
    interactive_floor: 7,
    image_default: 512, image_max: 1024, image_hires: true,
    tts: 'kokoro', threads_to_cpu: 0.75, research: 'both',
  },
  max: {
    label: 'Max',
    summary: 'The strongest model this computer can hold — slower, but more capable.',
    max_model_gb: 24,
    interactive_floor: 10,
    image_default: 512, image_max: 1024, image_hires: true,
    tts: 'kokoro', threads_to_cpu: 1, research: 'both',
  },
};
export const FIT_LEVEL_IDS = Object.keys(FIT_LEVELS);

const FIT_STATE_FILE = 'fit-state.json';
const OBSERVATION_CAP = 12;

const hrtimeMs = () => performance.now();

// ── Micro-benchmark (pure JS, no native deps) ───────────────────────────────
// Two rounds: integer dependency-chain (ALU throughput) and a sequential
// read+write pass over a 32 MB buffer (memory bandwidth). Best-of-3 timings
// resist scheduler noise and turbo ramping.
export function runMicroBenchmark({ rounds = 3, aluOps = 24_000_000, memBytes = 32 * 1024 * 1024 } = {}) {
  let bestAluMs = Infinity, bestMemMs = Infinity;
  for (let round = 0; round < rounds; round += 1) {
    let x = 123456789 | 0;
    const t0 = hrtimeMs();
    for (let i = 0; i < aluOps; i += 1) {
      x = (x + (i * 2654435761) | 0) | 0;
      x = (x ^ (x >>> 16)) | 0;
      x = (x * 2246822519) | 0;
    }
    const aluMs = hrtimeMs() - t0;
    if (aluMs < bestAluMs) bestAluMs = aluMs;

    const buf = new Float64Array(memBytes >> 3);
    let acc = x;
    const t1 = hrtimeMs();
    for (let p = 0; p < memBytes * 2 / (buf.length * 8); p += 1) {
      let s = 0;
      for (let i = 0; i < buf.length; i += 1) s += buf[i];
      for (let i = 0; i < buf.length; i += 1) buf[i] = s;
      acc = (acc + s) | 0;
    }
    const memMs = hrtimeMs() - t1;
    if (memMs < bestMemMs) bestMemMs = memMs;
  }
  const memBandMbps = (memBytes * 2 * 2) / (bestMemMs / 1000) / (1024 * 1024);
  const aluScore = REF_ALU_MS / bestAluMs;
  const memScore = REF_MEM_MS / bestMemMs;
  return {
    score: 0.6 * aluScore + 0.4 * memScore,
    aluScore,
    memScore,
    memBandMbps,
    bestAluMs,
    bestMemMs,
  };
}

// ── Fit state persistence (tamper-safe parse, fail-soft) ────────────────────
const DEFAULT_STATE = () => ({
  level: 'balanced',
  benchmark: null,
  observed: { tokens_per_sec: [], minutes_per_mpix: [] },
});

export function loadFitState(dataDir) {
  const fallback = DEFAULT_STATE();
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FIT_STATE_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object') return fallback;
    const state = DEFAULT_STATE();
    if (typeof raw.level === 'string' && FIT_LEVEL_IDS.includes(raw.level)) state.level = raw.level;
    if (raw.benchmark && typeof raw.benchmark === 'object' && Number.isFinite(raw.benchmark.score)) {
      state.benchmark = {
        score: Number(raw.benchmark.score),
        aluScore: Number(raw.benchmark.aluScore) || raw.benchmark.score,
        memScore: Number(raw.benchmark.memScore) || raw.benchmark.score,
        memBandMbps: Number(raw.benchmark.memBandMbps) || 0,
        generated_at: Number(raw.benchmark.generated_at) || Date.now(),
      };
    }
    for (const kind of ['tokens_per_sec', 'minutes_per_mpix']) {
      const list = raw.observed?.[kind];
      if (Array.isArray(list)) {
        state.observed[kind] = list
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0)
          .slice(-OBSERVATION_CAP);
      }
    }
    return state;
  } catch {
    return fallback;
  }
}

export function saveFitState(dataDir, state) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, FIT_STATE_FILE),
      JSON.stringify(state, null, 2) + '\n',
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

// Records a real-use measurement (tokens_per_sec or minutes_per_mpix) into a
// bounded history. Returns a new state object (the caller persists it).
export function recordObservation(state, kind, value) {
  const next = {
    ...state,
    observed: {
      tokens_per_sec: [...state.observed.tokens_per_sec],
      minutes_per_mpix: [...state.observed.minutes_per_mpix],
    },
  };
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return next;
  const valid = (kind === 'tokens_per_sec' && numeric <= 100_000)
    || (kind === 'minutes_per_mpix' && numeric <= 10_000);
  if (!valid) return next;
  const bucket = next.observed[kind] || [];
  bucket.push(Number(numeric.toFixed(4)));
  if (bucket.length > OBSERVATION_CAP) bucket.splice(0, bucket.length - OBSERVATION_CAP);
  next.observed[kind] = bucket;
  return next;
}

const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ── Estimation ──────────────────────────────────────────────────────────────
// Predictions are calibrated to the reference machine and blended with real
// observations so they drift toward this machine's actual behavior.

function modelTokensPerSec(memScore, modelGb, observed) {
  const predicted = (REF_TOK_PER_S_AT_1GB * memScore) / Math.max(0.2, modelGb);
  const observedMedian = median(observed.tokens_per_sec);
  if (observedMedian == null) return predicted;
  // Observed is measured on the real target model, so weight it heavily.
  return observedMedian * 0.7 + predicted * 0.3;
}

export function imageMinutesPerMpix(memScore, observed) {
  const observedMedian = median(observed.minutes_per_mpix);
  if (observedMedian != null) return observedMedian;
  return 1 / (REF_MPIX_PER_MIN * Math.max(0.1, memScore));
}

const mpOfPixels = (px) => (px * px) / 1_000_000;

// ── Recommendation ──────────────────────────────────────────────────────────
// Choose the most capable curated preset that (a) fits available memory with
// headroom and (b) is predicted to stay above the level's interactive floor.
// If nothing clears the floor, the smallest memory-fit preset is offered with
// a below_interactive flag rather than nothing at all.
export function recommendFit({ presets, memFreeGb, memScore, score, cores = 4, state }) {
  const level = FIT_LEVELS[state.level] || FIT_LEVELS.balanced;
  const headroom = Math.max(1, memFreeGb * 0.4);
  const fits = presets.filter((p) => !p.memory_gb || p.memory_gb <= memFreeGb - headroom || p.id === 'portable');
  const sorted = [...fits].sort((a, b) => (b.memory_gb || 0) - (a.memory_gb || 0));
  let model = null;
  let modelFitsMemory = false;
  for (const preset of sorted) {
    if (preset.memory_gb > level.max_model_gb) continue;
    const tokPerSec = modelTokensPerSec(memScore, preset.memory_gb || preset.download_gb, state.observed);
    if (tokPerSec >= level.interactive_floor) { model = pickModel(preset, tokPerSec); modelFitsMemory = true; break; }
    if (!model) { model = pickModel(preset, tokPerSec); modelFitsMemory = true; }
  }
  if (!model) {
    model = presets[0] ? pickModel(presets[0], modelTokensPerSec(memScore, presets[0].memory_gb || presets[0].download_gb, state.observed)) : null;
  }
  const threads = Math.max(1, Math.min(8, Math.round(cores * level.threads_to_cpu)));
  const imageBase = imageMinutesPerMpix(memScore, state.observed);
  return {
    level: state.level,
    level_label: level.label,
    level_summary: level.summary,
    below_interactive: Boolean(model && model.predicted_tokens_per_sec < level.interactive_floor),
    model_fits_memory: modelFitsMemory,
    scored_at: Date.now(),
    model,
    image: {
      default: level.image_default,
      max: level.image_max,
      hires: level.image_hires,
      minutes: {
        256: Math.round(imageBase * mpOfPixels(256) * 10) / 10,
        384: Math.round(imageBase * mpOfPixels(384) * 10) / 10,
        512: Math.round(imageBase * mpOfPixels(512) * 10) / 10,
        1024: Math.round(imageBase * mpOfPixels(1024) * 10) / 10,
      },
    },
    research_minutes: Math.round((level.research === 'both' ? 14 : 9) * (1 / Math.max(0.2, score)) * 10) / 10,
    tts: memFreeGb >= 6 ? level.tts : 'piper',
    threads,
    score,
    observed: {
      tokens_per_sec: median(state.observed.tokens_per_sec),
      minutes_per_mpix: median(state.observed.minutes_per_mpix),
    },
  };
}

function pickModel(preset, predictedTokensPerSec) {
  return {
    id: preset.id,
    name: preset.name,
    model: preset.model,
    estimated_gb: preset.memory_gb || preset.download_gb || 0,
    predicted_tokens_per_sec: Math.round(predictedTokensPerSec * 10) / 10,
  };
}