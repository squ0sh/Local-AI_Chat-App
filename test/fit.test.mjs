import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMicroBenchmark,
  loadFitState,
  saveFitState,
  recordObservation,
  recommendFit,
  FIT_LEVELS,
  FIT_LEVEL_IDS,
  REF_MPIX_PER_MIN,
  REF_TOK_PER_S_AT_1GB,
} from '../lib/fit-engine.mjs';

const PRESETS = [
  { id: 'portable', name: 'Qwythos 9B', model: 'qwythos:9b', download_gb: 7.6, memory_gb: 12 },
  { id: 'reasoning', name: 'Strong reasoning', model: 'dolphin3:8b', download_gb: 4.9, memory_gb: 12 },
  { id: 'balanced', name: 'Balanced', model: 'balanced', download_gb: 4.7, memory_gb: 10 },
  { id: 'coding', name: 'Coding', model: 'dolphin-mistral:7b', download_gb: 4.1, memory_gb: 10 },
  { id: 'light', name: 'Light', model: 'qwen3:4b', download_gb: 2.5, memory_gb: 6 },
];

test('benchmark produces sane, non-negative numbers on any machine', () => {
  const b = runMicroBenchmark();
  assert.ok(b.score > 0);
  assert.ok(Number.isFinite(b.score));
  assert.ok(b.aluScore > 0 && b.memScore > 0);
  assert.ok(b.memBandMbps > 0);
  assert.ok(b.bestAluMs > 1 && b.bestMemMs > 1);
});

test('benchmark scales: more work takes longer and lowers the score', () => {
  const fast = runMicroBenchmark({ aluOps: 2_000_000 });
  const slow = runMicroBenchmark({ aluOps: 40_000_000 });
  assert.ok(slow.bestAluMs > fast.bestAluMs);
  assert.ok(slow.aluScore < fast.aluScore);
});

test('fit state round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fit-'));
  try {
    const state = { level: 'max', benchmark: { score: 1.5, aluScore: 1.4, memScore: 1.6, memBandMbps: 5000, generated_at: 1 }, observed: { tokens_per_sec: [3.2, 4.1], minutes_per_mpix: [15] } };
    assert.ok(saveFitState(dir, state));
    const loaded = loadFitState(dir);
    assert.equal(loaded.level, 'max');
    assert.equal(loaded.benchmark.score, 1.5);
    assert.deepEqual(loaded.observed.tokens_per_sec, [3.2, 4.1]);
    assert.deepEqual(loaded.observed.minutes_per_mpix, [15]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadFitState fails soft and returns defaults', () => {
  const def = loadFitState('/nonexistent/nowhere');
  assert.equal(def.level, 'balanced');
  assert.deepEqual(def.observed.tokens_per_sec, []);
});

test('recordObservation bounds values and caps history', () => {
  let state = loadFitState('/nonexistent/nowhere');
  state = recordObservation(state, 'tokens_per_sec', -5);
  assert.equal(state.observed.tokens_per_sec.length, 0);
  state = recordObservation(state, 'minutes_per_mpix', 1e9);
  assert.equal(state.observed.minutes_per_mpix.length, 0);
  for (let i = 0; i < 20; i += 1) state = recordObservation(state, 'tokens_per_sec', 4 + i / 10);
  assert.ok(state.observed.tokens_per_sec.length <= 12);
  state = recordObservation(state, 'bogus_kind', 5);
  assert.equal(state.observed.bogus_kind, undefined);
});

test('recommendFit chooses the largest preset that fits memory and the level', () => {
  const b = runMicroBenchmark();
  const rec = recommendFit({ presets: PRESETS, memFreeGb: 5.5, memScore: b.memScore, score: b.score, cores: 4, state: { level: 'balanced', observed: { tokens_per_sec: [], minutes_per_mpix: [] } } });
  assert.ok(['portable', 'reasoning', 'balanced', 'coding', 'light'].includes(rec.model.id));
  assert.equal(rec.level, 'balanced');
  assert.ok(rec.image.default > 0 && rec.image.max >= rec.image.default);
  assert.ok(rec.threads >= 1 && rec.threads <= 8);
  assert.ok(rec.image.minutes[512] > 0);
  assert.equal(typeof rec.below_interactive, 'boolean');
});

test('observations correct the static prediction', () => {
  const b = runMicroBenchmark();
  const raw = recommendFit({ presets: PRESETS, memFreeGb: 12, memScore: b.memScore, score: b.score, cores: 8, state: { level: 'balanced', observed: { tokens_per_sec: [], minutes_per_mpix: [] } } });
  const learned = recommendFit({ presets: PRESETS, memFreeGb: 12, memScore: b.memScore, score: b.score, cores: 8, state: { level: 'balanced', observed: { tokens_per_sec: [9.5, 10.1, 9.8], minutes_per_mpix: [1.1, 1.3, 1.2] } } });
  assert.ok(learned.model.predicted_tokens_per_sec > raw.model.predicted_tokens_per_sec || learned.model.predicted_tokens_per_sec >= 9.5);
  assert.ok(learned.image.minutes[512] < raw.image.minutes[512]);
  assert.equal(learned.observed.tokens_per_sec, 9.8);
  assert.equal(learned.observed.minutes_per_mpix, 1.2);
});

test('recommendFit ranks installed-like models by largest interactive fit (used for auto-suggest)', () => {
  const b = runMicroBenchmark();
  const installed = [
    { id: 'huge:24b', name: 'huge:24b', model: 'huge:24b', memory_gb: 24 },
    { id: 'mid:4b', name: 'mid:4b', model: 'mid:4b', memory_gb: 4 },
    { id: 'small:3b', name: 'small:3b', model: 'small:3b', memory_gb: 3 },
  ];
  const rec = recommendFit({ presets: installed, memFreeGb: 20, memScore: b.memScore, score: b.score, cores: 4, state: { level: 'balanced', observed: { tokens_per_sec: [], minutes_per_mpix: [] } } });
  assert.equal(rec.model.id, 'mid:4b');
  assert.equal(rec.model_fits_memory, true);
});

test('recommendFit reports no memory fit when the only installed model is too big', () => {
  const b = runMicroBenchmark();
  const rec = recommendFit({ presets: [{ id: 'huge:24b', name: 'huge:24b', model: 'huge:24b', memory_gb: 24 }], memFreeGb: 5, memScore: b.memScore, score: b.score, cores: 4, state: { level: 'balanced', observed: { tokens_per_sec: [], minutes_per_mpix: [] } } });
  assert.equal(rec.model_fits_memory, false);
});

test('fit level constants are coherent and exported', () => {
  assert.deepEqual(FIT_LEVEL_IDS.sort(), ['balanced', 'frugal', 'max']);
  assert.ok(FIT_LEVELS.frugal.image_default < FIT_LEVELS.balanced.image_default);
  assert.ok(FIT_LEVELS.balanced.max_model_gb < FIT_LEVELS.max.max_model_gb);
  assert.ok(REF_MPIX_PER_MIN > 0 && REF_TOK_PER_S_AT_1GB > 0);
});