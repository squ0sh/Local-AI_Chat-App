import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFreeMemory, otherModelNames } from '../lib/memory.mjs';

const GiB = 2 ** 30;

test('shouldFreeMemory: true when another model is resident and RAM is tight', () => {
  const loaded = [{ name: 'other:latest', size: 2 * GiB }];
  assert.equal(shouldFreeMemory(loaded, 'target:q4_k_m', { totalmem: 8 * GiB, freemem: 1.5 * GiB }), true);
});

test('shouldFreeMemory: false when the requested model is already loaded', () => {
  const loaded = [{ name: 'target:latest', size: 2 * GiB }];
  assert.equal(shouldFreeMemory(loaded, 'target', { totalmem: 8 * GiB, freemem: 1.5 * GiB }), false);
});

test('shouldFreeMemory: false when nothing is loaded', () => {
  assert.equal(shouldFreeMemory([], 'target', { totalmem: 8 * GiB, freemem: 8 * GiB }), false);
});

test('shouldFreeMemory: false when there is enough headroom despite another model', () => {
  const loaded = [{ name: 'other', size: 1 * GiB }];
  assert.equal(shouldFreeMemory(loaded, 'target', { totalmem: 16 * GiB, freemem: 13 * GiB }), false);
});

test('shouldFreeMemory: false when mem stats are missing', () => {
  const loaded = [{ name: 'other', size: 2 * GiB }];
  assert.equal(shouldFreeMemory(loaded, 'target', {}), false);
});

test('otherModelNames excludes the requested model and keeps the rest', () => {
  const loaded = [
    { name: 'hf.co/user/Qwen:q4_k_m', size: 1 * GiB },
    { name: 'llama-3b:latest', size: 2 * GiB },
  ];
  assert.deepEqual(otherModelNames(loaded, 'hf.co/user/Qwen'), ['llama-3b:latest']);
  assert.deepEqual(otherModelNames(loaded, 'anything'), loaded.map((m) => m.name));
});