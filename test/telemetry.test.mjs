import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseProcStatLine, parseProcMeminfo, readCpuPercent, readLinuxSensors,
  wattsEstimate, narrate, Telemetry, SAMPLE_IDLE_MS,
} from '../lib/telemetry.mjs';

function fixtureTree(t, { memoryOver = false, withBattery = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capsule-telemetry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sys = join(root, 'sys');
  const proc = join(root, 'proc');
  mkdirSync(proc, { recursive: true });
  mkdirSync(join(sys, 'class', 'thermal', 'thermal_zone0'), { recursive: true });
  mkdirSync(join(sys, 'class', 'hwmon', 'hwmon0'), { recursive: true });
  mkdirSync(join(sys, 'class', 'power_supply', 'BAT0'), { recursive: true });

  writeFileSync(join(root, 'proc', 'stat'), 'cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0\ncpu0 10132153 290696 3084719 46828483 16683 0 25195 0 0 0\n');
  writeFileSync(join(root, 'proc', 'meminfo'), `MemTotal:       16384 kB\nMemFree:        ${memoryOver ? 480 : 4800} kB\nMemAvailable:   ${memoryOver ? 995 : 9950} kB\n`);
  writeFileSync(join(root, 'proc', 'loadavg'), '2.31 1.87 1.42 2/310 7227\n');
  writeFileSync(join(root, 'proc', 'cpuinfo'), 'processor : 0\n\nprocessor : 1\n\nprocessor : 2\n\nprocessor : 3\n');
  writeFileSync(join(root, 'sys', 'class', 'thermal', 'thermal_zone0', 'temp'), '54123');
  writeFileSync(join(root, 'sys', 'class', 'hwmon', 'hwmon0', 'fan1_input'), '2450');
  if (withBattery) {
    writeFileSync(join(root, 'sys', 'class', 'power_supply', 'BAT0', 'status'), 'Discharging');
    writeFileSync(join(root, 'sys', 'class', 'power_supply', 'BAT0', 'voltage_now'), '15750000');
    writeFileSync(join(root, 'sys', 'class', 'power_supply', 'BAT0', 'current_now'), '650000');
    writeFileSync(join(root, 'sys', 'class', 'power_supply', 'BAT0', 'charge_now'), '1800');
    writeFileSync(join(root, 'sys', 'class', 'power_supply', 'BAT0', 'charge_full'), '2200');
  }
  return { root, proc, sys };
}

test('proc/stat parses and cpu% computes across two samples', (t) => {
  const { root } = fixtureTree(t);
  const a = parseProcStatLine(readFileSync(join(root, 'proc', 'stat'), 'utf8'));
  writeFileSync(join(root, 'proc', 'stat'), 'cpu  10132253 290696 3084819 46828483+100 16683 0 25195 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\n'.replace('46828483+100', '46828583'));
  const b = parseProcStatLine(readFileSync(join(root, 'proc', 'stat'), 'utf8'));
  // user +100, system +100, idle +100 → busy 200 of 300
  assert.equal(readCpuPercent(a, b), 67);
});

test('meminfo parses and battery + fan + thermal read cleanly on the fixture tree', (t) => {
  const { root, sys, proc } = fixtureTree(t, { withBattery: true });
  const mem = parseProcMeminfo(readFileSync(join(root, 'proc', 'meminfo'), 'utf8'));
  assert.equal(mem.MemTotal, 16384);
  const sensors = readLinuxSensors({ sys, proc });
  assert.equal(sensors.tempC, 54);
  assert.equal(sensors.fanRpm, 2450);
  assert.equal(sensors.cpuCores, 4);
  assert.equal(sensors.battery.percent, 82);
  assert.equal(sensors.battery.watts, Math.round(15750000 * 650000 / 1e12 * 100) / 100);
  assert.equal(sensors.battery.status, 'Discharging');
});

test('readLinuxSensors degrades to nulls on a bare tree instead of crashing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-telemetry-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sensors = readLinuxSensors({ sys: join(root, 'sys'), proc: join(root, 'proc') });
  assert.equal(sensors.tempC, null);
  assert.equal(sensors.fanRpm, null);
  assert.equal(sensors.battery, null);
});

