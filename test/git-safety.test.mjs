import test from 'node:test';
import assert from 'node:assert/strict';
import { safeGitArguments } from '../lib/git-safety.mjs';

test('read-only git grammar accepts common inspection commands', () => {
  for (const args of [
    ['status', '--short', '--branch'],
    ['diff', '--stat'],
    ['log', '--oneline', '--max-count=10'],
    ['show', 'HEAD'],
    ['branch', '--list'],
    ['remote', '-v'],
    ['tag', '--list'],
    ['rev-parse', '--show-toplevel'],
  ]) {
    const result = safeGitArguments(args);
    assert.equal(result.ok, true, JSON.stringify({ args, result }));
    assert.equal(result.args.includes('--no-pager'), true);
  }
});

test('read-only git grammar rejects mutation, helper execution, and output writes', () => {
  for (const args of [
    ['branch', 'new-branch'],
    ['branch', '-D', 'main'],
    ['tag', 'release'],
    ['remote', 'add', 'evil', 'https://example.invalid/repo'],
    ['diff', '--output=/tmp/leak'],
    ['diff', '--ext-diff'],
    ['show', '--textconv'],
    ['log', '--exec=touch /tmp/pwned'],
    ['reset', '--hard'],
  ]) {
    assert.equal(safeGitArguments(args).ok, false, JSON.stringify(args));
  }
});
