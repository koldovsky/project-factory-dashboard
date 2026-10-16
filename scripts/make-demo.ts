// Generates a self-contained demo dataset in .demo/ (git-ignored) that exercises every panel:
// project-factory-next runs (claude JSON, claude stream-json, codex JSONL, blocked check, failed preparation,
// stale lock, tampered history), control bundles, a preregistered experiment with a held-out audit split,
// a v2 project (ledger with G0–G8 history, review findings, git trailers) and Claude Code transcripts.
// Everything is fictional; formats are the factories' real on-disk formats.
//
//   node scripts/make-demo.ts [--factory ../project-factory-next]
// With a project-factory-next checkout, the experiment assessment is computed by its own src/learning.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { claudeJsonStdout, claudeStreamStdout, codexJsonl, ledgerEvent, writeClaudeSession, writeNextRun, writeV2Project, type TranscriptTurn } from '../src/demo/builders.ts';
import { sha256 } from '../src/core/hash.ts';

const { values } = parseArgs({ options: { factory: { type: 'string' }, out: { type: 'string' } } });
const out = path.resolve(values.out ?? '.demo');
fs.rmSync(out, { recursive: true, force: true });
const store = path.join(out, 'next', 'runs');
const controlRoot = path.join(out, 'next', 'control');
fs.mkdirSync(store, { recursive: true });

const day = (d: number, h = 9, m = 0) => new Date(Date.UTC(2026, 9, d, h, m));
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

// ---------------- control bundles ----------------
const tasks = {
  'csv-export': {
    title: 'Export the visible usage table as CSV',
    requirements: [
      { id: 'R1', description: 'CSV mirrors the filtered table, RFC 4180 escaping', checkIds: ['behavior'] },
      { id: 'R2', description: 'Formula-like cells are neutralised', checkIds: ['behavior', 'security'] },
      { id: 'R3', description: 'Download control is keyboard accessible', checkIds: ['e2e'] },
    ],
    checks: [
      { id: 'behavior', kind: 'command', dependsOn: [], expectedCases: ['header', 'escaping', 'formula', 'empty'] },
      { id: 'security', kind: 'command', dependsOn: ['behavior'], expectedCases: ['formula-injection'] },
      { id: 'e2e', kind: 'command', dependsOn: ['behavior'], expectedCases: ['keyboard', 'focus'] },
    ],
  },
  'rate-limit': {
    title: 'Rate-limit the public import endpoint',
    requirements: [
      { id: 'R1', description: 'More than 30 requests/minute per key return 429', checkIds: ['build', 'behavior'] },
      { id: 'R2', description: 'Limits survive a restart', checkIds: ['behavior'] },
    ],
    checks: [
      { id: 'build', kind: 'command', dependsOn: [], expectedCases: ['tsc'] },
      { id: 'behavior', kind: 'command', dependsOn: ['build'], expectedCases: ['burst', 'window-reset', 'restart'] },
    ],
  },
  'pricing-page': {
    title: 'Implement the pricing page from the approved design',
    requirements: [
      { id: 'V1', description: 'Matches the reference at 375/768/1440 px', checkIds: ['visual'] },
      { id: 'A1', description: 'No axe violations', checkIds: ['visual'] },
    ],
    checks: [{ id: 'visual', kind: 'visual', dependsOn: [], expectedCases: ['home--mobile', 'home--tablet', 'home--desktop'] }],
  },
};
for (const [id, t] of Object.entries(tasks)) {
  const dir = path.join(controlRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, id, profile: 'software-change', title: t.title, intent: t.title,
    requirements: t.requirements, checks: t.checks.map(c => ({ ...c, timeoutMs: 60000, ...(c.kind === 'visual' ? { config: 'visual.json', referenceDir: 'references' } : { argv: ['node', `{control}/evaluators/${c.id}.mjs`] }) })),
    budget: { maxAttempts: 3, agentTimeoutMs: 600000 } }, null, 2));
}

