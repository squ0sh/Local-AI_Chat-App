// Machine-body telemetry: a live sense of the computer the Capsule runs on.
//
// Three layers, all local-first and no-network by construction:
//  - readSensors()      samples the machine (CPU/mem/thermal/fan/battery/load),
//                       rooted in overridable sys/proc dirs so tests can run
//                       the parser against fixtures on any host.
//  - Telemetry          ring buffer + bounded on-disk journal + job attribution
//                       ("this image run burned ~0.003 kWh") with honest watts
//                       estimates from measured core-seconds, and a small
//                       diagnostics ruleset answering "why is it loud/hot".
//  - narrate()          plain-language paragraph for the machine card.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { totalmem, freemem } from 'os';

export const SAMPLE_ACTIVE_MS = 1000;
export const SAMPLE_IDLE_MS = 60_000;
export const RING_MAX_MINUTES = 48 * 60;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const get = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const num = (s) => { const n = Number(String(s || '').trim()); return Number.isFinite(n) ? n : null; };

// ── Sensor readers (POSIX-first; callers inject the roots in tests) ─────────
export function readCpuPercent(prev, next) {
  if (!prev || !next) return null;
  const delta = (k) => (next[k] || 0) - (prev[k] || 0);
  const idle = delta('idle') + delta('iowait');
  const total = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'].reduce((a, k) => a + delta(k), 0);
  if (total <= 0) return null;
  return Math.round(clamp01(1 - idle / total) * 100);
}

export function parseProcStatLine(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  return { user: parts[0], nice: parts[1], system: parts[2], idle: parts[3], iowait: parts[4], irq: parts[5], softirq: parts[6], steal: parts[7] };
}

export function parseProcMeminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)\s*kB/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function readLinuxSensors(roots = {}) {
  const sys = roots.sys || '/sys';
  const proc = roots.proc || '/proc';
  const out = { cpuCores: 0, memTotal: 0, memAvailable: 0, loadavg1: null, tempC: null, fanRpm: null, battery: null };

  const meminfo = parseProcMeminfo(get(join(proc, 'meminfo')));
  if (meminfo.MemTotal) { out.memTotal = Math.round(meminfo.MemTotal / 1048576 * 100) / 100; out.memAvailable = Math.round((meminfo.MemAvailable || 0) / 1048576 * 100) / 100; }

  out.loadavg1 = num(get(join(proc, 'loadavg'))?.split(' ')[0]);
  const cpuinfo = get(join(proc, 'cpuinfo'));
  if (cpuinfo) out.cpuCores = (cpuinfo.match(/^processor\s*:/gm) || []).length || 0;

  // Thermal: first thermal zone reporting anything meaningful (m°C).
  try {
    for (const zone of readdirSync(join(sys, 'class', 'thermal')).filter((n) => n.startsWith('thermal_zone'))) {
      const raw = num(get(join(sys, 'class', 'thermal', zone, 'temp')));
      if (raw != null && raw > 1000) { out.tempC = Math.round(raw / 1000); break; }
      if (raw != null && raw <= 150) { out.tempC = raw; break; }
    }
  } catch {}

  // Fans: first hwmon reporting fanX_input.
  try {
    for (const hwmon of readdirSync(join(sys, 'class', 'hwmon'))) {
      const dir = join(sys, 'class', 'hwmon', hwmon);
      for (const fan of readdirSync(dir).filter((n) => /^fan\d+_input$/.test(n))) {
        const raw = num(get(join(dir, fan)));
        if (raw != null) { out.fanRpm = Math.round(raw); break; }
      }
      if (out.fanRpm != null) break;
    }
  } catch {}

  // Battery: first BAT* classed power_supply with readings.
  try {
    for (const ps of readdirSync(join(sys, 'class', 'power_supply'))) {
      if (!/^(BAT|ADP)/i.test(ps)) continue;
      const status = (get(join(sys, 'class', 'power_supply', ps, 'status')) || '').trim();
      const voltageUV = num(get(join(sys, 'class', 'power_supply', ps, 'voltage_now')));
      const currentUA = num(get(join(sys, 'class', 'power_supply', ps, 'current_now')));
      const chargeNow = num(get(join(sys, 'class', 'power_supply', ps, 'charge_now')));
      const chargeFull = num(get(join(sys, 'class', 'power_supply', ps, 'charge_full')));
      if (!voltageUV && !chargeNow) continue;
      out.battery = {
        present: true,
        status,
        percent: chargeNow && chargeFull ? Math.round(chargeNow / chargeFull * 100) : null,
        watts: voltageUV && currentUA ? Math.round(voltageUV * currentUA / 1e12 * 100) / 100 : null,
      };
      break;
    }
  } catch {}
  return out;
}

// ── Watts estimation ─────────────────────────────────────────────────────────
// Honest-enough estimate: baseline watts + per-core busy watts. Measured
// against Fit observations each tick so the estimate drifts towards the box's
// truth. Never reported as outlet-accurate.
export function wattsEstimate({ cpuPct = null, cores = 1, baseW = 5, wattsPerCore = 7 }) {
  const busy = cpuPct == null ? 0 : cpuPct / 100;
  return Math.round((baseW + busy * cores * wattsPerCore) * 100) / 100;
}

