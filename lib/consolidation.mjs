// Consolidation cycle — the Capsule "sleeps on it": it digests what is new,
// drafts durable memory facts and procedure candidates, and hands you a
// morning briefing of proposals you approve or dismiss. Nothing lands without
// your click. (Design: manual trigger; approve-everything.)
//
// Dependency-injected: `complete(system,user)` does the local-model thinking,
// `collectSources(since)` gathers changed sources, `apply` routes approvals
// to the memory/procedure stores. The engine itself is a pure state machine.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

const queuePath = (dataDir) => join(dataDir, 'consolidation', 'queue.json');
const statePath = (dataDir) => join(dataDir, 'consolidation', 'cycle.json');
const ledgerPath = (dataDir) => join(dataDir, 'consolidations.log');

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value, mode600 = true) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  if (mode600) { try { chmodSync(tmp, 0o600); } catch {} }
  renameSync(tmp, file);
}

const DIGEST_SYSTEM = `You consolidate the transcript of a local AI session into durable knowledge. Read the source and reply with JSON ONLY:
{"facts":[{"text":"durable factual or decision statement, 1-2 sentences","quote":"short exact supporting quote"}]}
Rules: 0-5 facts; only things still true and useful later (decisions, conventions, requirements, discoveries); never greetings or filler; quotes must appear in the source verbatim.`;

const MINE_SYSTEM = `You mine reusable work procedures from session digests. Given the listed facts, propose 0-2 procedure cards the user would plausibly reuse. JSON ONLY:
{"procedures":[{"name":"short title","summary":"one sentence","steps":["step","step"],"why":"which fact backs this"}]}
Rules: only procedural knowledge (how-to with a repeatable shape); skip one-off trivia; 3-6 steps each.`;

const BRIEF_SYSTEM = `Write the calm "while you were away" note for a local AI capsule's overnight consolidation. Plain text, <=80 words, warm but precise. Report: how many sources were digested, how many proposals await review, and one line on the most interesting proposal if any. No bullet lists needed.`;

function extractJson(text, wantArrayKey) {
  const s = String(text || '');
  const brace = s.indexOf('{');
  if (brace < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = brace; i < s.length; i += 1) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (!depth) { try { const j = JSON.parse(s.slice(brace, i + 1)); return wantArrayKey ? (Array.isArray(j?.[wantArrayKey]) ? j[wantArrayKey] : null) : j; } catch { return null; } } }
  }
  return null;
}

export class ConsolidationEngine {
  constructor({ dataDir, complete, collectSources, apply }) {
    this.dataDir = dataDir;
    this.complete = complete;         // async (system, user) => string
    this.collectSources = collectSources; // async (sinceISO) => [{src:{type,id,title,changedAt}, text}]
    this.apply = apply;               // { memory: async (text, citations)=>void, procedure: async (card, citations)=>void }
    this.state = 'idle';              // idle|collecting|digesting|mining|briefing|ready|error|cancelled
    this.error = '';
    this.progress = { done: 0, total: 0, current: '' };
    this.cancelRequested = false;
  }

  _readQueue() { return readJsonSafe(queuePath(this.dataDir), { schema: 1, proposals: [] }).proposals || []; }
  _writeQueue(list) { writeJsonAtomic(queuePath(this.dataDir), { schema: 1, proposals: list }); }

  _readCycle() {
    return readJsonSafe(statePath(this.dataDir), {
      lastRunAt: '', sources: 0, digested: 0, proposed: 0, briefing: '', unread: false,
    });
  }
  _writeCycle(patch) { writeJsonAtomic(statePath(this.dataDir), { ...this._readCycle(), ...patch }); }