// ---------------- next-gen runs ----------------
const claude = (costUsd: number, turns: number, result: string, output = 9000) => ({
  status: 'completed', exitCode: 0, durationMs: 120_000 + turns * 9000, stderr: '', truncated: false, outputBytes: 4000,
  stdout: claudeJsonStdout({ costUsd, model: SONNET, turns, result, input: 2400, output, cacheWrite: 18000, cacheRead: 410000 }),
});
const cases = (ids: string[], failed: Record<string, string> = {}) => ids.map(id => failed[id] ? { id, status: 'failed', details: failed[id] } : { id, status: 'passed' });
const check = (id: string, ids: string[], failed: Record<string, string> = {}, durationMs = 900) => {
  const c = cases(ids, failed);
  return { id, status: c.every(x => x.status === 'passed') ? 'passed' : 'failed', cases: c, durationMs, exitCode: c.every(x => x.status === 'passed') ? 0 : 1 };
};
const blocked = (id: string) => ({ id, status: 'blocked', reason: 'A required producer/dependency did not pass' });

writeNextRun(store, { id: 'csv-export-01', taskId: 'csv-export', agent: 'claude', model: SONNET, maxBudgetUsd: 2, start: day(6, 8, 10), final: 'passed', attempts: [
  { builder: claude(0.58, 14, 'Implemented toSummaryCsv and the download control.'),
    checks: [check('behavior', ['header', 'escaping', 'formula', 'empty'], { formula: "Expected '\\'=SUM(A1)' but got '=SUM(A1)'" }), blocked('security'), blocked('e2e')] },
  { builder: claude(0.31, 7, 'Prefixed formula-like cells; added keyboard handler.', 4200),
    checks: [check('behavior', ['header', 'escaping', 'formula', 'empty']), check('security', ['formula-injection']), check('e2e', ['keyboard', 'focus'], {}, 14000)] },
] });

writeNextRun(store, { id: 'csv-export-02-codex', taskId: 'csv-export', agent: 'codex', model: null, start: day(7, 13, 0), final: 'failed', attempts: [
  { builder: { status: 'completed', exitCode: 0, durationMs: 240_000, stderr: '', truncated: false, stdout: codexJsonl({
    commands: [{ command: 'npm test -- csv', exit: 1 }, { command: 'npm test -- csv', exit: 0 }], files: ['src/csv.ts', 'src/export-control.tsx'],
    message: 'CSV export implemented; tests pass locally.', turns: [{ input: 48000, cached: 30000, output: 5200 }, { input: 22000, cached: 18000, output: 1900 }] }) },
    checks: [check('behavior', ['header', 'escaping', 'formula', 'empty']), check('security', ['formula-injection']), check('e2e', ['keyboard', 'focus'], { focus: 'No visible focus ring on the download control' }, 13000)] },
  { builder: { status: 'timeout', exitCode: null, durationMs: 600_000, stdout: '', stderr: '', truncated: false, error: 'Agent exceeded 600000 ms' } },
  { builder: { status: 'completed', exitCode: 0, durationMs: 200_000, stderr: '', truncated: false, stdout: codexJsonl({
    commands: [{ command: 'npm run e2e', exit: 0 }], files: ['src/export-control.tsx'], message: 'Added focus-visible style.', turns: [{ input: 30000, cached: 25000, output: 1400 }] }) },
    checks: [check('behavior', ['header', 'escaping', 'formula', 'empty']), check('security', ['formula-injection']), check('e2e', ['keyboard', 'focus'], { focus: 'Focus ring contrast 1.9:1 (needs 3:1)' }, 12500)] },
] });

