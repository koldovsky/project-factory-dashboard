// Normalized model shared by the parsers, the API server and the UI.
// Every number carries its provenance: the dashboard never presents an estimate as a measurement,
// and an unknown value is never shown as zero.

export type Provenance = 'reported' | 'estimated' | 'unknown';

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface Cost {
  /** null when the spend cannot be determined (truncated output, unparseable stdout, unpriced model). */
  usd: number | null;
  provenance: Provenance;
  tokens: TokenUsage | null;
  /** Spend that could be attributed only partially: some components were unknown. */
  partial?: boolean;
  note?: string;
}

/**
 * Gate/check verdicts. The factory's honesty rules are kept: blocked, not-earned, pending and
 * needs-signoff are distinct states and are never folded into pass.
 */
export type GateStatus = 'pass' | 'fail' | 'blocked' | 'not-earned' | 'pending' | 'needs-signoff' | 'unknown';

export interface GateResult {
  id: string;
  label: string;
  status: GateStatus;
  /** The verdict string exactly as the factory wrote it. */
  raw: string;
  detail?: string;
  durationMs?: number | null;
  cases?: { id: string; status: string; details?: string }[];
  dependsOn?: string[];
}

export type Role = 'controller' | 'maker' | 'checker' | 'verifier' | 'writer' | 'human' | 'orchestrator';

export interface TimelineEvent {
  at: string | null;
  kind: 'transition' | 'builder' | 'preparation' | 'check' | 'tool' | 'agent' | 'handoff' | 'finding' | 'gate' | 'commit' | 'message' | 'usage';
  role: Role;
  actor: string;
  title: string;
  detail?: string;
  status?: string;
  durationMs?: number | null;
  attempt?: number;
}

export type Outcome = 'accepted' | 'unverified' | 'rejected' | 'running' | 'interrupted' | 'stale-lock' | 'completed' | 'failed' | 'unknown';

export interface RunSummary {
  key: string;
  id: string;
  source: string;
  factory: 'next' | 'v2' | 'claude-code';
  kind: 'delivery' | 'workflow' | 'session';
  title: string;
  /** next: task id; v2/workflow: OpenSpec change (slice) when it is explicitly linked. */
  feature: string | null;
  state: string;
  outcome: Outcome;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  agent: string | null;
  model: string | null;
  attempts: number | null;
  running: boolean;
  runningBasis: string | null;
  integrity: { ok: boolean | null; issues: string[] };
  gates: GateResult[];
  cost: Cost;
  /** Per-agent breakdown (maker attempts, workflow agents, subagents). */
  agents: AgentUsage[];
  events: TimelineEvent[];
  failure: string | null;
}

export interface AgentUsage {
  id: string;
  label: string;
  role: Role;
  model: string | null;
  cost: Cost;
  toolCalls: number | null;
  durationMs: number | null;
  state: string | null;
}

export interface GateSnapshot {
  at: string;
  gitHead: string | null;
  phase: string | null;
  frontier: string | null;
  gates: GateResult[];
  openCorrections: number | null;
  divergences: number | null;
}

export interface CheckRun {
  at: string;
  event: string;
  check: string;
  exitCode: number | null;
  scopeN: number | null;
  /** exit 0 over an empty scope: the factory's "PASS on 0 slices" failure class. */
  vacuous: boolean;
  overall: string | null;
  durationMs: number | null;
}

export interface ReviewFindings {
  change: string;
  archived: boolean;
  path: string;
  clean: boolean | null;
  generatedAt: string | null;
  baseRef: string | null;
  headRef: string | null;
  dimensions: { name: string; confirmed: number; contested: number; rejected: number }[];
  confirmedTitles: string[];
}

export interface TraceCommit {
  hash: string;
  at: string;
  subject: string;
  slices: string[];
  refs: string[];
}

export interface TraceRequirement {
  id: string;
  description: string | null;
  /** next: checks proving the requirement; v2: commits carrying the id in a Refs: trailer. */
  links: { kind: 'check' | 'case' | 'commit' | 'slice'; id: string; status?: GateStatus | string }[];
  status: GateStatus;
}

export interface TraceChain {
  source: string;
  factory: 'next' | 'v2';
  title: string;
  requirements: TraceRequirement[];
  untracedCommits: number;
}

export interface ExperimentView {
  source: string;
  id: string;
  stage: string;
  splits: { name: string; tasks: number; heldOut: boolean; active: boolean }[];
  heldOutUntil: string | null;
  arms: { arm: string; version: string; model: string; runs: number; accepted: number; costUsd: number; costPerAccepted: number | null }[];
  assessment: { status: string; action: string; reasonCodes: string[]; metrics: Record<string, { mean: number; lower: number; upper: number }> } | null;
}

export interface DailyCost {
  day: string;
  model: string;
  usd: number | null;
  provenance: Provenance;
  tokens: TokenUsage;
}

export interface CostPerAccepted {
  scope: string;
  factory: 'next' | 'v2' | 'experiment';
  definition: string;
  spendUsd: number | null;
  spendPartial: boolean;
  attempts: number;
  accepted: number;
  costPerAccepted: number | null;
}

export interface SourceStatus {
  name: string;
  kind: string;
  path: string;
  ok: boolean;
  items: number;
  warnings: string[];
}

export interface Snapshot {
  generatedAt: string;
  sources: SourceStatus[];
  runs: RunSummary[];
  gateHistory: { source: string; snapshots: GateSnapshot[]; checkRuns: CheckRun[] }[];
  reviews: { source: string; findings: ReviewFindings[] }[];
  traces: TraceChain[];
  experiments: ExperimentView[];
  dailyCost: DailyCost[];
  costPerAccepted: CostPerAccepted[];
  gaps: string[];
}
