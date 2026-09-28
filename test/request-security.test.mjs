import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackPeer, isSameOriginRequest } from '../lib/request-security.mjs';

function request(remoteAddress, host = 'localhost:5173', origin = '') {
  return { socket: { remoteAddress }, headers: { host, ...(origin ? { origin } : {}) } };
}

test('local trust follows the socket peer and cannot be gained with a Host header', () => {
  assert.equal(isLoopbackPeer(request('127.0.0.1')), true);
  assert.equal(isLoopbackPeer(request('::1')), true);
  assert.equal(isLoopbackPeer(request('::ffff:127.0.0.1')), true);
  assert.equal(isLoopbackPeer(request('192.168.1.50', 'localhost:5173')), false);
  assert.equal(isLoopbackPeer(request('203.0.113.10', '127.0.0.1:5173')), false);
  const cloudflare = request('127.0.0.1');
  cloudflare.headers['cf-connecting-ip'] = '203.0.113.10';
  assert.equal(isLoopbackPeer(cloudflare), false);
});

test('browser origins must match the request host exactly', () => {
  assert.equal(isSameOriginRequest(request('127.0.0.1')), true);
  assert.equal(isSameOriginRequest(request('127.0.0.1', 'localhost:5173', 'http://localhost:5173')), true);
  assert.equal(isSameOriginRequest(request('127.0.0.1', 'remote.example', 'https://remote.example')), true);
  assert.equal(isSameOriginRequest(request('127.0.0.1', 'localhost:5173', 'https://evil.example')), false);
  assert.equal(isSameOriginRequest(request('127.0.0.1', 'localhost:5173', 'null')), false);
});
