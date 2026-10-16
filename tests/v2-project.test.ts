import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateStatusFromLabel, parseLedger, parseRequirements, readGitTrailers, readReviewFindings, v2Trace } from '../src/core/v2-project.ts';
import { ledgerEvent, writeV2Project } from '../src/demo/builders.ts';

describe('ledger.jsonl', () => {
  it('keeps three-valued gate semantics: NOT-EARNED, sign-off and SKIP-pending never become PASS', () => {
    expect(['PASS', 'FAIL', 'NOT-EARNED', 'NOT-EARNED (2 member(s) unearned)', 'needs sign-off', 'SKIP-pending', 'retrofit', '???'].map(gateStatusFromLabel))
      .toEqual(['pass', 'fail', 'not-earned', 'not-earned', 'needs-signoff', 'pending', 'not-earned', 'unknown']);
  });

  it('parses gate-status runs (real event shape) and flags vacuous check runs', () => {
    const lines = [
      // Verbatim shape from a real project ledger (token-atlas, 2026-09-22).
      '{"ts":"2026-09-22T15:22:25.133Z","event":"gate-status-run","check":"gate-status","exitCode":1,"failures":null,"warnings":null,"warningsByClass":{},"scope_n":9,"phase":"4","gitHead":"75b6a1ac3c9e626ece1c89b8836b686392bdb935","dirty":true,"durationMs":null,"meta":{"frontier":"G4","gates":{"G0":"PASS","G1":"needs sign-off","G2":"PASS","G3":"needs sign-off","G4":"PASS","G5":"NOT-EARNED","G6":"NOT-EARNED","G7":"FAIL","G8":"PASS"},"divergences":0,"openCorrections":0,"unrecordedCorrections":0,"productCode":true}}',
      JSON.stringify(ledgerEvent(new Date('2026-09-22T15:00:00Z'), 'check-run', 'recordings', { scope_n: 0 })),
      JSON.stringify(ledgerEvent(new Date('2026-09-22T15:01:00Z'), 'battery-run', 'qa-verify', { exitCode: 1, scope_n: 14, meta: { overall: 'NOT-EARNED (2 member(s) unearned)' } })),
      '{not json',
      '',
    ];
    const ledger = parseLedger(lines.join('\n'));
    expect(ledger.badLines).toBe(1);
    expect(ledger.snapshots).toHaveLength(1);
    const snap = ledger.snapshots[0];
    expect(snap.frontier).toBe('G4');
    expect(snap.gates.map(g => g.id)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
    expect(snap.gates.find(g => g.id === 'G5')).toMatchObject({ status: 'not-earned', raw: 'NOT-EARNED' });
    expect(snap.gates.find(g => g.id === 'G1')?.status).toBe('needs-signoff');
    expect(ledger.checkRuns[0]).toMatchObject({ check: 'recordings', vacuous: true });
    expect(ledger.checkRuns[1]).toMatchObject({ check: 'qa-verify', vacuous: false, overall: 'NOT-EARNED (2 member(s) unearned)' });
  });
});

describe('requirements registry', () => {
  it('collects IDs from table rows only, once', () => {
    const reqs = parseRequirements([
      '| ID | MVP | Area | Text | Verification |',
      '| FR-CSV-01 | MVP | Export | The dashboard offers a Download CSV action | local-verifiable |',
      '| NFR-PERF-2 | MVP | Perf | Renders in under a second on a laptop | e2e |',
      'Prose mentioning FR-CSV-01 again and BUG-9 is not a registry row.',
    ].join('\n'));
    expect(reqs.map(r => r.id)).toEqual(['FR-CSV-01', 'NFR-PERF-2']);
    expect(reqs[0].description).toMatch(/Download CSV/);
  });
});

describe('project on disk: findings, trailers and trace chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-v2-'));
  writeV2Project(dir, {
    requirements: [{ id: 'FR-1', description: 'Export CSV' }, { id: 'FR-2', description: 'Empty state' }, { id: 'FR-3', description: 'Never started' }],
    ledger: [],
    changes: [
      { name: '01-export', archivedOn: '2026-09-20', findings: { generatedBy: 'review-gate', change: '01-export', dimensions: { correctness: { confirmed: 0, contested: 0, rejected: 2 } }, confirmedTitles: [], clean: true, generatedAt: '2026-09-20T10:00:00Z' } },
      // clean:false with zero confirmed: informational "Clean:" entries count as findings in that factory version.
      { name: '02-empty', findings: { generatedBy: 'review-gate', change: '02-empty', dimensions: { security: { confirmed: 0, contested: 1, rejected: 0 } }, confirmedTitles: ['Clean: no secrets'], clean: false, generatedAt: 'WRITER_FILL_ISO_UTC' } },
    ],
    commits: [
      { subject: 'feat(csv): export', slice: '01-export', refs: ['FR-1'], at: new Date('2026-09-20T09:00:00Z') },
      { subject: 'feat(ui): empty state', slice: '02-empty', refs: ['FR-2', 'FR-1'], at: new Date('2026-09-21T09:00:00Z') },
      { subject: 'feat: untraced tweak', at: new Date('2026-09-21T10:00:00Z') },
    ],
  });

  it('reads review findings with clean exactly as written', () => {
    const findings = readReviewFindings(dir);
    expect(findings.map(f => [f.change, f.archived, f.clean])).toEqual([['02-empty', false, false], ['01-export', true, true]]);
    expect(findings[0].generatedAt).toBeNull(); // unstamped placeholder is not a timestamp
  });

  it('reads Slice/Refs trailers with git log (no shell)', () => {
    const { commits, warning } = readGitTrailers(dir);
    expect(warning).toBeNull();
    expect(commits.map(c => [c.subject, c.slices, c.refs])).toEqual([
      ['feat: untraced tweak', [], []],
      ['feat(ui): empty state', ['02-empty'], ['FR-2', 'FR-1']],
      ['feat(csv): export', ['01-export'], ['FR-1']],
    ]);
  });

  it('builds requirement → commit → slice → review status', () => {
    const { commits } = readGitTrailers(dir);
    const trace = v2Trace(dir, 'demo', commits, readReviewFindings(dir));
    const byId = Object.fromEntries(trace.requirements.map(r => [r.id, r]));
    expect(byId['FR-1'].status).toBe('fail'); // also touched by 02-empty whose review is not clean
    expect(byId['FR-2'].status).toBe('fail');
    expect(byId['FR-3'].status).toBe('unknown'); // no commit references it
    expect(trace.untracedCommits).toBe(1);
  });
});