writeNextRun(store, { id: 'rate-limit-01', taskId: 'rate-limit', agent: 'claude', model: OPUS, maxBudgetUsd: 3, start: day(8, 10, 0), final: 'failed', attempts: [
  { builder: { ...claude(0.94, 21, 'Added a token bucket in middleware.', 15000), stdout: claudeJsonStdout({ costUsd: 0.94, model: OPUS, turns: 21, result: 'Added a token bucket in middleware.', input: 3000, output: 15000, cacheWrite: 30000, cacheRead: 690000 }) },
    checks: [check('build', ['tsc'], { tsc: "src/limit.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'." }, 4200), blocked('behavior')] },
  { builder: { ...claude(0.66, 15, 'Fixed the type error; persisted counters in memory.', 9000), stdout: claudeJsonStdout({ costUsd: 0.66, model: OPUS, turns: 15, result: 'Fixed the type error.', input: 2000, output: 9000, cacheWrite: 12000, cacheRead: 520000 }) },
    checks: [check('build', ['tsc'], {}, 4100), check('behavior', ['burst', 'window-reset', 'restart'], { restart: 'After restart the key got 30 fresh requests (limit not persisted)' }, 3800)] },
  { builder: { status: 'output-limit', exitCode: null, durationMs: 310_000, stderr: '', truncated: true, outputBytes: 1_200_000, stdout: '{"type":"result","subtype":"success","num_turns":40,"result":"' + 'x'.repeat(200) } },
] });

writeNextRun(store, { id: 'rate-limit-02', taskId: 'rate-limit', agent: 'claude', model: SONNET, start: day(9, 9, 30), final: 'passed', attempts: [
  { builder: { status: 'completed', exitCode: 0, durationMs: 380_000, stderr: '', truncated: false, stdout: claudeStreamStdout({ model: SONNET, costUsd: 0.47, tools: [
    { name: 'Grep', input: { pattern: 'rateLimit' } }, { name: 'Read', input: { file_path: 'src/limit.ts' } }, { name: 'Read', input: { file_path: 'src/store/kv.ts' } },
    { name: 'Edit', input: { file_path: 'src/limit.ts' } }, { name: 'Write', input: { file_path: 'src/store/limit-store.ts' } }, { name: 'Edit', input: { file_path: 'src/server.ts' } }] }) },
    checks: [check('build', ['tsc'], {}, 4000), check('behavior', ['burst', 'window-reset', 'restart'], {}, 5200)] },
] });

writeNextRun(store, { id: 'pricing-page-01', taskId: 'pricing-page', agent: 'claude', model: SONNET, start: day(10, 14, 0), final: 'passed', attempts: [
  { builder: claude(0.72, 18, 'Built the pricing page from the reference.', 12000),
    preparation: [{ id: 'build', status: 'failed', durationMs: 21000, exitCode: 1, reason: 'Preparation process failed (exit 1): next build — Module not found: ./PlanCard' }] },
  { builder: claude(0.39, 9, 'Restored PlanCard import; matched spacing at 375px.', 6000), preparation: [{ id: 'build', status: 'passed', durationMs: 19000, exitCode: 0 }],
    checks: [check('visual', ['home--mobile', 'home--tablet', 'home--desktop'], {}, 41000)] },
] });

writeNextRun(store, { id: 'pricing-page-02', taskId: 'pricing-page', agent: 'claude', model: SONNET, start: day(13, 16, 0), final: null, inProgress: 'evaluating',
  lockPid: 4_194_000, attempts: [{ builder: claude(0.44, 10, 'Adjusted the tablet layout.', 7000), preparation: [{ id: 'build', status: 'passed', durationMs: 18000, exitCode: 0 }] }] });

const tampered = writeNextRun(store, { id: 'csv-export-03-edited', taskId: 'csv-export', agent: 'manual', start: day(11, 11, 0), final: 'failed',
  attempts: [{ checks: [check('behavior', ['header', 'escaping', 'formula', 'empty'], { escaping: 'Quotes not doubled' }), blocked('security'), blocked('e2e')] }] });
{ // Someone "fixed" the outcome by hand: the hash chain exposes it.
  const file = path.join(tampered, 'run.json');
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.history.at(-2).details.failedChecks = [];
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
}