test('wattsEstimate adds core-second watts over the baseline honestly', () => {
  assert.equal(wattsEstimate({ cpuPct: 50, cores: 8 }), Math.round((5 + 0.5 * 8 * 7) * 100) / 100);
  assert.ok(wattsEstimate({ cpuPct: null, cores: 8 }) >= 5, 'no-signal case behaves like idle');
});

test('Telemetry ring caps and job attribution adds up while jobs run', () => {
  const tele = new Telemetry();
  let now = 1000;
  const reading = { procStat: 'cpu  100 0 0 800 0 0 0 0 0 0', cpuCores: 4, memTotal: 16, memAvailable: 8, tempC: 50 };
  tele.sample(reading, { at: now });
  now += 1000;
  tele.markJobStart('ollama qwen', 'chat');
  tele.sample({ ...reading, procStat: 'cpu  160 0 0 800 0 0 0 0 0 0' }, { at: now }); // 60 ms cpu of 100 — busy
  now += 60000;
  tele.sample({ ...reading, procStat: 'cpu  360 0 0 800 0 0 0 0 0 0' }, { at: now });
  tele.markJobStop('ollama qwen');
  const final = tele.sample({ ...reading, procStat: 'cpu  380 0 0 800 0 0 0 0 0 0' }, { at: now + 1000 });
  assert.ok(tele.status().today.totals.chat > 0, 'chat energy accrues while a job is marked');
  assert.equal(final.jobs.length, 0, 'stopping a job clears it from active listing');
  assert.equal(tele.status().ringMinutes, 4);
});

test('two concurrent jobs split the watts share, not double-counted', () => {
  const tele = new Telemetry();
  let now = 1000;
  const reading = { procStat: 'cpu  100 0 0 800 0 0 0 0 0 0', cpuCores: 4, memTotal: 16, memAvailable: 8 };
  tele.sample(reading, { at: now });
  tele.markJobStart('chat', 'chat');
  tele.markJobStart('image', 'image');
  now += 60000;
  tele.sample({ ...reading, procStat: 'cpu  300 0 0 800 0 0 0 0 0 0' }, { at: now });
  const t = tele.status().today.totals;
  assert.ok(t.chat > 0 && t.image > 0);
  assert.ok(Math.abs(t.chat - t.image) < 1e-9, 'two jobs split the estimate evenly');
});

test('maybeJournal writes one bounded line on its own cadence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-telemetry-journal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'telemetry', 'telemetry.ndjson');
  const tele = new Telemetry(); tele.journalFile = file; tele._lastJournalAt = 0;
  const reading = { procStat: 'cpu  100 0 0 800 0 0 0 0 0 0', cpuCores: 4, memTotal: 16, memAvailable: 8 };
  tele.sample(reading, { at: Date.now() - 60_000 });
  assert.equal(tele.maybeJournal(), true);
  assert.equal(tele.maybeJournal(), false, 'second call within the minute is a no-op');
  const line = readFileSync(file, 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.ok(parsed.ts && parsed.watts != null, 'journal line carries ts and watts');
});

test('narrate composes the one-line machine digest with graceful null fields', () => {
  assert.equal(narrate(null), 'No readings yet.');
  const crafted = { cpuPct: 55, memUsedGiB: 7.1, memTotalGiB: 16, tempC: 54, fanRpm: 2450, battery: { percent: 63, watts: 8.24 }, watts: 33, jobs: [{ label: 'image:sd-1.5', kind: 'image', seconds: 95 }] };
  const line = narrate(crafted);
  for (const piece of ['CPU 55%', '7.1', '54°C', '2450 rpm', '63%', '33W', 'image:sd-1.5']) assert.ok(line.includes(piece), line);
});

test('diagnose points at the biggest story for the last few minutes', () => {
  const tele = new Telemetry();
  let at = Date.now() - 30_000;
  const reading = { procStat: 'cpu  100 0 0 900 0 0 0 0 0 0', cpuCores: 4, memTotal: 16, memAvailable: 8 };
  tele.sample(reading, { at });
  assert.match(tele.diagnose().note, /nothing|steady/i);
});