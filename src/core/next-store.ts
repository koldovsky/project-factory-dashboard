// Adapter for a project-factory-next run store (`factory run --store STORE`).
// Layout (src/store.mjs, src/runner.mjs): STORE/<runId>/run.json, lock.json while owned,
// attempt-N/builder.json (agent runs), attempt-N/evidence.json, attempt-N/<check>/stdout.log …
import fs from 'node:fs';
import path from 'node:path';
import type { AgentUsage, GateResult, GateStatus, Outcome, RunSummary, TimelineEvent } from './types.ts';
import { analyzeBuilder, type BuilderRecord } from './builder.ts';
import { PriceTable, sumCosts } from './pricing.ts';
import { digestJson, sha256, treeManifest } from './hash.ts';

interface HistoryEvent {
  sequence: number;
  at: string;
  state: string;
  details: Record<string, unknown>;
  previous: string | null;
  digest: string;
}

interface RunFile {
  schemaVersion: number;
  id: string;
  policyDigest: string;
  candidateDir: string;
  agent: string;
  executionSpec: Record<string, unknown> & { model?: string | null; maxBudgetUsd?: number | null };
  executionDigest: string;
  state: string;
  attempt: number;
  history: HistoryEvent[];
  releaseAuthorized: boolean;
  candidateDigest?: string;
  evidencePath?: string;
  evidenceDigest?: string;
  attemptManifest?: { files: Record<string, string>; digest: string };
}

export interface CheckResult {
  id: string;
  status: string;
  reason?: string;
  cases?: { id: string; status: string; details?: unknown }[];
  durationMs?: number;
  exitCode?: number | null;
  artifacts?: Record<string, string>;
}

export interface Evidence {
  runId: string;
  attempt: number;
  taskId: string;
  status: string;
  completedAt: string;
  preparation?: { id: string; status: string; durationMs?: number; reason?: string; exitCode?: number | null }[];
  checks: CheckResult[];
  candidateDigest?: string;
  policyDigest?: string;
}

const TERMINAL = new Set(['passed', 'failed']);

export const checkStatus = (raw: string): GateStatus =>
  raw === 'passed' ? 'pass' : raw === 'failed' ? 'fail' : raw === 'blocked' ? 'blocked' : 'unknown';

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));

function pidAlive(pid: unknown): boolean | null {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return null;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' ? true : false; }
}

/** Re-runs the integrity checks of src/store.mjs readRun() and runner.mjs inspectRun(). */
export function verifyRun(dir: string, run: RunFile): string[] {
  const issues: string[] = [];
  if (run.schemaVersion !== 1) issues.push(`Unsupported schemaVersion ${run.schemaVersion}`);
  if (run.releaseAuthorized !== false) issues.push('Run claims release authorization (a delivery run never may)');
  if (!Array.isArray(run.history) || !run.history.length) return [...issues, 'Run has no history'];
  if (run.executionSpec && digestJson(run.executionSpec) !== run.executionDigest) issues.push('Execution specification digest mismatch');
  if (run.history[0]?.details?.executionDigest !== run.executionDigest) issues.push('Execution specification/history mismatch');
  let previous: string | null = null;
  run.history.forEach((entry, index) => {
    const { digest, ...event } = entry;
    if (event.sequence !== index + 1) issues.push(`History event ${index + 1}: sequence out of order`);
    if (event.previous !== previous) issues.push(`History event ${index + 1}: broken hash link`);
    if (digestJson(event) !== digest) issues.push(`History event ${index + 1} (${event.state}): digest mismatch — history was edited`);
    previous = digest;
  });
  if (run.state !== run.history.at(-1)?.state) issues.push('Run state does not match the last history event');
  if (run.state === 'passed' && (!run.evidencePath || !/^[a-f0-9]{64}$/.test(run.evidenceDigest ?? '') || !run.attemptManifest)) {
    issues.push('Passed run lacks complete verified evidence');
  }
  if (run.evidencePath) {
    const evidenceFile = path.join(dir, run.evidencePath);
    if (!fs.existsSync(evidenceFile)) issues.push(`Evidence file missing: ${run.evidencePath}`);
    else {
      if (sha256(fs.readFileSync(evidenceFile)) !== run.evidenceDigest) issues.push('Evidence report changed since verification');
      try {
        if (treeManifest(path.dirname(evidenceFile)).digest !== run.attemptManifest?.digest) issues.push('Evidence artifacts changed since verification');
      } catch (error) { issues.push((error as Error).message); }
      try {
        const evidence = readJson<Evidence>(evidenceFile);
        if (evidence.runId !== run.id || evidence.candidateDigest !== run.candidateDigest || evidence.policyDigest !== run.policyDigest) {
          issues.push('Evidence report/run identity mismatch');
        }
        if (run.state === 'passed' && evidence.status !== 'passed') issues.push('Run passed but its evidence did not');
      } catch { issues.push('Evidence report is not valid JSON'); }
    }
  }
  return issues;
}