// ---------------- experiment with a held-out audit split ----------------
const experimentFile = path.join(out, 'next', 'experiment.json');
const assessmentFile = path.join(out, 'next', 'assessment.json');
{
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
  const splits = { development: ids('dev', 12), selection: ids('sel', 8), finalAudit: ids('audit', 16) };
  const env = sha256('worker-image-2026-10');
  const parent = { version: sha256('factory@parent').slice(0, 40), model: SONNET, environmentDigest: env };
  const candidate = { version: sha256('factory@readiness-prompt').slice(0, 40), model: SONNET, environmentDigest: env };
  let k = 0;
  const runs = splits.finalAudit.flatMap(taskId => {
    const i = k++;
    const startedAt = new Date(Date.UTC(2026, 9, 12, 8, i * 3)).toISOString();
    return [
      { taskId, arm: 'parent', ...parent, startedAt, accepted: i % 3 !== 0, quality: 0.78, costUSD: 0.9 + (i % 4) * 0.12, humanMinutes: 6, criticalFailures: 0 },
      { taskId, arm: 'candidate', ...candidate, startedAt, accepted: i % 5 !== 0, quality: 0.83, costUSD: 0.95 + (i % 3) * 0.1, humanMinutes: 5, criticalFailures: 0 },
    ];
  });
  const experiment = { schemaVersion: 1, id: 'readiness-prompt-audit', stage: 'final-audit', registeredAt: '2026-10-01T08:00:00.000Z', candidateFrozenAt: '2026-10-05T08:00:00.000Z',
    parent, candidate, splits, policy: { minPairs: 16, confidence: 0.9, minAcceptedGain: 0.05, maxQualityLoss: 0.02, minCandidateQuality: 0.7, maxCostRatio: 1.2,
      maxHumanMinutesIncrease: 2, costUpperBoundUSD: 5, humanUpperBoundMinutes: 60 },
    audit: { evaluationRevision: sha256('evaluator@2026-10').slice(0, 40), evidenceDigest: sha256('audit-evidence'), conductedBy: 'release-evaluator', heldOutUntil: '2026-10-12T07:00:00.000Z' }, runs };
  fs.writeFileSync(experimentFile, JSON.stringify(experiment, null, 2));
  const factory = values.factory ?? ['../project-factory-next', '../../project-factory-next'].find(p => fs.existsSync(path.join(p, 'src', 'learning.mjs')));
  if (factory) {
    const { assessExperiment } = await import(pathToFileURL(path.resolve(factory, 'src', 'learning.mjs')).href);
    fs.writeFileSync(assessmentFile, JSON.stringify(assessExperiment(experiment), null, 2));
    console.log(`assessment computed by ${path.resolve(factory)}/src/learning.mjs`);
  } else console.log('No project-factory-next checkout found: experiment written without an assessment');
}

// ---------------- v2 project with Claude Code transcripts ----------------
const project = path.join(out, 'v2', 'token-shop');
const gates = (values: string) => Object.fromEntries(values.split(' ').map((v, i) => [`G${i}`, { P: 'PASS', F: 'FAIL', N: 'NOT-EARNED', S: 'needs sign-off', K: 'SKIP-pending' }[v]]));
const gateRun = (at: Date, phase: string, frontier: string, g: string, openCorrections = 0) =>
  ledgerEvent(at, 'gate-status-run', 'gate-status', { exitCode: g.includes('F') || g.includes('N') ? 1 : 0, scope_n: 4, phase, meta: { frontier, gates: gates(g), divergences: 0, openCorrections, unrecordedCorrections: 0, productCode: true } });
