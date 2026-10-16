// Claude Code transcripts: the only place where the v2 factory's agent spend and tool calls are recorded.
//   ~/.claude/projects/<slug>/<session>.jsonl                       main thread (assistant usage, tool_use)
//   ~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl     Agent-tool subagents (+ .meta.json agentType)
//   ~/.claude/projects/<slug>/<session>/workflows/wf_*.json         Workflow runs (review-gate, spec-pipeline, …)
//   ~/.claude/projects/<slug>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl   workflow agents
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import type { AgentUsage, Cost, DailyCost, Role, RunSummary, TimelineEvent, TokenUsage } from './types.ts';
import { PriceTable, addTokens, emptyTokens, sumCosts } from './pricing.ts';

export interface TranscriptStats {
  file: string;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** tokens per model, deduplicated by message.id. */
  models: Record<string, TokenUsage>;
  /** day|model → tokens */
  daily: Record<string, TokenUsage>;
  assistantMessages: number;
  duplicateUsageLines: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  events: { at: string | null; tool: string; detail: string; subagentType?: string }[];
  badLines: number;
}

const MAX_EVENTS = 400;

const short = (value: unknown, max = 140) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function usageOf(u: Record<string, unknown> | undefined): TokenUsage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheWrite: n(u?.cache_creation_input_tokens), cacheRead: n(u?.cache_read_input_tokens) };
}

function toolDetail(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (name === 'Agent' || name === 'Task') return short(input.description ?? input.prompt);
  if (name === 'Bash' || name === 'PowerShell') return short(input.command);
  if (name === 'Workflow') return short(input.name ?? (typeof input.script === 'string' ? input.script.match(/name:\s*'([^']+)'/)?.[1] : '') ?? '');
  return short(input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.skill ?? input.query ?? input);
}

/** Streams one JSONL transcript. Assistant lines repeat message.id/usage per content block: count usage once. */
export async function parseTranscript(file: string): Promise<TranscriptStats> {
  const stats: TranscriptStats = {
    file, sessionId: null, cwd: null, title: null, startedAt: null, endedAt: null, models: {}, daily: {},
    assistantMessages: 0, duplicateUsageLines: 0, toolCalls: 0, toolCounts: {}, events: [], badLines: 0,
  };
  const seen = new Set<string>();
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { stats.badLines++; continue; }
    if (typeof e.timestamp === 'string') {
      if (!stats.startedAt || e.timestamp < stats.startedAt) stats.startedAt = e.timestamp;
      if (!stats.endedAt || e.timestamp > stats.endedAt) stats.endedAt = e.timestamp;
    }
    if (!stats.cwd && typeof e.cwd === 'string') stats.cwd = e.cwd;
    if (!stats.sessionId && typeof e.sessionId === 'string') stats.sessionId = e.sessionId;
    if ((e.type === 'custom-title' || e.type === 'ai-title') && typeof (e.customTitle ?? e.aiTitle ?? e.title) === 'string') {
      if (e.type === 'custom-title' || !stats.title) stats.title = e.customTitle ?? e.aiTitle ?? e.title;
    }
    if (e.type !== 'assistant' || !e.message) continue;
    const message = e.message;
    const id: string | undefined = message.id ?? e.requestId;
    const model: string = message.model ?? 'unknown';
    if (model === '<synthetic>') continue;
    if (id && seen.has(id)) stats.duplicateUsageLines++;
    else {
      if (id) seen.add(id);
      stats.assistantMessages++;
      const usage = usageOf(message.usage);
      stats.models[model] = addTokens(stats.models[model] ?? emptyTokens(), usage);
      const day = (e.timestamp ?? '').slice(0, 10) || 'unknown';
      stats.daily[`${day}|${model}`] = addTokens(stats.daily[`${day}|${model}`] ?? emptyTokens(), usage);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use') continue;
      stats.toolCalls++;
      stats.toolCounts[block.name] = (stats.toolCounts[block.name] ?? 0) + 1;
      const handoff = block.name === 'Agent' || block.name === 'Task' || block.name === 'Workflow' || block.name === 'Skill';
      if (handoff || stats.events.length < MAX_EVENTS) {
        stats.events.push({ at: e.timestamp ?? null, tool: block.name, detail: toolDetail(block.name, block.input),
          ...(block.name === 'Agent' || block.name === 'Task' ? { subagentType: block.input?.subagent_type ?? 'general-purpose' } : {}) });
      }
    }
  }
  return stats;
}

