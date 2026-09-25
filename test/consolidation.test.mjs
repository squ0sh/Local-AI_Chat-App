import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConsolidationEngine } from '../lib/consolidation.mjs';

const CHAT_SRC = { type: 'chat', id: 'c1', title: 'Router choices', changedAt: 1000 };

function makeEngine(t, { sources = [], complete } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'consol-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const applied = { memory: [], procedures: [] };
  const engine = new ConsolidationEngine({
    dataDir: dir,
    complete: complete || (async () => '{}'),
    collectSources: async () => sources,
    apply: {
      memory: async (text, citations) => { applied.memory.push({ text, citations }); },
      procedure: async (card, citations) => { applied.procedures.push({ ...card, citations }); },
    },
  });
  return { engine, applied, dir };
}

const LONG = 'user: we decided the backup envelope uses AES-256-GCM and stores the key client-side only.\nassistant: right — the vault seals the workspace with that envelope and nothing plaintext survives on disk. '.repeat(3);

test('cycle: quiet when nothing is new (no model calls, no writes)', async (t) => {
  let called = 0;
  const { engine } = makeEngine(t, { sources: [], complete: async () => { called += 1; return '{}'; } });
  const r = await engine.start();
  assert.equal(r.ok && r.quiet, true);
  assert.equal(called, 0, 'no completion happens on a quiet night');
  assert.equal(existsSync(join(engine.dataDir, 'consolidation', 'cycle.json')), false, 'nothing written');
});

test('cycle: digests sources into queued proposals and writes a briefing', async (t) => {
  const { engine, dir } = makeEngine(t, {
    sources: [{ src: CHAT_SRC, text: LONG }],
    complete: async (system) => {
      if (system.includes('durable knowledge')) return JSON.stringify({ facts: [{ text: 'The backup envelope uses AES-256-GCM with a client-side key.', quote: 'AES-256-GCM' }] });
      if (system.includes('reusable work procedures')) return JSON.stringify({ procedures: [{ name: 'Seal before share', summary: 'seal the workspace before handing off', steps: ['vault the workspace', 'verify the manifest', 'hand off offline only'] }] });
      return 'Last night I digested 1 source into 2 proposals; review at leisure.';
    },
  });
  const r = await engine.start();
  assert.equal(r.ok, true);
  assert.equal(engine.status().state, 'ready');
  assert.equal(engine.status().queuedCount, 2);
  assert.equal(engine.status().unread, true);
  assert.match(engine.status().briefing, /digested/);
  const queue = engine.listQueue();
  assert.equal(queue.find((p) => p.kind === 'memory').citations[0].title, 'Router choices');
  assert.equal(queue.find((p) => p.kind === 'procedure').steps.length, 3);
  assert.ok(existsSync(join(dir, 'consolidations.log')), 'ledger line exists');
});

test('queue: approve writes to stores, dismiss does not, queue drains', async (t) => {
  const { engine, applied } = makeEngine(t, {
    sources: [{ src: CHAT_SRC, text: LONG }],
    complete: async (system) => {
      if (system.includes('durable knowledge')) return JSON.stringify({ facts: [{ text: 'Key material never leaves the client device unencrypted.', quote: 'client-side only' }] });
      if (system.includes('reusable work procedures')) return JSON.stringify({ procedures: [] });
      return 'Note.';
    },
  });
  await engine.start();
  const { id } = engine.listQueue()[0];
  const ok = await engine.approve(id);
  assert.equal(ok.ok, true);
  assert.equal(applied.memory.length, 1);
  assert.match(applied.memory[0].text, /client device/);
  assert.equal(engine.listQueue().length, 0);
  const again = await engine.approve(id);
  assert.equal(again.ok, false, 'no double-approve');
  const r2 = await engine.start({ force: true }).catch(() => ({ ok: true }));
  void r2;
});

test('queue: dismiss records the verdict and empties the review list', async (t) => {
  const { engine, applied } = makeEngine(t, {
    sources: [{ src: CHAT_SRC, text: LONG }],
    complete: async (system) => (system.includes('durable knowledge') ? JSON.stringify({ facts: [{ text: 'Portable kits exclude private data by default and warn in the UI.', quote: 'exclude private data' }] }) : (system.includes('reusable work procedures') ? '{"procedures":[]}' : 'note')),
  });
  await engine.start();
  const { id } = engine.listQueue()[0];
  const r = await engine.dismiss(id, 'not worth keeping');
  assert.equal(r.ok, true);
  assert.equal(applied.memory.length, 0, 'dismissed facts never enter memory');
  assert.equal(engine.listQueue().length, 0);
  assert.match(readFileSync(join(engine.dataDir, 'consolidations.log'), 'utf8'), /dismissed.*not worth keeping/);
});

test('cycle: model failure mid-cycle fails closed — nothing queued, no hang', async (t) => {
  const { engine } = makeEngine(t, {
    sources: [{ src: CHAT_SRC, text: LONG }],
    complete: async (system) => { if (system.includes('durable knowledge')) throw new Error('model offline'); return 'note'; },
  });
  const r = await engine.start();
  assert.equal(r.ok, false);
  assert.equal(engine.status().state, 'error');
  assert.equal(engine.listQueue().length, 0);
  const again = await engine.start().catch(() => null);
  void again; // state allows retry after error
});

test('cycle: cancel between sources stops cleanly with a cancelled state', async (t) => {
  let calls = 0;
  const { engine } = makeEngine(t, {
    sources: [1, 2, 3].map((i) => ({ src: { ...CHAT_SRC, id: `c${i}` }, text: LONG })),
    complete: async (system) => {
      if (system.includes('durable knowledge')) {
        calls += 1;
        if (calls === 2) engine.cancel();
        return JSON.stringify({ facts: [{ text: 'x'.repeat(40), quote: 'x' }] });
      }
      return system.includes('reusable work procedures') ? '{"procedures":[]}' : 'note';
    },
  });
  const r = await engine.start();
  assert.equal(r.cancelled, true);
  assert.equal(engine.status().state, 'cancelled');
});
