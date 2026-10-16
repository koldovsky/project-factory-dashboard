// Simulates a live project-factory-next controller writing into the demo run store, so "Running now"
// and the live timeline can be shown without spending on a real agent:
//   node scripts/simulate-run.ts [--store .demo/next/runs] [--step-seconds 12]
// It holds lock.json with its own pid (exactly as src/store.mjs acquireRun does) and releases it at the end.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeJsonStdout, writeNextRun, type RunSpec } from '../src/demo/builders.ts';

const { values } = parseArgs({ options: { store: { type: 'string' }, 'step-seconds': { type: 'string' } } });
const store = path.resolve(values.store ?? '.demo/next/runs');
const step = Number(values['step-seconds'] ?? 12) * 1000;
const id = `live-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
const start = new Date();
const builder = (costUsd: number, result: string) => ({ status: 'completed', exitCode: 0, durationMs: step, stderr: '', truncated: false,
  stdout: claudeJsonStdout({ costUsd, model: 'claude-sonnet-5-5', turns: 8, result, input: 1800, output: 5000, cacheWrite: 9000, cacheRead: 260000 }) });
const failing = { builder: builder(0.36, 'First pass at the rate limiter.'), checks: [
  { id: 'build', status: 'passed', cases: [{ id: 'tsc', status: 'passed' }], durationMs: 3900, exitCode: 0 },
  { id: 'behavior', status: 'failed', cases: [{ id: 'burst', status: 'passed' }, { id: 'window-reset', status: 'failed', details: 'Window did not reset after 60 s' }, { id: 'restart', status: 'passed' }], durationMs: 4100, exitCode: 1 }] };
const passing = { builder: builder(0.22, 'Reset the window on the minute boundary.'), checks: [
  { id: 'build', status: 'passed', cases: [{ id: 'tsc', status: 'passed' }], durationMs: 3800, exitCode: 0 },
  { id: 'behavior', status: 'passed', cases: [{ id: 'burst', status: 'passed' }, { id: 'window-reset', status: 'passed' }, { id: 'restart', status: 'passed' }], durationMs: 4300, exitCode: 0 }] };

const frames: Omit<RunSpec, 'id' | 'taskId' | 'agent' | 'model' | 'start' | 'stepMs'>[] = [
  { attempts: [{}], final: null, inProgress: 'building', lockPid: process.pid },
  { attempts: [failing.builder ? { builder: failing.builder } : {}], final: null, inProgress: 'evaluating', lockPid: process.pid },
  { attempts: [failing, {}], final: null, inProgress: 'building', lockPid: process.pid },
  { attempts: [failing, { builder: passing.builder }], final: null, inProgress: 'evaluating', lockPid: process.pid },
  { attempts: [failing, passing], final: 'passed' },
];
console.log(`Simulating run ${id} in ${store} (pid ${process.pid}); one transition every ${step / 1000}s`);
for (const [i, frame] of frames.entries()) {
  fs.rmSync(path.join(store, id), { recursive: true, force: true });
  writeNextRun(store, { id, taskId: 'rate-limit', agent: 'claude', model: 'claude-sonnet-5-5', start, stepMs: step, ...frame });
  console.log(`  ${i + 1}/${frames.length}: ${frame.final ?? frame.inProgress} (attempt ${frame.attempts.length})`);
  if (i < frames.length - 1) await sleep(step);
}
console.log('Run passed; lock released.');