/** Cache keyed by path + size + mtime so the 30–100 MB transcript folders are streamed once. */
export class TranscriptCache {
  private memory = new Map<string, TranscriptStats>();
  private dirty = false;
  private file: string | null;
  constructor(file: string | null = null) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.memory.set(k, v as TranscriptStats); }
      catch { /* corrupt cache: rebuild */ }
    }
  }
  async get(file: string): Promise<TranscriptStats> {
    const stat = fs.statSync(file);
    const key = `${file}|${stat.size}|${stat.mtimeMs}`;
    const hit = this.memory.get(key);
    if (hit) return hit;
    const stats = await parseTranscript(file);
    for (const k of this.memory.keys()) if (k.startsWith(`${file}|`)) this.memory.delete(k);
    this.memory.set(key, stats);
    this.dirty = true;
    return stats;
  }
  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.memory)));
    this.dirty = false;
  }
}

export const defaultProjectsRoot = () => path.join(os.homedir(), '.claude', 'projects');

const normalize = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Transcript folders for a project: matched by the cwd recorded inside them, not by the folder name alone. */
export async function findTranscriptDirs(projectPath: string, root = defaultProjectsRoot()): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const slug = path.resolve(projectPath).replace(/[^A-Za-z0-9]/g, '-');
  const want = normalize(projectPath);
  const dirs: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name !== slug && !name.startsWith(`${slug}-`)) continue;
    const dir = path.join(root, name);
    const sample = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'));
    if (!sample) continue;
    const cwd = await firstCwd(path.join(dir, sample));
    if (cwd && (normalize(cwd) === want || normalize(cwd).startsWith(`${want}${path.sep}.claude`) || normalize(cwd).startsWith(`${want}/.claude`))) dirs.push(dir);
  }
  return dirs;
}

async function firstCwd(file: string): Promise<string | null> {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    if (++n > 50) break;
    const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) { lines.close(); return JSON.parse(`"${m[1]}"`); }
  }
  return null;
}

const MAKER_TYPES = /implement|writer|engineer|analyst|documenter|builder|general-purpose|fork|plan/i;
const CHECKER_TYPES = /review|audit|judge|verif|critic|triage|eval/i;

export function roleForAgent(labelOrType: string): Role {
  const v = labelOrType.toLowerCase();
  if (v.startsWith('verify:') || v.startsWith('verify-')) return 'verifier';
  if (v.startsWith('find:') || v.startsWith('judge') || CHECKER_TYPES.test(v)) return 'checker';
  if (v.startsWith('persist:')) return 'writer';
  if (v.startsWith('draft:') || MAKER_TYPES.test(v)) return 'maker';
  return 'maker';
}

export function costOfStats(stats: TranscriptStats, prices: PriceTable): Cost {
  const parts = Object.entries(stats.models).map(([model, tokens]) => prices.estimate(model, tokens));
  return parts.length ? sumCosts(parts) : { usd: 0, provenance: 'estimated', tokens: emptyTokens(), note: 'No assistant usage' };
}

const primaryModel = (stats: TranscriptStats) =>
  Object.entries(stats.models).sort((a, b) => b[1].output - a[1].output)[0]?.[0] ?? null;

export function dailyCosts(stats: TranscriptStats, prices: PriceTable): DailyCost[] {
  return Object.entries(stats.daily).map(([key, tokens]) => {
    const [day, model] = key.split('|');
    const cost = prices.estimate(model, tokens);
    return { day, model, usd: cost.usd, provenance: cost.provenance, tokens };
  });
}

interface WorkflowAgent {
  label?: string;
  agentId?: string;
  model?: string;
  state?: string;
  startedAt?: number;
  queuedAt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  phaseTitle?: string;
  lastToolName?: string;
  resultPreview?: string;
}

const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

export interface SessionReadOptions {
  prices: PriceTable;
  cache: TranscriptCache;
  sourceName: string;
  now?: number;
}

