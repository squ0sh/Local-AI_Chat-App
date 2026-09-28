import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicWebUrl } from '../lib/agent-loop.mjs';

test('web fetch validation blocks credentials and local/private targets', async () => {
  for (const url of [
    'file:///etc/passwd',
    'http://localhost:11434/api/tags',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://user:pass@example.com/',
  ]) {
    await assert.rejects(validatePublicWebUrl(url), /blocked|public|http/i);
  }
});

test('web fetch validation accepts a public literal address without network lookup', async () => {
  const parsed = await validatePublicWebUrl('https://93.184.216.34/example');
  assert.equal(parsed.protocol, 'https:');
});
