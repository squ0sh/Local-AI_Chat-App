// Hermetic in-process fake for Ollama's HTTP surface, just wide enough for the
// HTTP integration tests:
//   POST /v1/chat/completions  (OpenAI SSE + JSON) — used by /api/chat,
//                              /v1/chat/completions, and /v1/responses
//   POST /api/chat             (native Ollama, newline-JSON)
//   GET  /v1/models, /api/tags
// Every POST (method, path, parsed body) is recorded in `calls` for
// request-shape assertions. Pure Node http, cross-platform.
import { createServer } from 'http';

export function startFakeOllama(t, { model = 'fake-llama:3b', chunks, agentScript } = {}) {
  const tokenChunks = chunks || ['hello', ' ', 'world'];
  const fullReply = tokenChunks.join('');
  const script = Array.isArray(agentScript) ? [...agentScript] : null;
  const created = Math.floor(Date.now() / 1000);
  const calls = [];

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created, owned_by: 'local' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: model, model, modified_at: new Date().toISOString(), size: 100 }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch {}
      if (req.method === 'POST') calls.push({ method: req.method, path: req.url, body: parsed });

      if (req.method === 'POST' && req.url === '/api/chat') {
        // Optional agent scripting: an array of strings consumed per request —
        // each string becomes the assistant's content for that step. Lets an
        // e2e test drive tool calls through the loop's XML-fallback parser.
        if (script) {
          const stepText = script.length ? script.shift() : 'done';
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: stepText }, done: false }) + '\n');
          res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 2, eval_count: 1, eval_duration: 1e9 }) + '\n');
          res.end();
          return;
        }
        if (parsed && parsed.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model, created_at: new Date().toISOString(),
            message: { role: 'assistant', content: fullReply }, done: true,
            prompt_eval_count: 2, eval_count: tokenChunks.length, eval_duration: 1e9,
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (const tok of tokenChunks) {
          res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: tok }, done: false }) + '\n');
        }
        res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 2, eval_count: tokenChunks.length, eval_duration: 1e9 }) + '\n');
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        if (!(parsed && parsed.stream)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-fake', object: 'chat.completion', created, model,
            choices: [{ index: 0, message: { role: 'assistant', content: fullReply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: tokenChunks.length, total_tokens: 2 + tokenChunks.length },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const tok of tokenChunks) {
          res.write('data: ' + JSON.stringify({
            id: 'chatcmpl-fake', object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: tok } }],
          }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fake-ollama: unhandled ' + req.method + ' ' + req.url }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => server.close());
      resolve({ url: 'http://127.0.0.1:' + port, port, model, calls, close: () => server.close() });
    });
  });
}