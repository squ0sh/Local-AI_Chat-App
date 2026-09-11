import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ResearchEngine, assertPublicUrl, extractPage, parseBingRss, parseDuckDuckGo } from '../lib/research-engine.mjs';

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