function gatesFromEvidence(evidence: Evidence, dependsOn: Record<string, string[]>): GateResult[] {
  const gates: GateResult[] = [];
  for (const step of evidence.preparation ?? []) {
    gates.push({ id: `preparation:${step.id}`, label: `prep ${step.id}`, status: checkStatus(step.status), raw: step.status,
      detail: step.reason, durationMs: step.durationMs ?? null });
  }
  for (const check of evidence.checks ?? []) {
    gates.push({
      id: check.id, label: check.id, status: checkStatus(check.status), raw: check.status,
      detail: check.reason ?? check.cases?.filter(c => c.status !== 'passed').map(c => c.id).join(', '),
      durationMs: check.durationMs ?? null, dependsOn: dependsOn[check.id],
      cases: check.cases?.map(c => ({ id: c.id, status: c.status, details: c.details === undefined ? undefined : typeof c.details === 'string' ? c.details : JSON.stringify(c.details) })),
    });
  }
  return gates;
}

export interface NextStoreOptions {
  prices: PriceTable;
  /** checkId → dependsOn, per task id (from the control bundle) for labelling blocked consumers. */
  dependsOn?: Record<string, Record<string, string[]>>;
  sourceName: string;
}

export function readNextRun(dir: string, options: NextStoreOptions): RunSummary {
  const id = path.basename(dir);
  const key = `${options.sourceName}:${id}`;
  let run: RunFile;
  try { run = readJson<RunFile>(path.join(dir, 'run.json')); }
  catch (error) {
    return {
      key, id, source: options.sourceName, factory: 'next', kind: 'delivery', title: id, feature: null, state: 'unreadable',
      outcome: 'unknown', startedAt: null, endedAt: null, durationMs: null, agent: null, model: null, attempts: null,
      running: false, runningBasis: null, integrity: { ok: false, issues: [`run.json unreadable: ${(error as Error).message}`] },
      gates: [], cost: { usd: null, provenance: 'unknown', tokens: null }, agents: [], events: [], failure: 'run.json unreadable',
    };
  }
  const issues = verifyRun(dir, run);
  const history = Array.isArray(run.history) ? run.history : [];
  const taskId = (history[0]?.details?.taskId as string | undefined) ?? null;
  const lockFile = path.join(dir, 'lock.json');
  let running = false;
  let runningBasis: string | null = null;
  let staleLock = false;
  if (fs.existsSync(lockFile)) {
    let pid: unknown;
    try { pid = readJson<{ pid: number }>(lockFile).pid; } catch { /* malformed lock */ }
    const alive = pidAlive(pid);
    if (alive && !TERMINAL.has(run.state)) { running = true; runningBasis = `lock.json held by live pid ${pid}`; }
    else if (!TERMINAL.has(run.state) || alive === false) { staleLock = true; runningBasis = `lock.json left by pid ${pid ?? '?'} (not alive): run needs \`factory recover\``; }
  }

  const events: TimelineEvent[] = [];
  const agents: AgentUsage[] = [];
  const builderCosts = [];
  let lastEvidence: Evidence | null = null;
  const model = run.executionSpec?.model ?? null;
  const dependsOn = (taskId && options.dependsOn?.[taskId]) || {};

  for (const entry of history) {
    const details = entry.details ?? {};
    const attempt = typeof details.attempt === 'number' ? details.attempt : undefined;
    const detailText = [details.reason, Array.isArray(details.failedChecks) && details.failedChecks.length ? `failed: ${details.failedChecks.join(', ')}` : null]
      .filter(Boolean).join(' · ');
    const transitionEvent: TimelineEvent = { at: entry.at, kind: 'transition', role: 'controller', actor: 'controller', title: entry.state, detail: detailText || undefined, status: entry.state, attempt };
    const verdict = (entry.state === 'passed' || entry.state === 'attempt-failed') && attempt;
    // A verdict transition follows the checks that produced it; every other transition precedes its work.
    if (!verdict) events.push(transitionEvent);

    if (entry.state === 'building' && attempt) {
      const attemptDir = path.join(dir, `attempt-${attempt}`);
      const builderFile = path.join(attemptDir, 'builder.json');
      if (run.agent === 'manual') {
        events.push({ at: entry.at, kind: 'builder', role: 'human', actor: 'manual', title: 'Manual candidate (no agent invoked)', attempt });
      } else if (fs.existsSync(builderFile)) {
        let record: BuilderRecord = {};
        try { record = readJson<BuilderRecord>(builderFile); } catch { issues.push(`attempt-${attempt}/builder.json unreadable`); }
        const analysis = analyzeBuilder(record, options.prices, model);
        builderCosts.push(analysis.cost);
        agents.push({ id: `${id}#${attempt}`, label: `${run.agent} maker · attempt ${attempt}`, role: 'maker', model: analysis.model,
          cost: analysis.cost, toolCalls: analysis.toolCalls, durationMs: record.durationMs ?? null, state: record.status ?? null });
        events.push({ at: entry.at, kind: 'builder', role: 'maker', actor: run.agent, attempt,
          title: `${run.agent} ${record.status ?? 'unknown'}${analysis.turns ? ` · ${analysis.turns} turns` : ''}`,
          detail: [analysis.resultText?.slice(0, 300), record.error, ...analysis.warnings].filter(Boolean).join(' · ') || undefined,
          status: record.status, durationMs: record.durationMs ?? null });
        for (const step of analysis.steps) events.push({ ...step, at: entry.at, role: 'maker', actor: run.agent, attempt });
      } else if (TERMINAL.has(run.state) || history.some(h => h.sequence > entry.sequence)) {
        builderCosts.push({ usd: null, provenance: 'unknown' as const, tokens: null, note: 'builder.json missing' });
        events.push({ at: entry.at, kind: 'builder', role: 'maker', actor: run.agent, attempt, title: 'builder.json missing', status: 'unknown' });
      } else {
        events.push({ at: entry.at, kind: 'builder', role: 'maker', actor: run.agent, attempt, title: `${run.agent} building…`, status: 'running' });
      }
    }

    let evidence: Evidence | null = null;
    const evidenceFile = path.join(dir, `attempt-${attempt}`, 'evidence.json');
    if (verdict && fs.existsSync(evidenceFile)) {
      try { evidence = readJson<Evidence>(evidenceFile); } catch { issues.push(`attempt-${attempt}/evidence.json unreadable`); }
    }
    if (evidence) {
      lastEvidence = evidence;
      for (const step of evidence.preparation ?? []) {
        events.push({ at: evidence.completedAt, kind: 'preparation', role: 'controller', actor: `prep:${step.id}`, attempt,
          title: `preparation ${step.id}`, status: step.status, detail: step.reason, durationMs: step.durationMs ?? null });
      }
      for (const check of evidence.checks ?? []) {
        const failedCases = check.cases?.filter(c => c.status !== 'passed') ?? [];
        events.push({ at: evidence.completedAt, kind: 'check', role: 'checker', actor: check.id, attempt,
          title: `${check.id}: ${check.status}${check.cases ? ` (${check.cases.length - failedCases.length}/${check.cases.length} cases)` : ''}`,
          status: check.status, durationMs: check.durationMs ?? null,
          detail: check.reason ?? (failedCases.map(c => `${c.id}: ${typeof c.details === 'string' ? c.details.split('\n')[0] : c.status}`).join(' · ') || undefined) });
      }
    }
    if (verdict) events.push(transitionEvent);
  }

  const terminal = history.findLast(h => TERMINAL.has(h.state) || h.state === 'interrupted');
  const startedAt = history[0]?.at ?? null;
  const endedAt = TERMINAL.has(run.state) || run.state === 'interrupted' ? terminal?.at ?? null : null;
  const outcome: Outcome = running ? 'running' : staleLock ? 'stale-lock' : run.state === 'passed' ? 'accepted'
    : run.state === 'failed' ? 'rejected' : run.state === 'interrupted' ? 'interrupted' : 'unknown';

  let failure: string | null = null;
  if (run.state !== 'passed') {
    // The cause lives on the last attempt-failed / interrupted event; `failed` only says the budget ran out.
    const reasonEvent = history.findLast(h => h.state === 'attempt-failed' || h.state === 'interrupted');
    const failedChecks = (reasonEvent?.details?.failedChecks as string[] | undefined) ?? [];
    const firstCase = lastEvidence?.checks?.flatMap(c => (c.cases ?? []).filter(x => x.status === 'failed').map(x => `${c.id}/${x.id}: ${typeof x.details === 'string' ? x.details.split('\n')[0] : 'failed'}`))[0];
    const checkReason = lastEvidence?.checks?.find(c => c.status === 'failed' && c.reason)?.reason;
    failure = [failedChecks.length ? `Failed checks: ${failedChecks.join(', ')}` : null, checkReason, firstCase,
      reasonEvent?.details?.reason as string | undefined].filter(Boolean).join(' — ') || null;
  }
  // While a new attempt evaluates, run.candidateDigest already names the new candidate but the
  // evidence pointer still refers to the previous attempt; the factory's inspect has the same window.
  if (running) {
    const transient = issues.indexOf('Evidence report/run identity mismatch');
    if (transient >= 0) issues.splice(transient, 1);
  }

  const cost = run.agent === 'manual'
    ? { usd: 0, provenance: 'reported' as const, tokens: null, note: 'Manual candidate: no model was invoked' }
    : sumCosts(builderCosts);

  return {
    key, id, source: options.sourceName, factory: 'next', kind: 'delivery', title: taskId ? `${taskId}` : id, feature: taskId,
    state: run.state, outcome, startedAt, endedAt,
    durationMs: startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : startedAt && running ? Date.now() - Date.parse(startedAt) : null,
    agent: run.agent, model: model ?? agents.find(a => a.model)?.model ?? null, attempts: run.attempt, running, runningBasis,
    integrity: { ok: issues.length === 0, issues }, gates: lastEvidence ? gatesFromEvidence(lastEvidence, dependsOn) : [],
    cost, agents, events, failure,
  };
}

export function readNextStore(store: string, options: NextStoreOptions): { runs: RunSummary[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!fs.existsSync(store)) return { runs: [], warnings: [`Run store not found: ${store}`] };
  const runs: RunSummary[] = [];
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(store, entry.name);
    if (!fs.existsSync(path.join(dir, 'run.json'))) continue;
    runs.push(readNextRun(dir, options));
  }
  return { runs, warnings };
}

export { type RunFile, type HistoryEvent };