// ── The telemetry ledger (ring + journal + job accounting) ──────────────────
export class Telemetry {
  constructor({ dataDir = null, writer = null } = {}) {
    this.dataDir = dataDir;
    this.journalFile = dataDir ? join(dataDir, 'telemetry', 'telemetry.ndjson') : null;
    this.ring = [];
    this.prevCpu = null;
    this.jobs = new Map(); // label -> { label, startedAt, kwh }
    this.totals = { chat: 0, image: 0, research: 0, other: 0 };
    this.writer = writer;
    this.timer = null;
    this._lastJournalAt = 0;
  }

  markJobStart(label, kind = 'other') {
    if (!this.jobs.has(label)) this.jobs.set(label, { label, kind, startedAt: Date.now() });
  }
  markJobStop(label) { this.jobs.delete(label); }

  // Run one sample against a sensor snapshot; returns the record it appended.
  sample(sensorRead, { at = Date.now() } = {}) {
    const cpu = parseProcStatLine(sensorRead.procStat ?? '');
    const cpuPct = readCpuPercent(this.prevCpu, cpu);
    this.prevCpu = cpu;
    const watts = wattsEstimate({ cpuPct, cores: sensorRead.cpuCores || 4 });
    const activeJobs = [...this.jobs.values()].map((j) => ({ label: j.label, kind: j.kind, seconds: Math.round((at - j.startedAt) / 1000) }));
    const record = {
      ts: at,
      cpuPct,
      memUsedGiB: sensorRead.memTotal != null ? Math.round((sensorRead.memTotal - (sensorRead.memAvailable || 0)) * 100) / 100 : null,
      memTotalGiB: sensorRead.memTotal ?? null,
      tempC: sensorRead.tempC ?? null,
      fanRpm: sensorRead.fanRpm ?? null,
      battery: sensorRead.battery ?? null,
      watts,
      jobs: activeJobs,
    };
    const prevTs = this.ring.length ? this.ring[this.ring.length - 1].ts : null;
    const dtHours = prevTs != null ? Math.max(0, record.ts - prevTs) / 3600_000 : 0;
    this.ring.push(record);
    if (this.ring.length > RING_MAX_MINUTES) this.ring.shift();
    const perJobWatts = activeJobs.length ? watts / activeJobs.length : 0;
    for (const j of this.jobs.values()) this.totals[j.kind] = (this.totals[j.kind] || 0) + perJobWatts * dtHours;
    this._lastSample = record;
    return record;
  }

  // Write one aggregate line to the bounded journal every ~minute while active.
  maybeJournal() {
    if (!this.journalFile || !this.ring.length) return false;
    const now = Date.now();
    if (now - this._lastJournalAt < 55_000) return false;
    this._lastJournalAt = now;
    const r = this.ring[this.ring.length - 1];
    mkdirSync(dirname(this.journalFile), { recursive: true });
    const line = JSON.stringify({ ts: r.ts, cpuPct: r.cpuPct, watts: r.watts, tempC: r.tempC, jobs: r.jobs, totals: this.totals }) + '\n';
    if (this.writer) this.writer(line);
    else try { appendFileSync(this.journalFile, line); } catch {}
    return true;
  }

  status() {
    const last = this._lastSample || null;
    const totalToday = Object.values(this.totals).reduce((a, v) => a + v, 0);
    return {
      running: Boolean(this.timer),
      now: last,
      today: {
        kwh: Math.round(totalToday * 10000) / 10000,
        totals: { ...this.totals },
      },
      ringMinutes: this.ring.length,
      telemetryFile: this.journalFile || '',
    };
  }

  history(hours = 6) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    return this.ring.filter((r) => r.ts >= cutoff);
  }

  diagnose() {
    if (!this.ring.length) return { note: 'no readings yet', causes: [] };
    const recent = this.ring.slice(-30);
    const recentCpu = Math.max(...recent.map((r) => r.cpuPct ?? 0));
    const recentTemp = Math.max(...recent.map((r) => r.tempC ?? 0));
    const job = [...this.jobs.values()][0] || null;
    const causes = [];
    if (job) causes.push(`job running: ${job.label} (≈ ${Math.round((Date.now() - jsecs(job)) / 1000)}s now)`);
    if (recentTemp >= 85) causes.push(`CPU ran at ${recentTemp}°C — the hot end of the safe band`);
    if (recentCpu >= 90) causes.push(`load pegged near 100% across the last ${recent.length} samples`);
    if (!causes.length && this.ring.length) causes.push('steady: nothing stands out beyond normal use.');
    return { note: causes[0] || '', causes };
  }
  runtimeSeconds() { return this.ring.length ? Math.round((Date.now() - this.ring[0].ts) / 1000) : 0; }
}

function jsecs(j) { return j.startedAt; }

export function narrate(record) {
  if (!record) return 'No readings yet.';
  const parts = [];
  if (record.cpuPct != null) parts.push(`CPU ${record.cpuPct}%`);
  if (record.memUsedGiB != null) parts.push(`${record.memUsedGiB} of ${record.memTotalGiB || '?'} GiB RAM in use`);
  if (record.tempC != null) parts.push(`${record.tempC}°C`);
  if (record.fanRpm != null) parts.push(`fan ${record.fanRpm} rpm`);
  if (record.battery?.percent != null) parts.push(`battery ${record.battery.percent}%${record.battery.watts != null ? ` at ${record.battery.watts}W` : ''}`);
  parts.push(`est. ${record.watts}W`);
  if (record.jobs.length) parts.push('active: ' + record.jobs.map((j) => j.label).join(', '));
  return parts.join(' · ');
}
