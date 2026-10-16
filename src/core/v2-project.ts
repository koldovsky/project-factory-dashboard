// Adapter for a target project built with the v2 project-factory methodology (koldovsky/project-factory):
// trace/ledger.jsonl (append-only process telemetry incl. G0–G8 gate-status runs),
// openspec/changes/**/review-findings.json (review-gate output with its `clean` flag),
// git trailers `Slice:` / `Refs:` enforced by the commit-msg hook, docs/requirements.md (FR/NFR/… registry).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CheckRun, GateResult, GateSnapshot, GateStatus, ReviewFindings, TraceChain, TraceCommit, TraceRequirement } from './types.ts';

export const GATE_LABELS: Record<string, string> = {
  G0: 'Scaffold & environment', G1: 'Product framing', G2: 'Baseline specs', G3: 'Capability plan',
  G4: 'Per slice', G5: 'Cross-cutting hardening', G6: 'QA proof pack', G7: 'Global review & release', G8: 'UAT round',
};

/** gate-status prints PASS / FAIL / NOT-EARNED / SKIP-pending / "needs sign-off"; keep each distinct. */
export function gateStatusFromLabel(raw: string): GateStatus {
  const v = raw.trim().toUpperCase();
  if (v === 'PASS') return 'pass';
  if (v === 'FAIL') return 'fail';
  if (v.startsWith('NOT-EARNED') || v.startsWith('NOT EARNED')) return 'not-earned';
  if (v.startsWith('SKIP')) return 'pending';
  if (v.includes('SIGN-OFF') || v.includes('SIGN OFF')) return 'needs-signoff';
  if (v.startsWith('RETROFIT')) return 'not-earned';
  return 'unknown';
}

interface LedgerEvent {
  ts: string;
  event: string;
  check: string;
  exitCode: number | null;
  scope_n: number | null;
  phase: string | null;
  gitHead: string | null;
  durationMs: number | null;
  meta: Record<string, unknown> | null;
}

export function parseLedger(text: string): { snapshots: GateSnapshot[]; checkRuns: CheckRun[]; badLines: number } {
  const snapshots: GateSnapshot[] = [];
  const checkRuns: CheckRun[] = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: LedgerEvent;
    try { e = JSON.parse(line); } catch { badLines++; continue; }
    if (!e || typeof e.ts !== 'string') { badLines++; continue; }
    const meta = e.meta ?? {};
    if (e.event === 'gate-status-run' && meta.gates && typeof meta.gates === 'object') {
      const gates: GateResult[] = Object.entries(meta.gates as Record<string, string>)
        .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        .map(([id, raw]) => ({ id, label: GATE_LABELS[id] ?? id, raw: String(raw), status: gateStatusFromLabel(String(raw)) }));
      snapshots.push({ at: e.ts, gitHead: e.gitHead, phase: e.phase, frontier: (meta.frontier as string) ?? null, gates,
        openCorrections: typeof meta.openCorrections === 'number' ? meta.openCorrections : null,
        divergences: typeof meta.divergences === 'number' ? meta.divergences : null });
      continue;
    }
    checkRuns.push({
      at: e.ts, event: e.event, check: e.check, exitCode: e.exitCode ?? null, scopeN: e.scope_n ?? null,
      vacuous: e.exitCode === 0 && e.scope_n === 0, overall: typeof meta.overall === 'string' ? meta.overall : null,
      durationMs: e.durationMs ?? null,
    });
  }
  return { snapshots, checkRuns, badLines };
}

export function readReviewFindings(projectDir: string): ReviewFindings[] {
  const root = path.join(projectDir, 'openspec', 'changes');
  if (!fs.existsSync(root)) return [];
  const found: ReviewFindings[] = [];
  const visit = (dir: string, archived: boolean) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'archive' && !archived) { visit(path.join(dir, entry.name), true); continue; }
      const file = path.join(dir, entry.name, 'review-findings.json');
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        found.push({
          change: raw.change ?? entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, ''), archived,
          path: path.relative(projectDir, file).split(path.sep).join('/'),
          // Shown exactly as written: the dashboard never recomputes `clean` from the counts.
          clean: typeof raw.clean === 'boolean' ? raw.clean : null,
          generatedAt: typeof raw.generatedAt === 'string' && !raw.generatedAt.startsWith('WRITER_FILL') ? raw.generatedAt : null,
          baseRef: raw.baseRef ?? null, headRef: raw.headRef ?? null,
          dimensions: Object.entries((raw.dimensions ?? {}) as Record<string, { confirmed?: number; contested?: number; rejected?: number }>)
            .map(([name, d]) => ({ name, confirmed: d.confirmed ?? 0, contested: d.contested ?? 0, rejected: d.rejected ?? 0 })),
          confirmedTitles: Array.isArray(raw.confirmedTitles) ? raw.confirmedTitles : [],
        });
      } catch { /* unreadable findings are reported by the caller as a warning */ }
    }
  };
  visit(root, false);
  return found;
}