writeV2Project(project, {
  requirements: [
    { id: 'FR-CART-01', description: 'Cart keeps items across reloads' }, { id: 'FR-CART-02', description: 'Quantity changes recalculate totals' },
    { id: 'FR-PAY-01', description: 'Checkout hands off to the payment provider sandbox' }, { id: 'FR-PAY-02', description: 'Failed payments show a recoverable error' },
    { id: 'NFR-A11Y-01', description: 'All flows are keyboard operable' }, { id: 'BC-PRIVACY-01', description: 'No card data touches our servers' },
    { id: 'FR-SEARCH-01', description: 'Search by product name' },
  ],
  ledger: [
    gateRun(day(2, 9), '0', 'G0', 'P K K K K K K K K'),
    ledgerEvent(day(2, 10), 'check-run', 'traceability', { scope_n: 0 }),
    gateRun(day(3, 9), '2', 'G2', 'P S P K K K K K K'),
    gateRun(day(5, 17), '3', 'G3', 'P P P P N N N N K'),
    ledgerEvent(day(6, 11), 'check-run', 'recordings', { scope_n: 0 }),
    ledgerEvent(day(6, 12), 'battery-run', 'qa-verify', { exitCode: 1, scope_n: 6, durationMs: 41000, meta: { overall: 'NOT-EARNED (1 member(s) unearned)' } }),
    gateRun(day(7, 18), '4', 'G4', 'P P P P F N N F K', 1),
    ledgerEvent(day(8, 15), 'battery-run', 'qa-verify', { exitCode: 0, scope_n: 9, durationMs: 39000, meta: { overall: 'Pass' } }),
    gateRun(day(9, 18), '4', 'G4', 'P P P P P N N N K'),
    gateRun(day(12, 18), '5', 'G5', 'P P P P P P N F K'),
    gateRun(day(14, 18), '6', 'G6', 'P P P P P P P N K'),
  ],
  changes: [
    { name: '01-cart', archivedOn: '2026-10-06', findings: { generatedBy: 'review-gate', scope: '01-cart', change: '01-cart', baseRef: 'g3', headRef: 'HEAD',
      dimensions: { correctness: { confirmed: 0, contested: 0, rejected: 2 }, security: { confirmed: 0, contested: 0, rejected: 1 }, 'spec-compliance': { confirmed: 0, contested: 0, rejected: 0 }, visual: { confirmed: 0, contested: 0, rejected: 0 } },
      confirmedTitles: [], clean: true, generatedAt: '2026-10-06T15:12:00Z' } },
    { name: '02-checkout', archivedOn: '2026-10-09', findings: { generatedBy: 'review-gate', scope: '02-checkout', change: '02-checkout', baseRef: '01-cart', headRef: 'HEAD',
      dimensions: { correctness: { confirmed: 0, contested: 0, rejected: 1 }, security: { confirmed: 0, contested: 0, rejected: 2 }, 'spec-compliance': { confirmed: 0, contested: 0, rejected: 0 }, visual: { confirmed: 0, contested: 0, rejected: 1 } },
      confirmedTitles: [], clean: true, generatedAt: '2026-10-09T17:40:00Z' } },
    { name: '03-a11y', findings: { generatedBy: 'review-gate', scope: '03-a11y', change: '03-a11y', baseRef: '02-checkout', headRef: 'HEAD',
      dimensions: { correctness: { confirmed: 1, contested: 0, rejected: 0 }, security: { confirmed: 0, contested: 0, rejected: 0 }, 'spec-compliance': { confirmed: 1, contested: 1, rejected: 0 }, visual: { confirmed: 1, contested: 0, rejected: 0 } },
      confirmedTitles: ['Focus is lost after closing the cart drawer', 'Scenario "Skip link" has no test', 'Checkout button contrast 2.8:1 in the disabled state'], clean: false, generatedAt: '2026-10-13T16:05:00Z' } },
  ],
  commits: [
    { subject: 'chore(factory): onboard project factory (G0)', at: day(2, 9) },
    { subject: 'docs(factory): requirements and capability plan (G1–G3)', at: day(3, 16) },
    { subject: 'test(cart): red tests for 01-cart', slice: '01-cart', refs: ['FR-CART-01', 'FR-CART-02'], at: day(5, 10) },
    { subject: 'feat(cart): persistent cart with recalculated totals', slice: '01-cart', refs: ['FR-CART-01', 'FR-CART-02'], at: day(6, 11) },
    { subject: 'fix(cart): address review-gate findings', slice: '01-cart', refs: ['FR-CART-02'], at: day(6, 14) },
    { subject: 'feat(pay): sandbox checkout hand-off', slice: '02-checkout', refs: ['FR-PAY-01', 'FR-PAY-02', 'BC-PRIVACY-01'], at: day(8, 12) },
    { subject: 'fix(pay): recoverable payment error state', slice: '02-checkout', refs: ['FR-PAY-02'], at: day(9, 10) },
    { subject: 'feat(a11y): keyboard support for cart and checkout', slice: '03-a11y', refs: ['NFR-A11Y-01'], at: day(12, 15) },
    { subject: 'feat: tweak header spacing', at: day(13, 9) },
  ],
});

