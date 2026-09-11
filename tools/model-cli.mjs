#!/usr/bin/env node
/**
 * model-cli.mjs — manage Ollama models from the command line.
 *
 * Usage:
 *   node tools/model-cli.mjs list                     # list installed models
 *   node tools/model-cli.mjs list --json              # JSON output
 *   node tools/model-cli.mjs pull <name>              # pull/download a model
 *   node tools/model-cli.mjs search <term>            # search remote library
 *   node tools/model-cli.mjs info <name>              # show model details
 *
 * Global options:
 *   --url <base>   Ollama API URL (default http://127.0.0.1:11434)
 *   --help
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pullOllamaModel } from '../lib/resumable-ollama-pull.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadOllamaUrl() {
  // 1. --url flag
  const i = process.argv.indexOf('--url');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  // 2. env
  if (process.env.OLLAMA_URL) return process.env.OLLAMA_URL.replace(/\/+$/, '');
  // 3. OLLAMA_HOST/OLLAMA_PORT env (set by the official client)
  const host = process.env.OLLAMA_HOST || '127.0.0.1';
  const port = process.env.OLLAMA_PORT || '11434';
  return `http://${host}:${port}`;
}

const OLLAMA = loadOllamaUrl();

function humanSize(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const dm = decimals < 0 ? 0 : decimals;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

async function api(path, { method = 'GET', body } = {}) {
  const url = OLLAMA + path;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r;
}

// ── list ────────────────────────────────────────────────────────────────
async function cmdList() {
  const json = process.argv.includes('--json');
  let r;
  try { r = await api('/api/tags'); }
  catch (e) {
    console.error(`✗  Cannot reach Ollama at ${OLLAMA}`);
    console.error(`   ${e.message}`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error('✗  Failed (HTTP ' + r.status + '): ' + (await r.text()).slice(0, 300));
    process.exit(1);
  }
  const { models = [] } = await r.json();

  if (json) { console.log(JSON.stringify(models, null, 2)); return; }

  if (models.length === 0) {
    console.log('No models installed.'),
    console.log('Pull one, e.g.:  node tools/model-cli.mjs pull llama3.2:3b');
    return;
  }

  console.log(`${models.length} model${models.length === 1 ? '' : 's'} at ${OLLAMA}\n`);
  for (const m of models) {
    const d = m.details || {};
    const tags = [d.parameter_size, d.quantization_level, d.family].filter(Boolean).join(' · ');
    console.log(`  ${pad(m.name, 28)} ${pad(humanSize(m.size), 10)} ${tags}`);
  }
  console.log('\n  Run with --json for full details.');
}

// ── pull ────────────────────────────────────────────────────────────────
async function cmdPull(name) {
  if (!name) { console.error('Usage: node tools/model-cli.mjs pull <name>'); process.exit(1); }
  console.log(`Pulling ${name} …`);
  try {
    await pullOllamaModel({
      baseUrl: OLLAMA,
      model: name,
      onUpdate(j) {
        if (j.digest) {
        const total = j.total || 0, completed = j.completed || 0, pct = total ? (completed / total * 100).toFixed(1) : '…';
        const msg = `  ${pad(j.status || '', 14)} ${String(pct).padStart(6)}%  ${humanSize(j.completed)} / ${humanSize(total)}   `;
        process.stdout.write('\r' + msg.padEnd(60));
        } else if (j.status) console.log('\r' + '  ' + String(j.status).padEnd(60));
      },
      onReconnect({ reconnects, maxReconnects }) {
        console.log(`\n  Connection stalled — reconnecting ${reconnects}/${maxReconnects}. Partial data is safe.`);
      },
    });
  } catch (error) {
    console.error('\n✗  Download stopped: ' + error.message);
    console.error('   Run the same command again to resume the saved partial download.');
    process.exit(1);
  }
  process.stdout.write('\n✅  Done — model ready: ' + name + '\n');
}

// ── search ──────────────────────────────────────────────────────────────
async function cmdSearch(term) {
  if (!term) { console.error('Usage: node tools/model-cli.mjs search <term>'); process.exit(1); }
  const r = await api('/api/search', { method: 'POST', body: { query: term } });
  const { models = [] } = await r.json().catch(() => ({}));
  if (models.length === 0) { console.log('No matches for "' + term + '".'); return; }
  console.log(`Results for "${term}":\n`);
  for (const m of models.slice(0, 20)) {
    console.log(`  ${pad(m.name, 40)} ${m.description || ''}`);
  }
}

// ── info ────────────────────────────────────────────────────────────────
async function cmdInfo(name) {
  if (!name) { console.error('Usage: node tools/model-cli.mjs info <name>'); process.exit(1); }
  const r = await api('/api/show', { method: 'POST', body: { name } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('✗  ' + (j.error || 'HTTP ' + r.status)); process.exit(1); }
  const m = j.model || {};
  const d = m.details || {};
  console.log(`Name            : ${name}`);
  console.log(`Family          : ${d.family || '—'}`);
  console.log(`Parameters      : ${d.parameter_size || '—'}`);
  console.log(`Quantization    : ${d.quantization_level || '—'}`);
  console.log(`Context length  : ${(j.model_info && j.model_info['llama.context_length']) || '—'}`);
  if (j.template) { console.log(`\nTemplate        : ${String(j.template).slice(0, 200)}`); }
  console.log(`\nModelfile       :\n${(j.modelfile || '').slice(0, 800)}`);
}

// ── dispatch ────────────────────────────────────────────────────────────
function usage() {
  console.log(`Local AI Copilot — Ollama model CLI\n
Usage: node tools/model-cli.mjs <command> [options]

Commands:
  list [--json]         List installed models
  pull <name>           Download a model
  search <term>         Search the remote model library
  info <name>           Show model details

Options:
  --url <base>   Ollama API URL (default ${OLLAMA})
  --help         Show this help
`);
}

const [rawCmd, ...rest] = process.argv.slice(2).filter((a) => a !== '--help' && !a.startsWith('--url'));
const cmd = rawCmd;

if (process.argv.includes('--help') || !cmd) { usage(); process.exit(cmd ? 0 : 1); }

switch (cmd) {
  case 'list': await cmdList(); break;
  case 'pull': await cmdPull(rest[0]); break;
  case 'search': await cmdSearch(rest[0]); break;
  case 'info': await cmdInfo(rest[0]); break;
  default:
    console.error('Unknown command: ' + cmd);
    usage();
    process.exit(1);
}