/** One project's Claude Code sessions → session runs + workflow runs (review-gate, spec-pipeline, …). */
export async function readClaudeProject(dirs: string[], options: SessionReadOptions): Promise<{ runs: RunSummary[]; daily: DailyCost[]; warnings: string[] }> {
  const { prices, cache, sourceName } = options;
  const now = options.now ?? Date.now();
  const runs: RunSummary[] = [];
  const daily: DailyCost[] = [];
  const warnings: string[] = [];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
      const sessionId = file.replace(/\.jsonl$/, '');
      const main = await cache.get(path.join(dir, file));
      const sessionDir = path.join(dir, sessionId);
      daily.push(...dailyCosts(main, prices));
      const agents: AgentUsage[] = [{ id: `${sessionId}:main`, label: 'main session (orchestrator)', role: 'orchestrator', model: primaryModel(main),
        cost: costOfStats(main, prices), toolCalls: main.toolCalls, durationMs: null, state: null }];
      const events: TimelineEvent[] = main.events.map(ev => ({
        at: ev.at, kind: ev.subagentType ? 'handoff' : ev.tool === 'Workflow' ? 'agent' : 'tool',
        role: ev.subagentType ? roleForAgent(ev.subagentType) : 'orchestrator',
        actor: ev.subagentType ?? 'main', title: ev.subagentType ? `→ ${ev.subagentType}` : ev.tool, detail: ev.detail,
      }));
      let latest = Date.parse(main.endedAt ?? '0');

      // Agent-tool subagents (not workflow agents: those are attributed to their workflow run).
      const subDir = path.join(sessionDir, 'subagents');
      if (fs.existsSync(subDir)) {
        for (const sub of fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
          const stats = await cache.get(path.join(subDir, sub));
          daily.push(...dailyCosts(stats, prices));
          let meta: { agentType?: string; description?: string } = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(subDir, sub.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* no meta */ }
          const type = (meta.agentType ?? 'subagent').replace(/^project-factory:/, '');
          latest = Math.max(latest, Date.parse(stats.endedAt ?? '0'));
          agents.push({ id: sub.replace(/\.jsonl$/, ''), label: `${type}${meta.description ? ` — ${meta.description}` : ''}`, role: roleForAgent(type),
            model: primaryModel(stats), cost: costOfStats(stats, prices), toolCalls: stats.toolCalls,
            durationMs: stats.startedAt && stats.endedAt ? Date.parse(stats.endedAt) - Date.parse(stats.startedAt) : null, state: null });
        }
      }

      // Workflow runs.
      const wfDir = path.join(sessionDir, 'workflows');
      if (fs.existsSync(wfDir)) {
        for (const wfFile of fs.readdirSync(wfDir).filter(f => /^wf_.*\.json$/.test(f))) {
          try {
            const run = await readWorkflowRun(path.join(wfDir, wfFile), sessionDir, options, daily);
            runs.push(run);
          } catch (error) { warnings.push(`${wfFile}: ${(error as Error).message}`); }
        }
      }

      const cost = sumCosts(agents.map(a => a.cost));
      const active = now - latest < ACTIVE_WINDOW_MS;
      runs.push({
        key: `${sourceName}:session:${sessionId}`, id: sessionId.slice(0, 8), source: sourceName, factory: 'claude-code', kind: 'session',
        title: main.title ?? `Session ${sessionId.slice(0, 8)}`, feature: null, state: active ? 'active' : 'idle',
        outcome: active ? 'running' : 'completed', startedAt: main.startedAt, endedAt: active ? null : new Date(latest).toISOString(),
        durationMs: main.startedAt ? latest - Date.parse(main.startedAt) : null, agent: 'claude-code', model: primaryModel(main),
        attempts: null, running: active, runningBasis: active ? 'transcript written in the last 3 minutes (heuristic)' : null,
        integrity: { ok: null, issues: main.badLines ? [`${main.badLines} unparseable transcript line(s)`] : [] },
        gates: [], cost, agents, events: events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')), failure: null,
      });
    }
  }
  return { runs, daily, warnings };
}