  _log(line) {
    try {
      mkdirSync(dirname(ledgerPath(this.dataDir)), { recursive: true });
      appendFileSync(ledgerPath(this.dataDir), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {}
  }

  status() {
    const cycle = this._readCycle();
    const queue = this._readQueue().filter((p) => p.status === 'queued');
    return {
      state: this.state,
      error: this.error,
      progress: this.progress,
      lastRunAt: cycle.lastRunAt || '',
      lastRun: cycle,
      queuedCount: queue.length,
      briefing: cycle.briefing || '',
      unread: !!cycle.unread,
    };
  }

  cancel() { this.cancelRequested = true; }

  _fail(message) { this.state = 'error'; this.error = message; this.progress.current = ''; }

  async start({ force = false } = {}) {
    if (!['idle', 'ready', 'error', 'cancelled'].includes(this.state)) {
      return { ok: false, error: 'A sleep cycle is already in progress.' };
    }
    this.state = 'collecting'; this.error = ''; this.cancelRequested = false;
    this.progress = { done: 0, total: 0, current: 'gathering what changed…' };
    try {
      const since = this._readCycle().lastRunAt || '';
      const sources = (await this.collectSources(since)).filter((s) => s && s.text && s.text.length >= 80).slice(0, 12);
      if (!sources.length && !force) {
        this.state = 'idle';
        return { ok: true, quiet: true, message: 'Nothing new since the last cycle — the capsule rests.' };
      }
      this.progress.total = sources.length;

      // ── Digest phase: source → durable fact candidates ──
      const facts = [];
      for (const src of sources) {
        if (this.cancelRequested) return this._cancelled();
        this.state = 'digesting';
        this.progress.current = `digesting ${src.src.title || src.src.id}`;
        let list = null;
        try {
          const out = await this.complete(DIGEST_SYSTEM, `Source “${src.src.title || src.src.id}” (${src.src.type}):\n\n${src.text.slice(0, 9000)}`);
          list = extractJson(out, 'facts');
        } catch (e) { return this._cancelOrFail(e) || undefined; }
        for (const f of list || []) {
          const text = String(f?.text || '').trim();
          const quote = String(f?.quote || '').trim();
          if (!text || text.length < 24) continue;
          facts.push({ text, quote, src: src.src });
        }
        this.progress.done += 1;
      }

      // ── Mine phase: digests → procedure candidates ──
      let mined = [];
      if (facts.length) {
        if (this.cancelRequested) return this._cancelled();
        this.state = 'mining';
        this.progress.current = 'mining procedures from the day’s patterns';
        try {
          const out = await this.complete(MINE_SYSTEM, 'Digested facts:\n' + facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n'));
          mined = extractJson(out, 'procedures') || [];
        } catch (e) { return this._cancelOrFail(e) || undefined; }
      }

      // ── Stage everything as proposals — nothing lands without approval ──
      const queue = this._readQueue();
      const proposals = [];
      for (const f of facts) {
        proposals.push({
          id: `cq-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
          kind: 'memory', title: f.text.slice(0, 70) + (f.text.length > 70 ? '…' : ''),
          body: f.text, citations: [{ type: f.src.type, id: f.src.id, title: f.src.title, quote: f.quote }],
          status: 'queued', created: new Date().toISOString(),
        });
      }
      for (const m of mined) {
        const name = String(m?.name || '').trim();
        const steps = (Array.isArray(m?.steps) ? m.steps : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
        if (!name || steps.length < 2) continue;
        const backer = facts.find((f) => f.text === String(m.why || ''))?.src || sources[0]?.src;
        proposals.push({
          id: `cq-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
          kind: 'procedure', title: name, summary: String(m?.summary || '').slice(0, 200), steps,
          citations: backer ? [{ type: backer.type, id: backer.id, title: backer.title, quote: '' }] : [],
          status: 'queued', created: new Date().toISOString(),
        });
      }
      queue.push(...proposals);
      this._writeQueue(queue);

      // ── Briefing ──
      this.state = 'briefing'; this.progress.current = 'writing the note…';
      let briefing;
      try {
        briefing = (await this.complete(
          BRIEF_SYSTEM,
          `Sources digested: ${sources.length}. New memory proposals: ${facts.length}. Procedure proposals: ${mined.length}. Most notable proposal: ${proposals[0]?.title || 'none'}.`,
        )).trim();
      } catch (e) { return this._cancelOrFail(e) || undefined; }
      if (briefing.length < 12) briefing = `${sources.length} source(s) digested; ${proposals.length} proposal(s) wait for your review.`;

      this._writeCycle({
        lastRunAt: new Date().toISOString(),
        sources: sources.length, digested: facts.length, proposed: proposals.length,
        briefing, unread: true,
      });
      this._log(`cycle complete: ${sources.length} sources → ${facts.length} memory proposals, ${mined.length} procedure proposals (${proposals.length} queued)`);
      this.state = 'ready';
      this.progress.current = '';
      return { ok: true, proposed: proposals.length, briefing };
    } catch (e) {
      this._fail(String(e && e.message || e));
      return { ok: false, error: this.error };
    }
  }

  _cancelled() { this.state = 'cancelled'; this.progress.current = ''; this._log('cycle cancelled'); return { ok: false, cancelled: true }; }
  _cancelOrFail(e) {
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || this.cancelRequested) return this._cancelled();
    this._fail(String(e && e.message || e));
    return { ok: false, error: this.error };
  }

  listQueue() { return this._readQueue().filter((p) => p.status === 'queued'); }

  async approve(id) {
    const queue = this._readQueue();
    const p = queue.find((x) => x.id === id && x.status === 'queued');
    if (!p) return { ok: false, error: 'Proposal not found (or already handled).' };
    try {
      if (p.kind === 'memory') {
        await this.apply.memory(p.body, p.citations);
      } else if (p.kind === 'procedure') {
        await this.apply.procedure({ name: p.title, summary: p.summary || '', steps: p.steps || [] }, p.citations);
      }
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    p.status = 'approved'; p.decidedAt = new Date().toISOString();
    this._writeQueue(queue);
    this._log(`approved ${p.kind} proposal “${p.title}”`);
    const remaining = queue.filter((x) => x.status === 'queued').length;
    if (!remaining) this._writeCycle({ unread: false });
    return { ok: true, remaining };
  }

  async dismiss(id, reason = '') {
    const queue = this._readQueue();
    const p = queue.find((x) => x.id === id && x.status === 'queued');
    if (!p) return { ok: false, error: 'Proposal not found (or already handled).' };
    p.status = 'dismissed'; p.decidedAt = new Date().toISOString();
    this._writeQueue(queue);
    this._log(`dismissed ${p.kind} proposal “${p.title}”${reason ? ` — ${String(reason).slice(0, 120)}` : ''}`);
    const remaining = queue.filter((x) => x.status === 'queued').length;
    if (!remaining) this._writeCycle({ unread: false });
    return { ok: true, remaining };
  }
}
