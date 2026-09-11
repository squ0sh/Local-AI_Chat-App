const DEFAULT_STALL_MS = 90_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_RECONNECTS = 12;

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Download cancelled');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function timedRead(reader, timeout, controller) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('The model download stopped making progress');
      error.code = 'MODEL_PULL_STALLED';
      controller.abort(error);
      reject(error);
    }, Math.max(1, timeout));
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

function retryable(error) {
  if (error?.code === 'MODEL_PULL_STALLED') return true;
  if (error?.code === 'OLLAMA_PULL_HTTP') return Number(error.status || 0) >= 500;
  const message = String(error?.message || error).toLowerCase();
  return /fetch failed|connection|socket|network|timed?\s*out|timeout|eof|max retries|reset by peer|temporar|stalled|stream ended/.test(message);
}

/**
 * Supervise a streaming Ollama pull. Ollama retains partial model layers, so a
 * fresh /api/pull request resumes instead of starting over when a CDN
 * connection stalls. `fetchImpl` and short timeouts are injectable for tests.
 */
export async function pullOllamaModel({
  baseUrl,
  model,
  signal,
  onUpdate,
  onReconnect,
  fetchImpl = globalThis.fetch,
  stallMs = DEFAULT_STALL_MS,
  idleMs = DEFAULT_IDLE_MS,
  maxReconnects = DEFAULT_MAX_RECONNECTS,
  retryDelayMs = 1_500,
}) {
  if (!baseUrl || !model) throw new Error('Ollama URL and model are required');
  const layers = new Map();
  let reconnects = 0;

  while (true) {
    if (signal?.aborted) throw abortError(signal);
    const attemptController = new AbortController();
    const cancelAttempt = () => attemptController.abort(signal?.reason);
    signal?.addEventListener('abort', cancelAttempt, { once: true });
    let reader;
    try {
      const response = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: attemptController.signal,
      });
      if (!response.ok || !response.body) {
        const error = new Error((await response.text()).slice(0, 300) || `Ollama returned HTTP ${response.status}`);
        error.code = 'OLLAMA_PULL_HTTP';
        error.status = response.status;
        throw error;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastAdvance = Date.now();
      let lastStatus = '';
      let sawSuccess = false;

      const consume = (line) => {
        if (!line.trim()) return;
        let update;
        try { update = JSON.parse(line); } catch { return; }
        if (update.error) {
          const error = new Error(update.error);
          error.code = 'OLLAMA_PULL_STREAM';
          throw error;
        }
        const status = String(update.status || '');
        if (status && status !== lastStatus) {
          lastStatus = status;
          lastAdvance = Date.now();
        }
        if (update.digest) {
          const completed = Math.max(0, Number(update.completed || 0));
          const previous = layers.get(update.digest)?.completed || 0;
          if (completed > previous) lastAdvance = Date.now();
          layers.set(update.digest, { completed, total: Math.max(0, Number(update.total || 0)) });
        }
        if (status === 'success') sawSuccess = true;
        onUpdate?.(update, { reconnects, lastProgressAt: lastAdvance });
      };

      while (true) {
        const incomplete = [...layers.values()].some((layer) => layer.total > 0 && layer.completed < layer.total);
        const limit = incomplete || !layers.size ? stallMs : idleMs;
        const remaining = limit - (Date.now() - lastAdvance);
        if (remaining <= 0) {
          const error = new Error('The model download stopped making progress');
          error.code = 'MODEL_PULL_STALLED';
          throw error;
        }
        const { done, value } = await timedRead(reader, remaining, attemptController);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!sawSuccess) {
        const error = new Error('The Ollama download stream ended before the model was ready');
        error.code = 'OLLAMA_PULL_STREAM';
        throw error;
      }
      return { sawSuccess, reconnects };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (!retryable(error) || reconnects >= maxReconnects) throw error;
      reconnects += 1;
      const waitMs = Math.min(15_000, retryDelayMs * Math.max(1, reconnects));
      onReconnect?.({ reconnects, maxReconnects, waitMs, error });
      await delay(waitMs, signal);
    } finally {
      signal?.removeEventListener('abort', cancelAttempt);
      try { await reader?.cancel(); } catch {}
      if (!attemptController.signal.aborted) attemptController.abort();
    }
  }
}

export const OLLAMA_PULL_DEFAULTS = Object.freeze({
  stallMs: DEFAULT_STALL_MS,
  idleMs: DEFAULT_IDLE_MS,
  maxReconnects: DEFAULT_MAX_RECONNECTS,
});
