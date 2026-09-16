import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, toolsForMode } from '../lib/agent-loop.mjs';

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

test('agent loop blocks an exact repeated tool call and lets the run complete', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: '', tool_calls: [{ name: 'list_dir', arguments: { path: '.' } }], tokens: 1 };
    if (step === 2) return { content: '', tool_calls: [{ name: 'list_dir', arguments: { path: '.' } }], tokens: 1 };
    return { content: 'Done.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'list the root',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    llmCall,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'complete');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(results.length, 2, 'first call executed, repeat was blocked');
  assert.equal(results.filter((t) => t.result?.repeated).length, 1, 'one call flagged as repeated');
  assert.equal(results.filter((t) => !t.result?.repeated).length, 1, 'one call actually executed');
});

test('agent loop does not block different tool calls', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: '', tool_calls: [{ name: 'list_dir', arguments: { path: '.' } }], tokens: 1 };
    if (step === 2) return { content: '', tool_calls: [{ name: 'list_dir', arguments: { path: 'lib' } }], tokens: 1 };
    return { content: 'Done.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'list a couple of dirs',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    llmCall,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'complete');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(results.filter((t) => t.result?.repeated).length, 0, 'different calls are never treated as repeats');
});

test('toolsForMode: plan mode drops state-changing tools but keeps reads and web', () => {
  const buildTools = toolsForMode(false);
  const planTools = toolsForMode(true);
  const names = (list) => list.map((t) => t.function.name);
  assert.ok(names(buildTools).includes('write_file'), 'build offers write_file');
  assert.ok(names(buildTools).includes('run_command'));
  assert.ok(names(buildTools).includes('run_tests'));
  for (const risky of ['write_file', 'run_command', 'run_tests']) {
    assert.equal(names(planTools).includes(risky), false, `plan mode omits ${risky}`);
  }
  for (const safe of ['read_file', 'list_dir', 'search_files', 'grep_search', 'web_search', 'web_fetch']) {
    assert.ok(names(planTools).includes(safe), `plan mode keeps ${safe}`);
  }
});
