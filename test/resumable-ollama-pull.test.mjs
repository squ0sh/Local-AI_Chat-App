import test from 'node:test';
import assert from 'node:assert/strict';
import { pullOllamaModel } from '../lib/resumable-ollama-pull.mjs';

function ndjsonResponse(lines, { leaveOpen = false, interval = 0 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
        if (interval) await new Promise((resolve) => setTimeout(resolve, interval));
      }
      if (!leaveOpen) controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('a stalled Ollama pull reconnects and keeps cumulative progress', async () => {
  let calls = 0;
  const updates = [];
  const reconnects = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return ndjsonResponse([
        { status: 'pulling layer', digest: 'sha256:test', total: 100, completed: 30 },
        { status: 'pulling layer', digest: 'sha256:test', total: 100, completed: 30 },
      ], { leaveOpen: true, interval: 5 });
    }
    return ndjsonResponse([
      { status: 'pulling layer', digest: 'sha256:test', total: 100, completed: 30 },
      { status: 'pulling layer', digest: 'sha256:test', total: 100, completed: 100 },
      { status: 'success' },
    ]);
  };

  const result = await pullOllamaModel({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'example:test',
    fetchImpl,
    stallMs: 30,
    idleMs: 100,
    retryDelayMs: 1,
    onUpdate: (update) => updates.push(update.completed || 0),
    onReconnect: (event) => reconnects.push(event.reconnects),
  });

  assert.equal(calls, 2);
  assert.deepEqual(reconnects, [1]);
  assert.equal(Math.max(...updates), 100);
  assert.equal(result.sawSuccess, true);
  assert.equal(result.reconnects, 1);
});

test('user cancellation does not reconnect', async () => {
  const controller = new AbortController();
  let reconnects = 0;
  const fetchImpl = async () => {
    queueMicrotask(() => controller.abort());
    return ndjsonResponse([
      { status: 'pulling layer', digest: 'sha256:test', total: 100, completed: 1 },
    ], { leaveOpen: true });
  };

  await assert.rejects(
    pullOllamaModel({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'example:test',
      signal: controller.signal,
      fetchImpl,
      stallMs: 20,
      retryDelayMs: 1,
      onReconnect: () => { reconnects += 1; },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(reconnects, 0);
});
