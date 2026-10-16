// Writers that produce factory data in the exact on-disk formats of project-factory-next and the v2
// methodology. Used by the unit tests and by scripts/make-demo.ts. Hash chains and evidence digests are
// computed the same way src/store.mjs and src/runner.mjs compute them, so integrity checks pass unless a
// test tampers with the output on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digestJson, sha256, treeManifest } from '../core/hash.ts';
import type { BuilderRecord } from '../core/builder.ts';
import type { CheckResult } from '../core/next-store.ts';

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export interface AttemptSpec {
  builder?: BuilderRecord;
  /** Omit when the builder failed (no evaluation happens). */
  checks?: CheckResult[];
  preparation?: { id: string; status: 'passed' | 'failed'; durationMs: number; reason?: string; exitCode?: number | null }[];
}

export interface RunSpec {
  id: string;
  taskId: string;
  agent: 'manual' | 'claude' | 'codex';
  model?: string | null;
  maxBudgetUsd?: number | null;
  attempts: AttemptSpec[];
  /** Final controller state. null = still in progress after the last listed attempt event. */
  final: 'passed' | 'failed' | 'interrupted' | null;
  interruptReason?: string;
  /** In-progress runs: the last attempt is still in this state. */
  inProgress?: 'building' | 'evaluating';
  lockPid?: number;
  start: Date;
  stepMs?: number;
  policyDigest?: string;
}

const hex = (seed: string) => sha256(seed);

export function writeNextRun(store: string, spec: RunSpec): string {
  const dir = path.join(store, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  const executionSpec = { agent: spec.agent, model: spec.model ?? null, executable: null, maxBudgetUsd: spec.maxBudgetUsd ?? null,
    baseURL: null, serveDir: null, evaluatorDigest: hex('evaluator') };
  const executionDigest = digestJson(executionSpec);
  const policyDigest = spec.policyDigest ?? hex(`policy:${spec.taskId}`);
  const run: Record<string, any> = { schemaVersion: 1, id: spec.id, policyDigest, candidateDir: `/work/${spec.taskId}/candidate`, agent: spec.agent,
    executionSpec, executionDigest, state: 'created', attempt: 0, history: [], releaseAuthorized: false };
  let clock = spec.start.getTime();
  const step = spec.stepMs ?? 45_000;
  const transition = (state: string, details: Record<string, unknown>, advance = step) => {
    clock += advance;
    const previous = run.history.at(-1)?.digest ?? null;
    const event: Record<string, unknown> = { sequence: run.history.length + 1, at: new Date(clock).toISOString(), state, details, previous };
    event.digest = digestJson(event);
    run.history.push(event);
    run.state = state;
  };
  transition('created', { taskId: spec.taskId, profile: 'software-change', executionDigest }, 0);
  spec.attempts.forEach((attempt, index) => {
    const n = index + 1;
    const last = index === spec.attempts.length - 1;
    run.attempt = n;
    const attemptDir = path.join(dir, `attempt-${n}`);
    fs.mkdirSync(attemptDir, { recursive: true });
    transition('building', { attempt: n, agent: spec.agent }, index ? 2000 : 1000);
    if (last && spec.inProgress === 'building') return;
    if (attempt.builder) writeJson(path.join(attemptDir, 'builder.json'), { adapter: spec.agent, ...attempt.builder });
    if (attempt.builder && attempt.builder.status !== 'completed') {
      transition('attempt-failed', { attempt: n, reason: `Builder ${attempt.builder.status}: ${attempt.builder.error ?? attempt.builder.stderr ?? ''}` }, attempt.builder.durationMs ?? step);
      return;
    }
    const candidateDigest = hex(`${spec.id}:candidate:${n}`);
    if (attempt.preparation?.length) transition('preparing', { attempt: n, sourceInputDigest: candidateDigest }, attempt.builder?.durationMs ?? step);
    const prepFailed = attempt.preparation?.some(p => p.status !== 'passed') ?? false;
    run.candidateDigest = candidateDigest;
    if (!prepFailed) transition('evaluating', { attempt: n, candidateDigest }, attempt.preparation?.length ? step : attempt.builder?.durationMs ?? step);
    if (last && spec.inProgress === 'evaluating') return;
    for (const check of attempt.checks ?? []) {
      const checkDir = path.join(attemptDir, check.id);
      fs.mkdirSync(checkDir, { recursive: true });
      fs.writeFileSync(path.join(checkDir, 'stdout.log'), JSON.stringify({ status: check.status, cases: check.cases ?? [] }));
      fs.writeFileSync(path.join(checkDir, 'stderr.log'), '');
      check.artifacts = { 'stderr.log': sha256(''), 'stdout.log': sha256(fs.readFileSync(path.join(checkDir, 'stdout.log'))) };
    }
    const checks = prepFailed ? [] : attempt.checks ?? [];
    const status = !prepFailed && checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
    clock += checks.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
    const report = { schemaVersion: 1, runId: spec.id, attempt: n, taskId: spec.taskId, policyDigest, candidateDigest,
      evaluatorDigest: executionSpec.evaluatorDigest, executionDigest, sourceInputDigest: candidateDigest, preparation: attempt.preparation ?? [],
      targetBinding: { kind: 'candidate-files' }, node: 'v24.18.0', platform: 'linux', completedAt: new Date(clock).toISOString(), status,
      releaseAuthorized: false, checks };
    writeJson(path.join(attemptDir, 'evidence.json'), report);
    run.evidencePath = `attempt-${n}/evidence.json`;
    run.evidenceDigest = sha256(fs.readFileSync(path.join(attemptDir, 'evidence.json')));
    run.attemptManifest = treeManifest(attemptDir);
    if (status === 'passed') transition('passed', { attempt: n }, 500);
    else transition('attempt-failed', { attempt: n, ...(prepFailed ? { reason: 'Preparation failed; acceptance was not executed', failedPreparation: attempt.preparation!.filter(p => p.status !== 'passed').map(p => p.id) } : {}),
      failedChecks: checks.filter(c => c.status !== 'passed').map(c => c.id) }, 500);
  });
  if (spec.final === 'failed') transition('failed', { reason: 'No accepted candidate within the attempt budget' }, 200);
  if (spec.final === 'interrupted') transition('interrupted', { reason: spec.interruptReason ?? 'Controller exception' }, 200);
  writeJson(path.join(dir, 'run.json'), run);
  if (spec.lockPid !== undefined) writeJson(path.join(dir, 'lock.json'), { pid: spec.lockPid, createdAt: spec.start.toISOString() });
  return dir;
}

export function claudeJsonStdout(o: { costUsd: number; model: string; turns: number; result: string; input: number; output: number; cacheWrite: number; cacheRead: number }): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: o.turns, result: o.result,
    session_id: hex(o.result).slice(0, 36), total_cost_usd: o.costUsd,
    usage: { input_tokens: o.input, output_tokens: o.output, cache_creation_input_tokens: o.cacheWrite, cache_read_input_tokens: o.cacheRead },
    modelUsage: { [o.model]: { inputTokens: o.input, outputTokens: o.output, cacheReadInputTokens: o.cacheRead, cacheCreationInputTokens: o.cacheWrite, costUSD: o.costUsd } } });
}

