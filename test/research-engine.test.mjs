import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ResearchEngine, assertPublicUrl, extractPage, parseBingRss, parseDuckDuckGo, safeFetchText } from '../lib/research-engine.mjs';

test('search result and page parsers keep useful text', () => {
  const ddg = parseDuckDuckGo('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Example &amp; One</a>');
  assert.deepEqual(ddg, [{ url: 'https://example.com/one', title: 'Example & One', snippet: '' }]);
  const bing = parseBingRss('<rss><item><title>Example Two</title><link>https://example.org/two</link><description>Useful &amp; current</description></item></rss>');
  assert.deepEqual(bing, [{ title: 'Example Two', url: 'https://example.org/two', snippet: 'Useful & current' }]);
  const page = extractPage('<title>Research Page</title><nav>menu</nav><article><h1>Finding</h1><p>Evidence worth keeping.</p></article><script>ignore()</script>');
  assert.equal(page.title, 'Research Page');
  assert.match(page.text, /Evidence worth keeping/);
  assert.doesNotMatch(page.text, /ignore/);
});

test('private and loopback research targets are rejected', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/private'), /Private|local/i);
  await assert.rejects(() => assertPublicUrl('http://example.test/private', async () => [{ address: '192.168.1.9' }] ), /Private|local/i);
  await assert.doesNotReject(() => assertPublicUrl('https://example.test/page', async () => [{ address: '93.184.216.34' }]));
});

test('https sources are never downgraded to http redirects', async () => {
  const publicResolver = async () => [{ address: '93.184.216.34' }];
  const downgradeFetch = async () => new Response(null, { status: 301, headers: { location: 'http://private-target.test/steal' } });
  await assert.rejects(
    () => safeFetchText('https://example.com/page', { fetchImpl: downgradeFetch, resolveHost: publicResolver }),
    /downgrade|Refusing/,
  );
  // http→https (and http→http) upgrades remain allowed.
  const redirectFetch = async (url) => {
    if (String(url).startsWith('http:')) return new Response(null, { status: 301, headers: { location: 'https://example.com/landing' } });
    return new Response('<html><article>fine</article></html>', { headers: { 'content-type': 'text/html' } });
  };
  const result = await safeFetchText('http://example.com/start', { fetchImpl: redirectFetch, resolveHost: publicResolver });
  assert.match(result.url, /https:\/\/example\.com\/landing/);
});

