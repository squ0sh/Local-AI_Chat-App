// Cloudflare Worker gateway for a RunPod Serverless vLLM endpoint.
// Store RUNPOD_API_KEY as a Wrangler secret; never expose it to the browser.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  return origin && origin === env.ALLOWED_ORIGIN
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
    : {};
}

function reply(request, env, status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors(request, env) } });
}

function inviteCode(request) {
  return request.headers.get('X-App-Invite') || '';
}

export class RateLimiter {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const { action, max } = await request.json();
    const now = Date.now();
    const current = (await this.state.storage.get('state')) || { started: now, count: 0, active: false };
    if (now - current.started >= 60_000) Object.assign(current, { started: now, count: 0 });

    if (action === 'release') {
      current.active = false;
      await this.state.storage.put('state', current);
      return Response.json({ ok: true });
    }
    if (current.active || current.count >= max) return Response.json({ ok: false }, { status: 429 });
    current.active = true;
    current.count += 1;
    await this.state.storage.put('state', current);
    return Response.json({ ok: true });
  }
}

async function reserve(env, code) {
  const id = env.RATE_LIMITER.idFromName(code);
  const stub = env.RATE_LIMITER.get(id);
  const response = await stub.fetch('https://limiter/acquire', {
    method: 'POST', body: JSON.stringify({ action: 'acquire', max: Number(env.REQUESTS_PER_MINUTE || 12) }),
  });
  return { ok: response.ok, release: () => stub.fetch('https://limiter/release', { method: 'POST', body: JSON.stringify({ action: 'release' }) }) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(request, env), 'Access-Control-Allow-Headers': 'Content-Type, X-App-Invite', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return reply(request, env, 404, { error: 'Not found' });
    if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 1_000_000) return reply(request, env, 413, { error: 'Request too large' });

    const code = inviteCode(request);
    const invite = code && await env.INVITES.get(code, 'json');
    if (!invite || invite.disabled || (invite.expiresAt && Date.now() > invite.expiresAt)) return reply(request, env, 401, { error: 'Valid invite required' });

    let payload;
    try { payload = await request.json(); } catch { return reply(request, env, 400, { error: 'Invalid JSON' }); }
    if (!Array.isArray(payload.messages) || !payload.messages.length) return reply(request, env, 400, { error: 'messages is required' });

    const lease = await reserve(env, code);
    if (!lease.ok) return reply(request, env, 429, { error: 'You already have a response running, or your minute quota is full. Please try again shortly.' });

    const upstreamUrl = `https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/openai/v1/chat/completions`;
    const body = JSON.stringify({ ...payload, model: env.PUBLIC_MODEL, stream: true, max_tokens: Math.min(Number(payload.max_tokens) || 1024, 2048) });
    let upstream;
    try {
      // One quick retry absorbs transient worker capacity throttles without
      // asking the browser to retry itself.
      upstream = await fetch(upstreamUrl, { method: 'POST', headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' }, body });
      if (upstream.status === 429) { await wait(700); upstream = await fetch(upstreamUrl, { method: 'POST', headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' }, body }); }
      if (!upstream.ok || !upstream.body) {
        const detail = (await upstream.text()).slice(0, 300);
        await lease.release();
        return reply(request, env, upstream.status === 429 ? 503 : 502, { error: 'Model service unavailable', detail });
      }
    } catch {
      await lease.release();
      return reply(request, env, 502, { error: 'Could not reach model service' });
    }

    const { readable, writable } = new TransformStream();
    ctx.waitUntil(upstream.body.pipeTo(writable).catch(() => {}).finally(() => lease.release()));
    return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors(request, env) } });
  },
};