async function readWorkflowRun(file: string, sessionDir: string, options: SessionReadOptions, daily: DailyCost[]): Promise<RunSummary> {
  const { prices, cache, sourceName } = options;
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const runId: string = wf.runId ?? path.basename(file, '.json');
  const progress: any[] = Array.isArray(wf.workflowProgress) ? wf.workflowProgress : [];
  const agentDir = path.join(sessionDir, 'subagents', 'workflows', runId);
  const agents: AgentUsage[] = [];
  const events: TimelineEvent[] = [];
  for (const p of progress) {
    if (p.type === 'workflow_phase') {
      events.push({ at: null, kind: 'gate', role: 'orchestrator', actor: 'workflow', title: `phase ${p.index}: ${p.title}` });
      continue;
    }
    if (p.type !== 'workflow_agent') continue;
    const a = p as WorkflowAgent;
    const label = a.label ?? a.agentId ?? 'agent';
    const transcript = a.agentId ? path.join(agentDir, `agent-${a.agentId}.jsonl`) : null;
    let cost: Cost;
    let toolCalls = a.toolCalls ?? null;
    let model = a.model ?? null;
    if (transcript && fs.existsSync(transcript)) {
      const stats = await cache.get(transcript);
      cost = costOfStats(stats, prices);
      daily.push(...dailyCosts(stats, prices));
      model = primaryModel(stats) ?? model;
      toolCalls = stats.toolCalls;
    } else {
      // The workflow record has only a total token count: no input/output split, so no honest price.
      cost = { usd: null, provenance: 'unknown', tokens: null, note: a.tokens ? `${a.tokens} tokens (no split; agent transcript missing)` : 'No usage' };
    }
    const role = roleForAgent(label);
    agents.push({ id: a.agentId ?? label, label, role, model, cost, toolCalls, durationMs: a.durationMs ?? null, state: a.state ?? null });
    events.push({
      at: a.startedAt ? new Date(a.startedAt).toISOString() : null, kind: 'agent', role, actor: label,
      title: `${label} · ${a.state ?? '?'}`, status: a.state, durationMs: a.durationMs ?? null,
      detail: [a.phaseTitle && `phase ${a.phaseTitle}`, toolCalls != null && `${toolCalls} tool calls`, a.lastToolName && `last tool ${a.lastToolName}`,
        a.resultPreview && short(a.resultPreview, 200)].filter(Boolean).join(' · ') || undefined,
    });
  }
  // review-gate returns its adversarially verified findings: surface each verdict as evidence.
  const result = wf.result && typeof wf.result === 'object' ? wf.result : null;
  const endAt = wf.startTime && wf.durationMs ? new Date(wf.startTime + wf.durationMs).toISOString() : wf.timestamp ?? null;
  for (const verdict of ['confirmed', 'contested', 'rejected']) {
    for (const f of Array.isArray(result?.[verdict]) ? result[verdict] : []) {
      events.push({ at: endAt, kind: 'finding', role: 'verifier', actor: f.dimension ?? 'review', status: verdict,
        title: `${verdict}: ${short(f.title, 120)}`, detail: [f.severity && `severity ${f.severity}`, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`,
          Array.isArray(f.verifierNotes) && f.verifierNotes.length ? `${f.verifierNotes.length} verifier note(s)` : null].filter(Boolean).join(' · ') });
    }
  }
  const counts = result && ['confirmed', 'contested', 'rejected'].every(k => Array.isArray(result[k]))
    ? { confirmed: result.confirmed.length, contested: result.contested.length, rejected: result.rejected.length } : null;
  const status: string = wf.status ?? 'unknown';
  const running = status === 'running' || status === 'pending';
  const feature: string | null = typeof result?.scope === 'string' && result.scope !== 'working tree' ? result.scope : null;
  events.sort((a, b) => (a.at ?? '￿').localeCompare(b.at ?? '￿'));
  return {
    key: `${sourceName}:${runId}`, id: runId, source: sourceName, factory: 'claude-code', kind: 'workflow',
    title: wf.workflowName ?? 'workflow', feature, state: status,
    outcome: running ? 'running' : status === 'completed' ? 'completed' : status === 'failed' || status === 'error' ? 'failed' : 'unknown',
    startedAt: wf.startTime ? new Date(wf.startTime).toISOString() : null, endedAt: running ? null : endAt,
    durationMs: wf.durationMs ?? null, agent: 'workflow', model: wf.defaultModel ?? null, attempts: null, running,
    runningBasis: running ? `workflow status ${status}` : null,
    integrity: { ok: null, issues: agents.filter(a => a.state === 'error').map(a => `agent ${a.label} ended in error`) },
    gates: counts ? [
      { id: 'review-confirmed', label: 'confirmed findings', status: counts.confirmed === 0 ? 'pass' : 'fail', raw: String(counts.confirmed) },
      { id: 'review-contested', label: 'contested', status: counts.contested === 0 ? 'pass' : 'needs-signoff', raw: String(counts.contested) },
      { id: 'review-rejected', label: 'refuted by verifiers', status: 'pass', raw: String(counts.rejected) },
    ] : [],
    cost: sumCosts(agents.map(a => a.cost)), agents, events,
    failure: counts && counts.confirmed > 0 ? `${counts.confirmed} confirmed finding(s): review not clean` : status === 'failed' ? 'Workflow failed' : null,
  };
}
