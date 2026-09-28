import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../lib/agent-loop.mjs';

test('agent loop forwards streamed deltas to onToken', async () => {
  const events = [];
  const tokens = [];
  let step = 0;
  const llmCall = async (messages, tools, onToken) => {
    step += 1;
    if (step === 1) {
      onToken?.('hello ');
      onToken?.('world');
      return { content: 'hello world', tool_calls: [], tokens: 2 };
    }
    return { content: 'Final answer done.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'say hello',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    onEvent: (e) => events.push(e),
    onToken: (delta) => tokens.push(delta),
    llmCall,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'complete');
  assert.equal(tokens.join(''), 'hello world');
  assert.ok(events.some((e) => e.type === 'completed'), 'should emit completed');
  assert.equal(result.thread.at(-1)?.role, 'assistant');
  assert.equal(result.thread.at(-1)?.content, 'hello world');
});

test('agent loop cancellation settles an outstanding approval wait', async () => {
  const controller = new AbortController();
  let waiting = false;
  const resultPromise = runAgentLoop({
    task: 'write a file',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'selective',
    llmCall: async () => ({
      content: '',
      tool_calls: [{ name: 'write_file', arguments: { path: 'approval-test.txt', content: 'x' } }],
    }),
    onEvent: (event) => {
      if (event.type === 'waiting_approval') {
        waiting = true;
        controller.abort();
      }
    },
    signal: controller.signal,
  });
  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('approval wait did not settle')), 500)),
  ]);
  assert.equal(waiting, true);
  assert.equal(result.status, 'cancelled');
});

test('agent loop invokes llmCall with onToken as the third argument', async () => {
  const callArgs = [];
  const llmCall = async (...args) => { callArgs.push(args); return { content: 'ok', tool_calls: [], tokens: 1 }; };
  const onToken = () => {};
  await runAgentLoop({
    task: 'return ok',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    llmCall,
    onToken,
    signal: new AbortController().signal,
  });
  assert.equal(callArgs.length, 1);
  const [messages, tools, passedToken] = callArgs[0];
  assert.ok(Array.isArray(messages), 'messages should be an array');
  assert.ok(Array.isArray(tools), 'tools should be an array');
  assert.equal(passedToken, onToken, 'third argument must be the onToken callback');
});
