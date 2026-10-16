// Control bundle (task.json) and experiment/assessment files of project-factory-next.
import fs from 'node:fs';
import path from 'node:path';
import type { ExperimentView, GateStatus, RunSummary, TraceChain, TraceRequirement } from './types.ts';

export interface TaskFile {
  id: string;
  title: string;
  requirements: { id: string; description: string; checkIds: string[] }[];
  checks: { id: string; kind: string; dependsOn: string[]; expectedCases: string[] }[];
}

export function readTask(controlDir: string): TaskFile {
  return JSON.parse(fs.readFileSync(path.join(controlDir, 'task.json'), 'utf8'));
}

export function dependsOnMap(task: TaskFile): Record<string, string[]> {
  return Object.fromEntries(task.checks.map(c => [c.id, c.dependsOn ?? []]));
}

const worst = (statuses: GateStatus[]): GateStatus => {
  if (!statuses.length) return 'unknown';
  for (const s of ['fail', 'blocked', 'not-earned', 'unknown', 'pending', 'needs-signoff'] as GateStatus[]) if (statuses.includes(s)) return s;
  return 'pass';
};

/**
 * Requirement → check → case chain, evaluated against the newest run of the task that produced
 * evidence. Requirements whose checks never ran stay 'unknown' (missing evidence is not success).
 */
export function traceForTask(task: TaskFile, runs: RunSummary[], source: string): TraceChain {
  // Prefer evidence whose integrity verified; fall back to the newest run only when none did.
  const candidates = runs.filter(r => r.feature === task.id && r.gates.length);
  const verified = candidates.filter(r => r.integrity.ok);
  const latest = (verified.length ? verified : candidates)
    .sort((a, b) => Date.parse(b.endedAt ?? b.startedAt ?? '0') - Date.parse(a.endedAt ?? a.startedAt ?? '0'))[0];
  const requirements: TraceRequirement[] = task.requirements.map(req => {
    const links: TraceRequirement['links'] = [];
    const statuses: GateStatus[] = [];
    for (const checkId of req.checkIds) {
      const gate = latest?.gates.find(g => g.id === checkId);
      const status: GateStatus = gate?.status ?? 'unknown';
      statuses.push(status);
      links.push({ kind: 'check', id: checkId, status });
      const declared = task.checks.find(c => c.id === checkId)?.expectedCases ?? [];
      for (const caseId of declared) {
        const observed = gate?.cases?.find(c => c.id === caseId);
        links.push({ kind: 'case', id: `${checkId}/${caseId}`, status: observed?.status ?? (gate?.status === 'blocked' ? 'blocked' : 'not run') });
      }
    }
    return { id: req.id, description: req.description, links, status: worst(statuses) };
  });
  return {
    source, factory: 'next', untracedCommits: 0, requirements,
    title: `${task.id} — ${task.title}${latest ? ` · evidence from run ${latest.id}${latest.integrity.ok ? '' : ' (integrity NOT verified)'}` : ' · no evidence yet'}`,
  };
}

interface ExperimentFile {
  id: string;
  stage: string;
  parent: { version: string; model: string };
  candidate: { version: string; model: string };
  splits: Record<string, string[]>;
  audit?: { heldOutUntil?: string };
  runs: { taskId: string; arm: string; accepted: boolean; costUSD: number }[];
}

interface AssessmentFile {
  experimentId: string;
  status: string;
  action: string;
  reasonCodes: string[];
  metrics: Record<string, { mean: number; lower: number; upper: number }>;
}

/**
 * The improvement loop's holdout discipline (src/learning.mjs): development tasks are visible to the
 * optimizer, selection ranks candidates, finalAudit stays held out until the finalist is frozen.
 * The active split depends on the stage; the other splits must never appear in runs[].
 */
export function readExperiment(file: string, assessmentFile: string | null, source: string): ExperimentView {
  const experiment = JSON.parse(fs.readFileSync(file, 'utf8')) as ExperimentFile;
  let assessment: AssessmentFile | null = null;
  if (assessmentFile && fs.existsSync(assessmentFile)) assessment = JSON.parse(fs.readFileSync(assessmentFile, 'utf8'));
  const arms = (['parent', 'candidate'] as const).map(arm => {
    const runs = experiment.runs.filter(r => r.arm === arm);
    const accepted = runs.filter(r => r.accepted).length;
    const costUsd = runs.reduce((sum, r) => sum + r.costUSD, 0);
    return { arm, version: experiment[arm].version.slice(0, 12), model: experiment[arm].model, runs: runs.length, accepted, costUsd,
      costPerAccepted: accepted ? costUsd / accepted : null };
  });
  const active = experiment.stage === 'final-audit' ? 'finalAudit' : 'selection';
  return {
    source, id: experiment.id, stage: experiment.stage,
    splits: Object.entries(experiment.splits).map(([name, tasks]) => ({ name, tasks: tasks.length, heldOut: name === 'finalAudit', active: name === active })),
    heldOutUntil: experiment.audit?.heldOutUntil ?? null,
    arms,
    assessment: assessment && assessment.experimentId === experiment.id
      ? { status: assessment.status, action: assessment.action, reasonCodes: assessment.reasonCodes, metrics: assessment.metrics }
      : null,
  };
}