export function archivedChanges(projectDir: string): { name: string; change: string; archivedOn: string | null }[] {
  const dir = path.join(projectDir, 'openspec', 'changes', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const m = e.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    return { name: e.name, change: m ? m[2] : e.name, archivedOn: m ? m[1] : null };
  });
}

const US = '\x1f';
const RS = '\x1e';

export function parseGitLog(output: string): TraceCommit[] {
  return output.split(RS).map(r => r.trim()).filter(Boolean).map(record => {
    const [hash, at, subject, slices, refs] = record.split(US);
    const list = (v = '') => v.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    return { hash, at, subject, slices: list(slices), refs: list(refs) };
  });
}

export function readGitTrailers(projectDir: string, limit = 2000): { commits: TraceCommit[]; warning: string | null } {
  if (!fs.existsSync(path.join(projectDir, '.git'))) return { commits: [], warning: 'Not a git checkout: no Slice/Refs trailers' };
  const format = ['%H', '%aI', '%s', '%(trailers:key=Slice,valueonly,separator=%x2C)', '%(trailers:key=Refs,valueonly,separator=%x2C)'].join('%x1f') + '%x1e';
  const result = spawnSync('git', ['-C', projectDir, 'log', `-n${limit}`, `--format=${format}`], { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return { commits: [], warning: `git log failed: ${(result.stderr || result.error?.message || '').trim()}` };
  return { commits: parseGitLog(result.stdout), warning: null };
}

const REQ_ID = /^\|\s*((?:FR|NFR|TC|BC|BUG)-(?:[A-Z0-9]+-)*\d+)\s*\|(.*)$/;

export function parseRequirements(markdown: string): { id: string; description: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(REQ_ID);
    if (!m || seen.has(m[1])) continue;
    const cells = m[2].split('|').map(c => c.trim()).filter(Boolean);
    const description = cells.sort((a, b) => b.length - a.length)[0] ?? null;
    seen.set(m[1], description && description.length > 220 ? `${description.slice(0, 220)}…` : description);
  }
  return [...seen].map(([id, description]) => ({ id, description }));
}

/**
 * Requirement → commits (Refs:) → slice (Slice:) → review evidence → archived.
 * A requirement with no referencing commit is 'unknown'; a slice is 'pass' only when it is archived
 * and its review evidence says clean:true.
 */
export function v2Trace(projectDir: string, source: string, commits: TraceCommit[], findings: ReviewFindings[]): TraceChain {
  const registryFile = path.join(projectDir, 'docs', 'requirements.md');
  const registry = fs.existsSync(registryFile) ? parseRequirements(fs.readFileSync(registryFile, 'utf8')) : [];
  const ids = new Map(registry.map(r => [r.id, r.description]));
  for (const c of commits) for (const ref of c.refs) if (!ids.has(ref)) ids.set(ref, null);
  const archived = new Set(archivedChanges(projectDir).map(a => a.change));
  const requirements: TraceRequirement[] = [...ids].map(([id, description]) => {
    const referencing = commits.filter(c => c.refs.includes(id));
    const slices = [...new Set(referencing.flatMap(c => c.slices))];
    const links: TraceRequirement['links'] = [
      ...referencing.slice(0, 12).map(c => ({ kind: 'commit' as const, id: `${c.hash.slice(0, 7)} ${c.subject}` })),
      ...slices.map(s => {
        const review = findings.find(f => f.change === s);
        const status: GateStatus = archived.has(s) && review?.clean === true ? 'pass'
          : review?.clean === false ? 'fail' : archived.has(s) ? 'not-earned' : 'pending';
        return { kind: 'slice' as const, id: `${s}${archived.has(s) ? ' (archived)' : ''}${review ? ` · review clean:${review.clean}` : ' · no review evidence'}`, status };
      }),
    ];
    const sliceStatuses = links.filter(l => l.kind === 'slice').map(l => l.status as GateStatus);
    const status: GateStatus = !referencing.length ? 'unknown' : sliceStatuses.includes('fail') ? 'fail'
      : sliceStatuses.length && sliceStatuses.every(s => s === 'pass') ? 'pass' : 'pending';
    return { id, description, links, status };
  });
  const featureCommits = commits.filter(c => /^(feat|fix)/.test(c.subject));
  return {
    source, factory: 'v2', requirements: requirements.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
    untracedCommits: featureCommits.filter(c => !c.refs.length && !c.slices.length).length,
    title: `${path.basename(projectDir)} — ${registry.length} registered requirement(s), ${commits.length} commit(s)`,
  };
}