const claudeRoot = path.join(out, 'claude-projects');
const at = (d: number, h: number, m = 0) => day(d, h, m);
const turns = (d: number, h: number, n: number, model: string, scale = 1, tools: string[] = []): TranscriptTurn[] => Array.from({ length: n }, (_, i) => ({
  at: at(d, h, i * 3), model, input: Math.round(300 * scale), output: Math.round(2200 * scale), cacheWrite: Math.round(9000 * scale), cacheRead: Math.round(140000 * scale),
  tools: tools.length ? [{ name: tools[i % tools.length], input: { file_path: `src/${['cart', 'checkout', 'a11y'][i % 3]}.ts`, command: 'npm test' } }] : [],
}));
const OPUS48 = 'claude-opus-4-8';
const reviewGate = (runId: string, change: string, d: number, h: number, confirmed: object[], rejected: object[]) => {
  const start = at(d, h).getTime();
  const agents = [
    ...['correctness', 'security', 'spec-compliance', 'visual'].map((dim, i) => ({ type: 'workflow_agent', index: i + 1, label: `find:${dim}`, phaseTitle: 'Find', agentId: `${runId}f${i}`, model: OPUS48, state: 'done', startedAt: start + i * 4000, durationMs: 180_000 + i * 20_000, toolCalls: 14 + i * 3, tokens: 400_000 })),
    ...[...confirmed, ...rejected].flatMap((f: any, j) => ['correctness', 'exploitability'].map((lens, k) => ({ type: 'workflow_agent', index: 10 + j * 2 + k, label: `verify:${f.file}`, phaseTitle: 'Verify', agentId: `${runId}v${j}${k}`, model: OPUS48, state: 'done', startedAt: start + 260_000 + j * 5000, durationMs: 70_000, toolCalls: 6, tokens: 120_000 }))),
    { type: 'workflow_agent', index: 99, label: `persist:${change}`, phaseTitle: 'Persist', agentId: `${runId}p`, model: OPUS48, state: 'done', startedAt: start + 420_000, durationMs: 20_000, toolCalls: 2, tokens: 30_000 },
  ];
  return {
    file: { runId, workflowName: 'review-gate', status: 'completed', startTime: start, durationMs: 450_000, defaultModel: OPUS48, agentCount: agents.length,
      phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Report' }, { title: 'Persist' }],
      workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Find' }, ...agents.slice(0, 4), { type: 'workflow_phase', index: 2, title: 'Verify' }, ...agents.slice(4, -1), { type: 'workflow_phase', index: 4, title: 'Persist' }, agents.at(-1)],
      result: { scope: change, summary: `Review gate for ${change}`, confirmed, contested: [], rejected, reviewEvidence: `openspec/changes/${change}/review-findings.json` } },
    agents: agents.map((a, i) => ({ agentId: a.agentId, turns: turns(d, h, a.label.startsWith('find:') ? 6 : 2, OPUS48, a.label.startsWith('find:') ? 1.4 : 0.6, ['Read', 'Grep', 'Bash']).map(t => ({ ...t, at: new Date(a.startedAt + i * 1000) })) })),
  };
};
const finding = (title: string, file: string, dimension: string, severity: string, verdict: string) => ({ title, file, line: 12, severity, dimension, verdict, evidence: '…', suggestion: '…', verifierNotes: verdict === 'rejected' ? ['Guarded upstream', 'Unreachable for real users'] : [] });
const sessions = [
  { sessionId: '5c01ca57-0001-4000-8000-000000000001', title: 'Slice 01-cart', d: 5, change: '01-cart',
    review: reviewGate('wf_demo01', '01-cart', 6, 13, [], [finding('Race on concurrent quantity update', 'src/cart.ts', 'correctness', 'major', 'rejected'), finding('Stored XSS in item note', 'src/cart.ts', 'security', 'critical', 'rejected')]) },
  { sessionId: '7e02c4ec-0002-4000-8000-000000000002', title: 'Slice 02-checkout', d: 8, change: '02-checkout',
    review: reviewGate('wf_demo02', '02-checkout', 9, 15, [], [finding('Card number logged on error', 'src/checkout.ts', 'security', 'critical', 'rejected')]) },
  { sessionId: '9a03a11e-0003-4000-8000-000000000003', title: 'Slice 03-a11y', d: 12, change: '03-a11y',
    review: reviewGate('wf_demo03', '03-a11y', 13, 14, [finding('Focus is lost after closing the cart drawer', 'src/a11y.ts', 'correctness', 'major', 'confirmed'), finding('Checkout button contrast 2.8:1 in the disabled state', 'src/checkout.ts', 'visual', 'minor', 'confirmed')], []) },
];
for (const s of sessions) {
  writeClaudeSession(claudeRoot, project, {
    sessionId: s.sessionId, title: s.title,
    turns: [
      ...turns(s.d, 9, 3, OPUS48, 1, ['Read', 'Skill']),
      { at: at(s.d, 10), model: OPUS48, input: 200, output: 900, cacheWrite: 4000, cacheRead: 120000, tools: [
        { name: 'Agent', input: { subagent_type: 'project-factory:spec-writer', description: `Author ${s.change} spec delta` } },
        { name: 'Agent', input: { subagent_type: 'project-factory:test-engineer', description: `Red tests for ${s.change}` } }] },
      { at: at(s.d, 11), model: OPUS48, input: 200, output: 700, cacheWrite: 3000, cacheRead: 130000, tools: [
        { name: 'Agent', input: { subagent_type: 'capability-implementer', description: `Implement ${s.change} (green)` } }] },
      { at: at(s.d + 1, s.review.file.startTime ? new Date(s.review.file.startTime as number).getUTCHours() : 13), model: OPUS48, input: 200, output: 500, cacheWrite: 2000, cacheRead: 150000, tools: [
        { name: 'Workflow', input: { name: 'review-gate' } }] },
    ],
    subagents: [
      { agentId: `${s.change}-spec`, agentType: 'project-factory:spec-writer', description: `Author ${s.change} spec delta`, turns: turns(s.d, 10, 4, SONNET, 0.8, ['Read', 'Write']) },
      { agentId: `${s.change}-test`, agentType: 'project-factory:test-engineer', description: `Red tests for ${s.change}`, turns: turns(s.d, 10, 5, SONNET, 0.9, ['Write', 'Bash']) },
      { agentId: `${s.change}-impl`, agentType: 'capability-implementer', description: `Implement ${s.change} (green)`, turns: turns(s.d, 11, 9, OPUS48, 1.2, ['Read', 'Edit', 'Bash']) },
    ],
    workflows: [s.review],
  });
}

const config = {
  sources: [
    { name: 'demo next-gen store', kind: 'next-store', path: 'next/runs', control: Object.keys(tasks).map(t => `next/control/${t}`),
      experiments: [{ experiment: 'next/experiment.json', ...(fs.existsSync(assessmentFile) ? { assessment: 'next/assessment.json' } : {}) }] },
    { name: 'demo v2 project (token-shop)', kind: 'v2-project', path: 'v2/token-shop', transcripts: 'auto' },
  ],
  claudeProjectsRoot: 'claude-projects',
  cacheFile: null,
};
fs.writeFileSync(path.join(out, 'factory-dash.config.json'), JSON.stringify(config, null, 2));
console.log(`Demo dataset written to ${out}`);
