// Kokoro-82M TTS worker. Spawned by server.mjs on demand. Reads a JSON payload
// from argv[2] (text is capped at 4000 chars by the caller, well under argv
// limits), writes a 24 kHz WAV, and reports back as JSON on stdout.
import fs from 'node:fs/promises';
import path from 'node:path';

const payload = JSON.parse(process.argv[2] || '{}');

async function loadKokoro(workerDir) {
  if (!workerDir) return (await import('kokoro-js')).default ?? (await import('kokoro-js'));
  const entry = path.join(workerDir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js');
  const fileUrl = 'file:///' + path.resolve(entry).replace(/\\/g, '/').replace(/^\/+/, '');
  const mod = await import(fileUrl);
  return mod.default ?? mod;
}

async function main() {
  const { text, voice, speed, output, cacheDir, workerDir } = payload;
  if (!text) throw new Error('no text');
  if (cacheDir) {
    process.env.TRANSFORMERS_CACHE = cacheDir;
    process.env.HF_HOME = cacheDir;
  }
  const k = await loadKokoro(workerDir);
  const { KokoroTTS } = k;
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const audio = await tts.generate(text, { voice: voice || 'af_heart', speed: Number(speed) || 1 });
  await fs.mkdir(path.dirname(output), { recursive: true });
  audio.save(output);
  process.stdout.write(JSON.stringify({ ok: true, output, sampleRate: audio.sampling_rate || audio.sampleRate || 24000 }));
}

main().catch((err) => {
  process.stderr.write((err?.stack || err?.message || String(err)) + '\n');
  process.exit(1);
});