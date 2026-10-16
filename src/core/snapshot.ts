import fs from 'node:fs';
import path from 'node:path';
import type { CostPerAccepted, DailyCost, RunSummary, Snapshot, SourceStatus } from './types.ts';
import { PriceTable, addTokens, emptyTokens, sumCosts, type ModelPrice } from './pricing.ts';
import { readNextStore } from './next-store.ts';
import { dependsOnMap, readExperiment, readTask, traceForTask, type TaskFile } from './next-control.ts';
import { archivedChanges, parseLedger, readGitTrailers, readReviewFindings, v2Trace } from './v2-project.ts';
import { TranscriptCache, defaultProjectsRoot, findTranscriptDirs, readClaudeProject } from './claude-code.ts';

export interface SourceConfig {
  name: string;
  kind: 'next-store' | 'v2-project';
  path: string;
  /** next-store: control bundle directories (task.json) for requirement → check trace and dependsOn. */
  control?: string[];
  /** next-store: preregistered experiments and their `factory improve` assessments. */
  experiments?: { experiment: string; assessment?: string }[];
  /** v2-project: Claude Code transcript folders; "auto" finds them by the cwd recorded inside. */
  transcripts?: 'auto' | false | string[];
}

export interface DashboardConfig {
  sources: SourceConfig[];
  pricing?: Record<string, ModelPrice>;
  claudeProjectsRoot?: string;
  cacheFile?: string | null;
}

