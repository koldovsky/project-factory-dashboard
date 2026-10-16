import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptCache, findTranscriptDirs, parseTranscript, readClaudeProject, roleForAgent } from '../src/core/claude-code.ts';
import { PriceTable } from '../src/core/pricing.ts';
import { projectSlug, transcriptLines, writeClaudeSession } from '../src/demo/builders.ts';

const prices = new PriceTable();
const t0 = new Date('2026-09-22T12:00:00.000Z');
const turn = (minutes: number, extra: object = {}) => ({ at: new Date(t0.getTime() + minutes * 60_000), model: 'claude-opus-4-8',
  input: 100, output: 1000, cacheWrite: 2000, cacheRead: 30000, ...extra });

describe('transcript parsing', () => {
  it('counts a message usage once although Claude Code repeats it on every content-block line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-tr-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, transcriptLines({ sessionId: 's', cwd: '/p', turns: [
      turn(0, { tools: [{ name: 'Read', input: { file_path: 'a' } }, { name: 'Agent', input: { subagent_type: 'code-reviewer', description: 'Review slice' } }] }),
      turn(5),
    ] }));
    const stats = await parseTranscript(file);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.duplicateUsageLines).toBe(2);
    expect(stats.models['claude-opus-4-8']).toEqual({ input: 200, output: 2000, cacheWrite: 4000, cacheRead: 60000 });
    expect(stats.toolCalls).toBe(2);
    expect(stats.events.find(e => e.tool === 'Agent')?.subagentType).toBe('code-reviewer');
  });

  it('assigns maker/checker/verifier roles from subagent types and workflow labels', () => {
    expect(['capability-implementer', 'code-reviewer', 'security-reviewer', 'spec-compliance-auditor', 'find:correctness', 'verify:src/a.ts', 'persist:01', 'draft:feeds']
      .map(roleForAgent)).toEqual(['maker', 'checker', 'checker', 'checker', 'checker', 'verifier', 'writer', 'maker']);
  });
});

describe('project sessions and workflows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cc-'));
  const project = path.join(root, 'work', 'shop');
  fs.mkdirSync(project, { recursive: true });
  writeClaudeSession(path.join(root, 'projects'), project, {
    sessionId: 'sess-1', title: 'Slice 01', turns: [turn(0, { tools: [{ name: 'Agent', input: { subagent_type: 'capability-implementer', description: 'Implement 01' } }] })],
    subagents: [{ agentId: 'impl1', agentType: 'project-factory:capability-implementer', description: 'Implement 01 (green)', turns: [turn(1), turn(2)] }],
    workflows: [{
      file: { runId: 'wf_1', workflowName: 'review-gate', status: 'completed', startTime: t0.getTime() + 600_000, durationMs: 300_000, defaultModel: 'claude-opus-4-8',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Find' },
          { type: 'workflow_agent', label: 'find:correctness', agentId: 'f1', model: 'claude-opus-4-8', state: 'done', startedAt: t0.getTime() + 600_000, tokens: 9000, toolCalls: 4, durationMs: 60_000 },
          { type: 'workflow_agent', label: 'verify:src/a.ts', agentId: 'v1', model: 'claude-opus-4-8', state: 'done', startedAt: t0.getTime() + 700_000, tokens: 3000, toolCalls: 2, durationMs: 30_000 },
          { type: 'workflow_agent', label: 'verify:src/b.ts', agentId: 'missing', model: 'claude-opus-4-8', state: 'done', startedAt: t0.getTime() + 700_000, tokens: 3000 },
        ],
        result: { scope: '01-export', summary: 'x', reviewEvidence: 'openspec/changes/01-export/review-findings.json',
          confirmed: [{ title: 'Off-by-one in pager', file: 'src/a.ts', line: 3, severity: 'major', dimension: 'correctness', verdict: 'confirmed', verifierNotes: ['a', 'b'] }],
          contested: [], rejected: [{ title: 'SQL injection', file: 'src/b.ts', severity: 'critical', dimension: 'security', verdict: 'rejected', verifierNotes: ['guarded'] }] } },
      agents: [{ agentId: 'f1', turns: [turn(10)] }, { agentId: 'v1', turns: [turn(11)] }],
    }],
  });
  // A folder whose name collides with the slug but whose transcripts belong to another cwd.
  const impostor = path.join(root, 'projects', `${projectSlug(project)}-other`);
  fs.mkdirSync(impostor, { recursive: true });
  fs.writeFileSync(path.join(impostor, 'x.jsonl'), transcriptLines({ sessionId: 'x', cwd: `${project}-other`, turns: [turn(0)] }));

  it('finds transcript folders by the cwd recorded inside them', async () => {
    const dirs = await findTranscriptDirs(project, path.join(root, 'projects'));
    expect(dirs).toEqual([path.join(root, 'projects', projectSlug(project))]);
  });

  it('builds a session run with maker subagents and a workflow run with checker/verifier agents and findings', async () => {
    const dirs = await findTranscriptDirs(project, path.join(root, 'projects'));
    const { runs } = await readClaudeProject(dirs, { prices, cache: new TranscriptCache(), sourceName: 'p', now: t0.getTime() + 86_400_000 });
    const session = runs.find(r => r.kind === 'session')!;
    const workflow = runs.find(r => r.kind === 'workflow')!;
    expect(session.agents.map(a => a.role)).toEqual(['orchestrator', 'maker']);
    expect(session.events.find(e => e.kind === 'handoff')).toMatchObject({ role: 'maker', title: '→ capability-implementer' });
    expect(session.cost.provenance).toBe('estimated');
    expect(session.cost.usd).toBeCloseTo(3 * (100 * 5 + 1000 * 25 + 2000 * 6.25 + 30000 * 0.5) / 1e6, 9);

    expect(workflow.feature).toBe('01-export');
    expect(workflow.agents.map(a => a.role)).toEqual(['checker', 'verifier', 'verifier']);
    // The agent without a transcript has only a total token count: its cost stays unknown, the run total is partial.
    expect(workflow.agents[2].cost.usd).toBeNull();
    expect(workflow.cost.partial).toBe(true);
    expect(workflow.gates.find(g => g.id === 'review-confirmed')).toMatchObject({ status: 'fail', raw: '1' });
    expect(workflow.events.filter(e => e.kind === 'finding').map(e => e.status)).toEqual(['confirmed', 'rejected']);
    expect(workflow.failure).toMatch(/not clean/);
  });
});
