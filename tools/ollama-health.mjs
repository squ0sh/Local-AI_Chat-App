const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11435').replace(/\/$/, '');

try {
  const response = await fetch(url + '/api/version', { signal: AbortSignal.timeout(1500) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