export function loadConfig(file: string): { config: DashboardConfig; baseDir: string } {
  const baseDir = path.dirname(path.resolve(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as DashboardConfig;
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
  for (const source of config.sources) {
    source.path = resolve(source.path);
    source.control = source.control?.map(resolve);
    source.experiments = source.experiments?.map(e => ({ experiment: resolve(e.experiment), assessment: e.assessment ? resolve(e.assessment) : undefined }));
    if (Array.isArray(source.transcripts)) source.transcripts = source.transcripts.map(resolve);
  }
  if (config.claudeProjectsRoot) config.claudeProjectsRoot = resolve(config.claudeProjectsRoot);
  if (config.cacheFile) config.cacheFile = resolve(config.cacheFile);
  return { config, baseDir };
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown');

function mergeDaily(rows: DailyCost[]): DailyCost[] {
  const map = new Map<string, DailyCost>();
  for (const row of rows) {
    const key = `${row.day}|${row.model}`;
    const prev = map.get(key);
    if (!prev) { map.set(key, { ...row, tokens: { ...row.tokens } }); continue; }
    prev.tokens = addTokens(prev.tokens, row.tokens);
    if (row.usd === null || prev.usd === null) { prev.usd = prev.usd ?? row.usd; prev.provenance = 'unknown'; }
    else prev.usd += row.usd;
    if (row.provenance === 'estimated' && prev.provenance === 'reported') prev.provenance = 'estimated';
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

/** Spend over every attempt and run (failed and interrupted included) divided by accepted outcomes. */
export function costPerAccepted(scope: string, factory: CostPerAccepted['factory'], definition: string, runs: RunSummary[], accepted: number, attempts?: number): CostPerAccepted {
  const finished = runs.filter(r => !r.running);
  const spend = sumCosts(finished.map(r => r.cost));
  return {
    scope, factory, definition, spendUsd: spend.usd, spendPartial: Boolean(spend.partial) || spend.usd === null,
    attempts: attempts ?? finished.reduce((n, r) => n + (r.attempts ?? 1), 0), accepted,
    costPerAccepted: spend.usd !== null && accepted > 0 ? spend.usd / accepted : null,
  };
}

export async function buildSnapshot(config: DashboardConfig, now = Date.now()): Promise<Snapshot> {
  const prices = new PriceTable(config.pricing);
  const cache = new TranscriptCache(config.cacheFile ?? null);
  const snapshot: Snapshot = {
    generatedAt: new Date(now).toISOString(), sources: [], runs: [], gateHistory: [], reviews: [], traces: [],
    experiments: [], dailyCost: [], costPerAccepted: [], gaps: [],
  };
  const daily: DailyCost[] = [];

  for (const source of config.sources) {
    const status: SourceStatus = { name: source.name, kind: source.kind, path: source.path, ok: true, items: 0, warnings: [] };
    snapshot.sources.push(status);
    try {
      if (source.kind === 'next-store') {
        const tasks: TaskFile[] = [];
        for (const dir of source.control ?? []) {
          try { tasks.push(readTask(dir)); } catch (error) { status.warnings.push(`control ${dir}: ${(error as Error).message}`); }
        }
        const dependsOn = Object.fromEntries(tasks.map(t => [t.id, dependsOnMap(t)]));
        const { runs, warnings } = readNextStore(source.path, { prices, dependsOn, sourceName: source.name });
        status.warnings.push(...warnings);
        status.items = runs.length;
        if (warnings.length && !runs.length) status.ok = false;
        snapshot.runs.push(...runs);
        for (const task of tasks) snapshot.traces.push(traceForTask(task, runs, source.name));
        for (const run of runs) {
          for (const agent of run.agents) {
            daily.push({ day: day(run.startedAt), model: agent.model ?? `${run.agent ?? 'agent'} (model not recorded)`, usd: agent.cost.usd, provenance: agent.cost.provenance, tokens: agent.cost.tokens ?? emptyTokens() });
          }
        }
        for (const e of source.experiments ?? []) {
          try { snapshot.experiments.push(readExperiment(e.experiment, e.assessment ?? null, source.name)); }
          catch (error) { status.warnings.push(`experiment ${e.experiment}: ${(error as Error).message}`); }
        }
        const byTask = new Map<string, RunSummary[]>();
        for (const run of runs) byTask.set(run.feature ?? run.id, [...(byTask.get(run.feature ?? run.id) ?? []), run]);
        for (const [task, taskRuns] of byTask) {
          snapshot.costPerAccepted.push(costPerAccepted(`${source.name} · ${task}`, 'next',
            'Builder spend across every run and attempt of the task (failed ones included) ÷ runs that reached `passed`.',
            taskRuns, taskRuns.filter(r => r.outcome === 'accepted').length));
        }
        if (runs.length && runs.every(r => r.agent === 'manual')) {
          snapshot.gaps.push(`${source.name}: every run used --agent manual, so no builder.json (agent tokens/cost/tool calls) exists yet.`);
        }
      } else {
        const ledgerFile = path.join(source.path, 'trace', 'ledger.jsonl');
        if (fs.existsSync(ledgerFile)) {
          const ledger = parseLedger(fs.readFileSync(ledgerFile, 'utf8'));
          if (ledger.badLines) status.warnings.push(`${ledger.badLines} unparseable ledger line(s)`);
          snapshot.gateHistory.push({ source: source.name, snapshots: ledger.snapshots, checkRuns: ledger.checkRuns });
          status.items += ledger.snapshots.length + ledger.checkRuns.length;
          if (!ledger.snapshots.length) status.warnings.push('Ledger has no gate-status-run events yet (gate-status never ran)');
        } else status.warnings.push('No trace/ledger.jsonl');
        const findings = readReviewFindings(source.path);
        snapshot.reviews.push({ source: source.name, findings });
        const git = readGitTrailers(source.path);
        if (git.warning) status.warnings.push(git.warning);
        snapshot.traces.push(v2Trace(source.path, source.name, git.commits, findings));

        let sourceRuns: RunSummary[] = [];
        if (source.transcripts !== false) {
          const dirs = Array.isArray(source.transcripts) ? source.transcripts
            : await findTranscriptDirs(source.path, config.claudeProjectsRoot ?? defaultProjectsRoot());
          if (!dirs.length) status.warnings.push('No Claude Code transcripts found for this project: agent cost/trace unavailable');
          const result = await readClaudeProject(dirs, { prices, cache, sourceName: source.name, now });
          status.warnings.push(...result.warnings);
          sourceRuns = result.runs;
          daily.push(...result.daily);
          snapshot.runs.push(...sourceRuns);
          status.items += sourceRuns.length;
        }
        const archived = archivedChanges(source.path);
        snapshot.costPerAccepted.push(costPerAccepted(`${source.name} · all changes`, 'v2',
          'All Claude Code spend recorded for the project (sessions, subagents, workflows) ÷ OpenSpec changes archived (archive requires review clean:true). Period aggregate: transcripts are not linked to changes.',
          sourceRuns, archived.length, sourceRuns.length));
        for (const change of archived) {
          const linked = sourceRuns.filter(r => r.feature === change.change);
          if (!linked.length) continue;
          snapshot.costPerAccepted.push(costPerAccepted(`${source.name} · ${change.change} (review only)`, 'v2',
            'Spend of workflow runs explicitly scoped to this change (review-gate `scope`). Excludes implementation sessions, which carry no change link.',
            linked, 1, linked.length));
        }
      }
    } catch (error) {
      status.ok = false;
      status.warnings.push((error as Error).message);
    }
  }

  for (const exp of snapshot.experiments) {
    for (const arm of exp.arms) {
      snapshot.costPerAccepted.push({ scope: `${exp.id} · ${arm.arm} ${arm.version}`, factory: 'experiment',
        definition: 'Experiment costUSD over every paired run of the arm ÷ accepted runs (src/learning.mjs inputs).',
        spendUsd: arm.costUsd, spendPartial: false, attempts: arm.runs, accepted: arm.accepted, costPerAccepted: arm.costPerAccepted });
    }
  }
  cache.save();
  snapshot.dailyCost = mergeDaily(daily.filter(d => d.usd !== 0 || d.tokens.output > 0 || d.tokens.input > 0));
  snapshot.runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  snapshot.gaps.push(...STATIC_GAPS);
  return snapshot;
}

/** What neither factory records today, with the smallest addition that would provide it. */
export const STATIC_GAPS = [
  'next: the claude adapter uses `--output-format json`, which returns only the final result: tool calls are not recorded. Smallest addition: `--output-format stream-json --verbose` in src/adapters.mjs, with maxOutputBytes raised (stream output easily exceeds the 1 MiB default, which would turn into a failed run). The dashboard already parses stream-json.',
  'next: builder.json has no normalized usage block; cost is parsed from raw CLI stdout, Codex output does not name its model. Smallest addition: write {model, tokens, costUsd} next to stdout in runAgent().',
  'next: no downstream outcome (merged / rejected in review / escaped defect) is recorded, so "accepted" means acceptance checks passed, not merged. Smallest addition: an append-only outcomes.jsonl per run id.',
  'v2: review-findings.json does not carry the workflow runId, so findings link to their agent trace only through the `scope` change name.',
  'v2: implementation sessions are not linked to a change, so cost per accepted change is a period aggregate; only review-gate spend is attributed per change.',
];
