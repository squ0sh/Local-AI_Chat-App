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

test('norms_defer tool is offered in both plan and build mode', () => {
  const names = (list) => list.map((t) => t.function.name);
  assert.ok(names(toolsForMode(false)).includes('norms_defer'), 'build mode offers norms_defer');
  assert.ok(names(toolsForMode(true)).includes('norms_defer'), 'plan mode offers norms_defer');
});

test('agent loop injects binding norms into the system prompt when passed', async () => {
  let seen;
  const llmCall = async (messages) => { seen = messages; return { content: 'ok', tool_calls: [], tokens: 1 }; };
  await runAgentLoop({
    task: 'hi',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    norms: '### 5. Outward Fairness\nNever harm other people.',
    llmCall,
    signal: new AbortController().signal,
  });
  const system = seen.find((m) => m.role === 'system').content;
  assert.ok(system.includes('Binding Norms'), 'norms section is present');
  assert.ok(system.includes('Never harm other people.'), 'norms text is embedded verbatim');
  assert.ok(system.includes('norms_defer'), 'deferral instruction is present');
});

test('agent loop defers on a norms collision and honors the deferral when rejected', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: '', tool_calls: [{ name: 'norms_defer', arguments: { rule: 'Section 5 — Outward fairness', request: 'post spam' } }], tokens: 1 };
    return { content: 'I explained the deferral.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'post spam',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    norms: '# Our Norms\n\n## 5. Outward fairness\nNever harm others.',
    llmCall,
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); if (e.type === 'waiting_approval') e.resolve(false); },
  });
  assert.equal(result.status, 'complete');
  const pending = events.find((e) => e.type === 'waiting_approval');
  assert.ok(pending, 'a waiting_approval event fired');
  assert.equal(pending.kind, 'norms');
  assert.equal(pending.rule, 'Section 5 — Outward fairness');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(results.length, 1, 'no tool was executed');
  assert.equal(results[0].name, 'norms_defer');
  assert.equal(results[0].result.deferred, true);
  assert.equal(results[0].result.blocked, true);
  assert.equal(events.filter((e) => e.type === 'executing').length, 0, 'nothing was actually executed');
});

test('agent loop proceeds after a deliberate norm override', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: '', tool_calls: [{ name: 'norms_defer', arguments: { rule: 'Section 3 — Honesty' } }], tokens: 1 };
    return { content: 'Done.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'proceed anyway',
    model: 'test-model',
    workspaceRoot: '/tmp',
    autonomy: 'auto',
    norms: '### 3. Honesty\nNo flattery.',
    llmCall,
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); if (e.type === 'waiting_approval') e.resolve(true); },
  });
  assert.equal(result.status, 'complete');
  const override = events.find((e) => e.type === 'tool_result' && e.name === 'norms_defer');
  assert.ok(override, 'norms_defer result was reported');
  assert.equal(override.result.overridden, true);
  assert.equal(events.filter((e) => e.type === 'executing').length, 0, 'only the defer tool, nothing risky');
});

// ── Critic mode ───────────────────────────────────────────────────────────────

test('critic: REVISE verdict replaces the final answer with the revision', async () => {
  const events = [];
  let step = 0;
  const llmCall = async (_messages, tools, onToken) => {
    step += 1;
    if (step === 1) return { content: 'The draft answer.', tool_calls: [], tokens: 1 };
    if (step === 2) {
      assert.deepEqual(tools, [], 'critic pass is a plain completion without tools');
      onToken?.('VERDICT: REVISE\nISSUES:\n1. Missing the actual restart step.');
      return { content: '', tool_calls: [], tokens: 1 };
    }
    return { content: 'The draft answer, now with the restart step spelled out properly and fully.', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'fix the service', model: 'test-model', workspaceRoot: '/tmp', autonomy: 'auto',
    llmCall, signal: new AbortController().signal, critic: true,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.content.includes('restart step'), 'final content is the revision');
  assert.equal(result.draft, 'The draft answer.');
  assert.ok(result.critique.includes('VERDICT: REVISE'));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('critic_started') && types.includes('critic_complete') && types.includes('revision_started') && types.includes('revision_complete'));
  assert.ok(types.indexOf('critic_started') < types.indexOf('critic_complete') && types.indexOf('critic_complete') < types.indexOf('revision_started') && types.indexOf('revision_complete') < types.indexOf('completed'), 'critic cycle precedes completion');
  assert.equal(events.find((e) => e.type === 'completed').verdict, 'revised');
});

test('critic: PASS verdict ships the draft unchanged', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: 'A solid draft.', tool_calls: [], tokens: 1 };
    return { content: 'VERDICT: PASS\nISSUES:', tool_calls: [], tokens: 1 };
  };
  const result = await runAgentLoop({
    task: 'answer', model: 'test-model', workspaceRoot: '/tmp', autonomy: 'auto',
    llmCall, signal: new AbortController().signal, critic: true,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.content, 'A solid draft.');
  assert.equal(events.find((e) => e.type === 'completed').verdict, 'pass');
  assert.ok(!events.some((e) => e.type === 'revision_started'), 'no revision pass when the critic passes the draft');
});

test('critic: a broken critic never blocks the draft (fail-open)', async () => {
  const events = [];
  let step = 0;
  const llmCall = async () => {
    step += 1;
    if (step === 1) return { content: 'Draft that must ship.', tool_calls: [], tokens: 1 };
    throw new Error('model gone');
  };
  const result = await runAgentLoop({
    task: 'answer', model: 'test-model', workspaceRoot: '/tmp', autonomy: 'auto',
    llmCall, signal: new AbortController().signal, critic: true,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.content, 'Draft that must ship.');
  assert.equal(events.find((e) => e.type === 'critic_complete').verdict, 'skipped');
});

test('critic: off by default — no critic events unless requested', async () => {
  const events = [];
  const llmCall = async () => ({ content: 'plain answer', tool_calls: [], tokens: 1 });
  await runAgentLoop({
    task: 'answer', model: 'test-model', workspaceRoot: '/tmp', autonomy: 'auto',
    llmCall, signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  assert.ok(!events.some((e) => e.type.startsWith('critic') || e.type.startsWith('revision')));
});
