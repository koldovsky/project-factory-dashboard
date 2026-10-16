import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeBuilder } from '../src/core/builder.ts';
import { readNextRun, readNextStore } from '../src/core/next-store.ts';
import { readTask, traceForTask, dependsOnMap } from '../src/core/next-control.ts';
import { PriceTable } from '../src/core/pricing.ts';
import { claudeJsonStdout, writeNextRun } from '../src/demo/builders.ts';

const prices = new PriceTable();
const opts = { prices, sourceName: 'test' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-next-'));
const start = new Date('2026-10-01T09:00:00.000Z');
const pass = (id: string) => ({ id, status: 'passed', cases: [{ id: `${id}-1`, status: 'passed' }], durationMs: 100, exitCode: 0 });

describe('real project-factory-next run store (factory-handbook-lab)', () => {
  const store = path.join(import.meta.dirname, 'fixtures', 'real-next-store');
  const task = readTask(path.join(import.meta.dirname, 'fixtures', 'real-control'));
  const { runs } = readNextStore(store, { ...opts, dependsOn: { [task.id]: dependsOnMap(task) } });

  it('re-verifies the hash chain and evidence digests the factory wrote', () => {
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.integrity).toEqual({ ok: true, issues: [] });
  });

  it('maps passed/failed runs to accepted/rejected with case-level failure reasons', () => {
    const accepted = runs.find(r => r.id === 'accepted-example')!;
    const rejected = runs.find(r => r.id === 'rejected-example')!;
    expect(accepted.outcome).toBe('accepted');
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.failure).toContain('behavior');
    expect(rejected.failure).toContain('spaces');
    expect(rejected.gates[0]).toMatchObject({ id: 'behavior', status: 'fail' });
    expect(rejected.gates[0].cases?.filter(c => c.status === 'failed').map(c => c.id)).toEqual(['spaces', 'punctuation']);
  });

  it('reports manual runs as zero agent spend, explicitly', () => {
    expect(runs[0].cost).toMatchObject({ usd: 0, provenance: 'reported' });
    expect(runs[0].cost.note).toMatch(/Manual/);
  });

  it('traces requirements to checks and cases from the newest evidence', () => {
    const trace = traceForTask(task, runs, 'test');
    expect(trace.requirements.map(r => r.id)).toEqual(['R1', 'R2']);
    // Both requirements are proven by "behavior"; its newest run is the rejected one.
    expect(trace.requirements.every(r => ['pass', 'fail'].includes(r.status))).toBe(true);
    expect(trace.requirements[0].links.some(l => l.kind === 'case')).toBe(true);
  });
});

// Captured from a real `factory run --agent claude --model claude-sonnet-5-5 --max-budget-usd 0.5` (claude CLI 2.1.296).
// Only run.json candidateDir is sanitized: it sits outside every digest, while attempt-1/ is covered by attemptManifest.
describe('real claude agent run store (claude --print --output-format json)', () => {
  const store = path.join(import.meta.dirname, 'fixtures', 'real-claude-store');
  const builderFile = path.join(store, 'claude-agent-example', 'attempt-1', 'builder.json');
  const record = JSON.parse(fs.readFileSync(builderFile, 'utf8'));
  const result = JSON.parse(record.stdout);
  const task = readTask(path.join(import.meta.dirname, 'fixtures', 'real-control'));
  const { runs } = readNextStore(store, { ...opts, dependsOn: { [task.id]: dependsOnMap(task) } });
  const run = runs[0];

  it('parses the captured CLI result as claude-json with the reported cost and dominant model', () => {
    const a = analyzeBuilder(record, prices, 'claude-sonnet-5-5');
    expect(a.format).toBe('claude-json');
    expect(a.cost.provenance).toBe('reported');
    expect(a.cost.usd).toBe(result.total_cost_usd);
    expect(a.cost.tokens).toEqual({ input: result.usage.input_tokens, output: result.usage.output_tokens,
      cacheWrite: result.usage.cache_creation_input_tokens, cacheRead: result.usage.cache_read_input_tokens });
    expect(a.model).toBe('claude-sonnet-5-5');
    expect(a.turns).toBe(result.num_turns);
    expect(a.sessionId).toBe(result.session_id);
    expect(a.resultText).toBe(result.result);
    // The json output format carries no tool events: tool calls are unknown, not zero.
    expect(a.toolCalls).toBeNull();
    expect(a.steps).toEqual([]);
    expect(a.warnings).toEqual([]);
  });

  it('verifies the real agent run and attributes its spend to the maker', () => {
    expect(runs).toHaveLength(1);
    expect(run.integrity).toEqual({ ok: true, issues: [] });
    expect(run).toMatchObject({ outcome: 'accepted', agent: 'claude', model: 'claude-sonnet-5-5', attempts: 1 });
    expect(run.cost).toMatchObject({ usd: result.total_cost_usd, provenance: 'reported' });
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({ role: 'maker', model: 'claude-sonnet-5-5', toolCalls: null, state: 'completed', durationMs: record.durationMs });
  });

  it('orders the timeline: build, agent result, evaluation, checks, verdict', () => {
    expect(run.events.map(e => `${e.kind}:${e.title}`)).toEqual([
      'transition:created', 'transition:building', `builder:claude completed · ${result.num_turns} turns`,
      'transition:evaluating', 'check:behavior: passed (4/4 cases)', 'transition:passed',
    ]);
  });
});