export function claudeStreamStdout(o: { model: string; tools: { name: string; input: Record<string, unknown> }[]; costUsd?: number }): string {
  const lines: unknown[] = [{ type: 'system', subtype: 'init', model: o.model, tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'] }];
  o.tools.forEach((tool, i) => {
    const message = { id: `msg_${i}`, model: o.model, usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 } };
    // Claude Code writes one line per content block, repeating message.id and usage.
    lines.push({ type: 'assistant', message: { ...message, content: [{ type: 'text', text: `Step ${i + 1}` }] } });
    lines.push({ type: 'assistant', message: { ...message, content: [{ type: 'tool_use', id: `tu_${i}`, name: tool.name, input: tool.input }] } });
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok' }] } });
  });
  if (o.costUsd !== undefined) lines.push({ type: 'result', subtype: 'success', num_turns: o.tools.length, result: 'done', total_cost_usd: o.costUsd,
    usage: { input_tokens: 1200 * o.tools.length, output_tokens: 300 * o.tools.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 * o.tools.length } });
  return lines.map(l => JSON.stringify(l)).join('\n');
}

export function codexJsonl(o: { commands: { command: string; exit: number }[]; files: string[]; message: string; turns: { input: number; cached: number; output: number }[] }): string {
  const lines: unknown[] = [{ type: 'thread.started', thread_id: 'thread_demo' }];
  let id = 0;
  for (const turn of o.turns) {
    lines.push({ type: 'turn.started' });
    for (const c of o.commands) {
      lines.push({ type: 'item.started', item: { id: `item_${id}`, type: 'command_execution', command: c.command, status: 'in_progress' } });
      lines.push({ type: 'item.completed', item: { id: `item_${id++}`, type: 'command_execution', command: c.command, aggregated_output: '', exit_code: c.exit, status: c.exit === 0 ? 'completed' : 'failed' } });
    }
    if (o.files.length) lines.push({ type: 'item.completed', item: { id: `item_${id++}`, type: 'file_change', changes: o.files.map(p => ({ path: p, kind: 'update' })), status: 'completed' } });
    lines.push({ type: 'item.completed', item: { id: `item_${id++}`, type: 'agent_message', text: o.message } });
    lines.push({ type: 'turn.completed', usage: { input_tokens: turn.input, cached_input_tokens: turn.cached, output_tokens: turn.output } });
  }
  return lines.map(l => JSON.stringify(l)).join('\n');
}

// ---------- v2 project ----------

export interface V2CommitSpec { subject: string; body?: string; slice?: string; refs?: string[]; at: Date; files?: Record<string, string> }

export function writeV2Project(dir: string, o: {
  requirements: { id: string; description: string }[];
  ledger: Record<string, unknown>[];
  changes: { name: string; archivedOn?: string; findings?: Record<string, unknown> }[];
  commits: V2CommitSpec[];
}) {
  fs.mkdirSync(dir, { recursive: true });
  const md = ['# Requirements', '', '| ID | Release | Area | Requirement | Verification |', '|---|---|---|---|---|',
    ...o.requirements.map(r => `| ${r.id} | MVP | Demo | ${r.description} | local-verifiable |`)].join('\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'requirements.md'), `${md}\n`);
  fs.mkdirSync(path.join(dir, 'trace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'trace', 'ledger.jsonl'), o.ledger.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const change of o.changes) {
    const changeDir = change.archivedOn ? path.join(dir, 'openspec', 'changes', 'archive', `${change.archivedOn}-${change.name}`)
      : path.join(dir, 'openspec', 'changes', change.name);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, 'proposal.md'), `# ${change.name}\n`);
    if (change.findings) writeJson(path.join(changeDir, 'review-findings.json'), change.findings);
  }
  const git = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', shell: false, env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'factory@example.invalid']);
  git(['config', 'user.name', 'Demo Factory']);
  git(['config', 'commit.gpgsign', 'false']);
  o.commits.forEach((c, i) => {
    const file = path.join(dir, 'src', `step-${String(i).padStart(2, '0')}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${c.subject}\n`);
    git(['add', '-A']);
    const trailers = [c.slice && `Slice: ${c.slice}`, c.refs?.length && `Refs: ${c.refs.join(', ')}`].filter(Boolean).join('\n');
    const message = [c.subject, c.body, trailers].filter(Boolean).join('\n\n');
    const date = c.at.toISOString();
    git(['commit', '-q', '--no-verify', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  });
}

export function ledgerEvent(at: Date, event: string, check: string, extra: Record<string, unknown> = {}) {
  return { ts: at.toISOString(), event, check, exitCode: 0, failures: null, warnings: null, warningsByClass: {}, scope_n: null, phase: null,
    gitHead: hex(`${check}${at.getTime()}`).slice(0, 40), dirty: false, durationMs: null, meta: {}, ...extra };
}

// ---------- Claude Code transcripts ----------

export interface TranscriptTurn { at: Date; model: string; input: number; output: number; cacheWrite: number; cacheRead: number; tools?: { name: string; input: Record<string, unknown> }[]; text?: string }

export function transcriptLines(o: { sessionId: string; cwd: string; title?: string; turns: TranscriptTurn[]; agentId?: string }): string {
  const lines: unknown[] = [];
  if (o.title) lines.push({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId });
  o.turns.forEach((t, i) => {
    const base = { isSidechain: Boolean(o.agentId), sessionId: o.sessionId, cwd: o.cwd, timestamp: t.at.toISOString(), ...(o.agentId ? { agentId: o.agentId } : {}) };
    lines.push({ ...base, type: 'user', message: { role: 'user', content: i === 0 ? 'Start the slice' : 'continue' } });
    const message = { id: `msg_${o.sessionId}_${o.agentId ?? 'main'}_${i}`, model: t.model, role: 'assistant',
      usage: { input_tokens: t.input, output_tokens: t.output, cache_creation_input_tokens: t.cacheWrite, cache_read_input_tokens: t.cacheRead } };
    // One line per content block, each repeating message.id and the same usage (as Claude Code writes them).
    lines.push({ ...base, type: 'assistant', message: { ...message, content: [{ type: 'text', text: t.text ?? 'Working.' }] } });
    for (const [j, tool] of (t.tools ?? []).entries()) {
      lines.push({ ...base, type: 'assistant', message: { ...message, content: [{ type: 'tool_use', id: `tu_${i}_${j}`, name: tool.name, input: tool.input }] } });
    }
  });
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

export function projectSlug(projectPath: string) {
  return path.resolve(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

export function writeClaudeSession(root: string, projectPath: string, o: {
  sessionId: string; title: string; turns: TranscriptTurn[];
  subagents?: { agentId: string; agentType: string; description: string; turns: TranscriptTurn[] }[];
  workflows?: { file: Record<string, unknown>; agents: { agentId: string; turns: TranscriptTurn[] }[] }[];
}) {
  const dir = path.join(root, projectSlug(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${o.sessionId}.jsonl`), transcriptLines({ sessionId: o.sessionId, cwd: projectPath, title: o.title, turns: o.turns }));
  for (const sub of o.subagents ?? []) {
    const subDir = path.join(dir, o.sessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `agent-${sub.agentId}.jsonl`), transcriptLines({ sessionId: o.sessionId, cwd: projectPath, turns: sub.turns, agentId: sub.agentId }));
    writeJson(path.join(subDir, `agent-${sub.agentId}.meta.json`), { agentType: sub.agentType, description: sub.description, spawnDepth: 1 });
  }
  for (const wf of o.workflows ?? []) {
    const runId = wf.file.runId as string;
    writeJson(path.join(dir, o.sessionId, 'workflows', `${runId}.json`), wf.file);
    for (const agent of wf.agents) {
      const agentDir = path.join(dir, o.sessionId, 'subagents', 'workflows', runId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, `agent-${agent.agentId}.jsonl`), transcriptLines({ sessionId: o.sessionId, cwd: projectPath, turns: agent.turns, agentId: agent.agentId }));
    }
  }
  return dir;
}