test('quick research saves a report and only links collected source ids', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capsule-research-'));
  const searchHtml = ['one', 'two', 'three', 'four'].map((name) => `<a class="result__a" href="https://source.test/${name}">${name} source</a>`).join('');
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('duckduckgo.com')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    const name = new URL(url).pathname.slice(1);
    return new Response(`<html><title>${name} title</title><article>${'Relevant evidence for testing. '.repeat(30)}</article></html>`, { headers: { 'content-type': 'text/html' } });
  };
  const complete = async ({ messages }) => {
    const system = messages[0].content;
    if (system.startsWith('You plan')) return '["focused query one", "focused query two"]';
    if (system.startsWith('Extract')) return 'The collected evidence supports the finding [S1] and adds context [S2].';
    return '# Answer\n\nSupported finding [S1](https://invented.invalid). Invalid claim [S99]. [Made up](https://invented.invalid).';
  };
  const engine = new ResearchEngine({ dataDir: directory, complete, fetchImpl, resolveHost: async () => [{ address: '93.184.216.34' }] });
  try {
    const started = engine.start({ query: 'What does the evidence show?', model: 'test-model', mode: 'quick' });
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = engine.get(started.id, true);
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result.status, 'complete');
    assert.equal(result.sources_count, 4);
    assert.match(result.report, /\[S1\]\(https:\/\/source\.test\/one\)/);
    assert.match(result.report, /\[citation unavailable\]/);
    assert.doesNotMatch(result.report, /invented\.invalid/);
    assert.match(result.report, /## Sources/);
    const saved = JSON.parse(readFileSync(join(directory, `${started.id}.json`), 'utf8'));
    assert.equal(saved.status, 'complete');
    assert.equal(saved.sources.length, 4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an active research run can be cancelled and is persisted safely', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capsule-research-cancel-'));
  const complete = ({ signal }) => new Promise((resolve, reject) => {
    const fail = () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  const engine = new ResearchEngine({ dataDir: directory, complete });
  try {
    const started = engine.start({ query: 'Cancel this research', model: 'test-model', mode: 'deep' });
    assert.equal(engine.cancel(started.id), true);
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = engine.get(started.id, true);
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, 'cancelled');
    assert.equal(result.sources_count, 0);
    assert.equal(JSON.parse(readFileSync(join(directory, `${started.id}.json`), 'utf8')).status, 'cancelled');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('deep research verifies claims and revises the draft', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capsule-research-deep-'));
  const searchHtml = ['one', 'two', 'three', 'four'].map((name) => `<a class="result__a" href="https://source.test/${name}">${name} source</a>`).join('');
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('duckduckgo.com')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    return new Response(`<html><title>${new URL(url).pathname.slice(1)} title</title><article>${'Deep evidence worth keeping. '.repeat(40)}</article></html>`, { headers: { 'content-type': 'text/html' } });
  };
  const calls = [];
  const complete = async ({ messages }) => {
    const system = messages[0].content;
    calls.push(system);
    if (system.startsWith('You plan')) return '["one focused query"]';
    if (system.startsWith('Extract')) return 'A supported finding [S1].';
    if (system.startsWith('Find important gaps')) return '[]';
    if (system.startsWith('Cross-check')) return '{"issues":["Sources disagree on the dosage."],"gaps":["Long-term effects are understudied."]}';
    if (system.startsWith('Write a clear')) return '# Draft report\n\nA premature draft claim [S1].\n\n## Claim verification\n\n- Sources disagree on the dosage.\n- Long-term effects are understudied.';
    if (system.startsWith('You are a meticulous')) return '{"issues":["The draft repeats an unsupported claim."],"ok":false}';
    if (system.startsWith('Rewrite the research')) return '# Revised report\n\nEvery claim is now properly supported with evidence [S1].\n\n## Claim verification\n\n- Sources disagree on the dosage.\n- Long-term effects are understudied.';
    return '# Answer';
  };
  const engine = new ResearchEngine({ dataDir: directory, complete, fetchImpl, resolveHost: async () => [{ address: '93.184.216.34' }] });
  try {
    const started = engine.start({ query: 'Does the deep pipeline verify?', model: 'test-model', mode: 'deep' });
    let result;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      result = engine.get(started.id, true);
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, 'complete');
    const order = ['You plan', 'Extract', 'Find important gaps', 'Cross-check', 'Write a clear', 'You are a meticulous', 'Rewrite the research'];
    const step = (prompt) => order.findIndex((prefix) => prompt.startsWith(prefix));
    const trace = calls.map(step);
    assert.ok(trace.includes(step('Cross-check')), `verify step missing; trace ${trace.join(', ')}`);
    assert.ok(trace.includes(step('You are a meticulous')), `review step missing; trace ${trace.join(', ')}`);
    assert.ok(trace.includes(step('Rewrite the research')), `revise step missing; trace ${trace.join(', ')}`);
    assert.ok(trace.includes(step('Find important gaps')), `gap step missing; trace ${trace.join(', ')}`);
    assert.ok(step('Cross-check') > step('Extract'), 'verification must run after extraction');
    assert.ok(step('You are a meticulous') > step('Cross-check'), 'review must run after verification');
    assert.ok(step('Rewrite the research') > step('You are a meticulous'), 'revision must run after review');
    assert.match(result.report, /## Claim verification/);
    assert.match(result.report, /disagree on the dosage/);
    assert.match(result.report, /understudied/);
    assert.match(result.report, /Revised report/);
    assert.doesNotMatch(result.report, /premature draft claim/);
    assert.equal(calls.filter((prompt) => prompt.startsWith('Cross-check')).length, 1);
    assert.equal(calls.filter((prompt) => prompt.startsWith('Rewrite the research')).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('research can resume from a saved checkpoint without replanning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capsule-research-resume-'));
  const id = 'ab12cd34ef56';
  const roundOne = { id: 'S1', round: 1, url: 'https://alpha.test/one', title: 'Alpha source', snippet: 'alpha findings', text: 'First round evidence worth repeating. '.repeat(40) };
  const saved = {
    id, query: 'Resume this research', model: 'test-model', mode: 'deep', status: 'running',
    round: 1, rounds: 3, sources: [roundOne], sources_count: 1, queries: ['resumed query'],
    round_findings: { '1': 'Checkpointed finding [S1].' },
    report: '', error: '', started_at: Date.now(), completed_at: 0,
  };
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(saved));
  const searchHtml = ['two', 'three', 'four', 'five'].map((name, index) => {
    const host = ['beta.test', 'gamma.test', 'delta.test', 'epsilon.test'][index];
    return `<a class="result__a" href="https://${host}/${name}">${name} source</a>`;
  }).join('');
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('duckduckgo.com')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    return new Response(`<html><title>${new URL(url).hostname} title</title><article>${'Resumed round evidence. '.repeat(40)}</article></html>`, { headers: { 'content-type': 'text/html' } });
  };
  let planned = false;
  const complete = async ({ messages }) => {
    const system = messages[0].content;
    if (system.startsWith('You plan')) { planned = true; return '["should never happen"]'; }
    if (system.startsWith('Extract')) return 'Resumed finding [S2].';
    if (system.startsWith('Find important gaps')) return '[]';
    if (system.startsWith('Cross-check')) return '{"issues":["One stale claim [S1] persists."],"gaps":[]}';
    if (system.startsWith('Write a clear')) return '# Resumed report\n\nSupported by checkpointed and fresh evidence [S1] and [S2].\n\n## Claim verification\n\n- One stale claim [S1] persists.';
    if (system.startsWith('You are a meticulous')) return '{"issues":[]}';
    return '# Answer';
  };
  const engine = new ResearchEngine({ dataDir: directory, complete, fetchImpl, resolveHost: async () => [{ address: '93.184.216.34' }] });
  try {
    const resumed = engine.resume(id);
    assert.ok(resumed, 'resume should return a running job');
    assert.match(resumed.message, /Resuming deep research at round 1\/3/);
    let result;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      result = engine.get(id, true);
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, 'complete');
    assert.equal(planned, false, 'resumed research must not re-plan');
    assert.equal(result.round, 2);
    assert.equal(result.sources_count, 5);
    assert.match(result.report, /## Claim verification/);
    assert.match(result.report, /alpha\.test\/one/);
    const final = JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'));
    assert.equal(final.status, 'complete');
    assert.equal(final.round_findings['1'], 'Checkpointed finding [S1].');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('quick research streams write-phase deltas to onToken', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capsule-research-stream-'));
  const searchHtml = '<a class="result__a" href="https://stream.test/one">stream source</a>';
  const fetchImpl = async (input) => {
    if (String(input).includes('duckduckgo.com')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    return new Response(`<html><title>stream page</title><article>${'Streaming evidence worth repeating. '.repeat(40)}</article></html>`, { headers: { 'content-type': 'text/html' } });
  };
  let writeOnTokenCalls = 0;
  const complete = async ({ messages, onToken }) => {
    const system = messages[0].content;
    if (system.startsWith('You plan')) return '["one"]';
    if (system.startsWith('Extract')) return 'Streamed finding [S1].';
    if (system.startsWith('Write a clear')) { writeOnTokenCalls += 1; if (onToken) { onToken('stream chunk '); onToken('two'); } return '# Stream report\n\nDraft [S1].'; }
    return 'done';
  };
  const engine = new ResearchEngine({ dataDir: directory, complete, fetchImpl, resolveHost: async () => [{ address: '93.184.216.34' }] });
  try {
    const started = engine.start({ query: 'Test streaming', model: 'test-model', mode: 'quick' });
    let result;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      result = engine.get(started.id, true);
      if (result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, 'complete');
    assert.ok(writeOnTokenCalls > 0, 'onToken must be provided during the write phase');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