describe('integrity', () => {
  it('flags an edited history event (broken digest chain)', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'r1', taskId: 't', agent: 'manual', attempts: [{ checks: [pass('unit')] }], final: 'passed', start });
    const runFile = path.join(dir, 'run.json');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    run.history[1].details.agent = 'claude'; // rewrite who built it
    fs.writeFileSync(runFile, JSON.stringify(run));
    const summary = readNextRun(dir, opts);
    expect(summary.integrity.ok).toBe(false);
    expect(summary.integrity.issues.join(' ')).toMatch(/digest mismatch/);
  });

  it('never counts a tampered passed run as accepted, nor uses it for the trace chain', () => {
    const store = tmp();
    const good = writeNextRun(store, { id: 'good', taskId: 't', agent: 'manual', attempts: [{ checks: [{ id: 'unit', status: 'failed', cases: [{ id: 'u', status: 'failed' }] }] }], final: 'failed', start });
    const bad = writeNextRun(store, { id: 'bad', taskId: 't', agent: 'manual', attempts: [{ checks: [pass('unit')] }], final: 'passed', start: new Date(start.getTime() + 3_600_000) });
    const file = path.join(bad, 'run.json');
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.history[0].at = '2026-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(run));
    const runs = [readNextRun(good, opts), readNextRun(bad, opts)];
    expect(runs[1].outcome).toBe('unverified');
    const trace = traceForTask({ id: 't', title: 't', requirements: [{ id: 'R1', description: 'd', checkIds: ['unit'] }], checks: [{ id: 'unit', kind: 'command', dependsOn: [], expectedCases: ['u'] }] }, runs, 'test');
    expect(trace.title).toContain('run good');
    expect(trace.requirements[0].status).toBe('fail');
  });

  it('flags an evidence report changed after verification', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'r2', taskId: 't', agent: 'manual', attempts: [{ checks: [pass('unit')] }], final: 'passed', start });
    const evidence = path.join(dir, 'attempt-1', 'evidence.json');
    fs.writeFileSync(evidence, fs.readFileSync(evidence, 'utf8').replace('"passed"', '"passed" '));
    expect(readNextRun(dir, opts).integrity.issues).toContain('Evidence report changed since verification');
  });

  it('flags a missing evidence file instead of treating the run as healthy', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'r3', taskId: 't', agent: 'manual', attempts: [{ checks: [pass('unit')] }], final: 'passed', start });
    fs.rmSync(path.join(dir, 'attempt-1', 'evidence.json'));
    const summary = readNextRun(dir, opts);
    expect(summary.integrity.ok).toBe(false);
    expect(summary.integrity.issues.join(' ')).toMatch(/Evidence file missing/);
    expect(summary.gates).toEqual([]);
  });
});

describe('gates and failures', () => {
  it('keeps a blocked consumer distinct from pass and fail', () => {
    const store = tmp();
    const dir = writeNextRun(store, {
      id: 'blocked', taskId: 't', agent: 'manual', final: 'failed', start,
      attempts: [{ checks: [
        { id: 'build', status: 'failed', reason: 'tsc exited 2', durationMs: 900 },
        { id: 'visual', status: 'blocked', reason: 'A required producer/dependency did not pass' },
      ] }],
    });
    const summary = readNextRun(dir, { ...opts, dependsOn: { t: { visual: ['build'] } } });
    expect(summary.gates.map(g => [g.id, g.status])).toEqual([['build', 'fail'], ['visual', 'blocked']]);
    expect(summary.gates[1].dependsOn).toEqual(['build']);
    expect(summary.failure).toMatch(/Failed checks: build, visual/);
  });

  it('records a failed preparation step as the failure reason', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'prep', taskId: 't', agent: 'manual', final: 'failed', start,
      attempts: [{ preparation: [{ id: 'build', status: 'failed', durationMs: 3000, reason: 'Preparation process failed (exit 1)' }], checks: [pass('unit')] }] });
    const summary = readNextRun(dir, opts);
    expect(summary.gates[0]).toMatchObject({ id: 'preparation:build', status: 'fail' });
    expect(summary.failure).toMatch(/Preparation failed/);
    expect(summary.events.some(e => e.kind === 'check')).toBe(false);
  });
});

describe('agent runs: cost and liveness', () => {
  const builder = (costUsd: number) => ({ status: 'completed', exitCode: 0, durationMs: 60000, stderr: '', truncated: false,
    stdout: claudeJsonStdout({ costUsd, model: 'claude-sonnet-5-5', turns: 9, result: 'Implemented', input: 1000, output: 4000, cacheWrite: 2000, cacheRead: 50000 }) });

  it('sums reported cost across every attempt, including the failed one', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'agent', taskId: 't', agent: 'claude', model: 'claude-sonnet-5-5', final: 'passed', start, attempts: [
      { builder: builder(0.42), checks: [{ id: 'unit', status: 'failed', cases: [{ id: 'u1', status: 'failed', details: 'expected 2' }] }] },
      { builder: builder(0.31), checks: [pass('unit')] },
    ] });
    const summary = readNextRun(dir, opts);
    expect(summary.integrity.ok).toBe(true);
    expect(summary.cost.provenance).toBe('reported');
    expect(summary.cost.usd).toBeCloseTo(0.73, 6);
    expect(summary.agents.map(a => a.role)).toEqual(['maker', 'maker']);
    expect(summary.events.filter(e => e.role === 'checker')).toHaveLength(2);
    // A verdict transition is listed after the checks that produced it.
    const order = summary.events.filter(e => e.attempt === 1).map(e => e.kind === 'check' ? 'check' : e.title);
    expect(order.indexOf('check')).toBeLessThan(order.indexOf('attempt-failed'));
  });

  it('marks unknown cost when a builder timed out with no output (not zero)', () => {
    const store = tmp();
    const dir = writeNextRun(store, { id: 'timeout', taskId: 't', agent: 'claude', final: 'failed', start, attempts: [
      { builder: { status: 'timeout', exitCode: null, stdout: '', stderr: '', durationMs: 600000, truncated: false } },
    ] });
    const summary = readNextRun(dir, opts);
    expect(summary.cost.usd).toBeNull();
    expect(summary.failure).toMatch(/Builder timeout/);
  });

  it('treats a lock held by a live pid as running and a dead pid as a stale lock', () => {
    const store = tmp();
    const live = writeNextRun(store, { id: 'live', taskId: 't', agent: 'claude', final: null, inProgress: 'building', lockPid: process.pid, start, attempts: [{}] });
    const summary = readNextRun(live, opts);
    expect(summary.running).toBe(true);
    expect(summary.outcome).toBe('running');
    const dead = writeNextRun(store, { id: 'dead', taskId: 't', agent: 'claude', final: null, inProgress: 'building', lockPid: 2 ** 22 + 12345, start, attempts: [{}] });
    const stale = readNextRun(dead, opts);
    expect(stale.running).toBe(false);
    expect(stale.outcome).toBe('stale-lock');
    expect(stale.runningBasis).toMatch(/recover/);
  });
});
