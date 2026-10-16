import { useMemo, useState } from 'react';
import type { RunSummary, Snapshot } from '../../core/types.ts';
import { sumCosts } from '../../core/pricing.ts';
import { Card, CostCell, GateStrip, Kpi, OutcomePill, StatusPill, duration, usd, when } from '../ui.tsx';

export function Monitor({ snapshot, openRun }: { snapshot: Snapshot; openRun: (key: string) => void }) {
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');
  const runs = useMemo(() => snapshot.runs.filter(r => (source === 'all' || r.source === source) && (kind === 'all' || r.kind === kind)), [snapshot, source, kind]);
  const delivery = runs.filter(r => r.kind === 'delivery');
  const running = runs.filter(r => r.running || r.outcome === 'stale-lock');
  const accepted = delivery.filter(r => r.outcome === 'accepted').length;
  const rejected = delivery.filter(r => r.outcome === 'rejected').length;
  const integrityBad = runs.filter(r => r.integrity.ok === false).length;
  const spend = sumCosts(runs.filter(r => !r.running).map(r => r.cost));
  const failures = runs.filter(r => r.failure && r.outcome !== 'accepted').slice(0, 12);
  const reviewRuns = runs.filter(r => r.kind === 'workflow' && r.gates.length);
  const unclean = reviewRuns.filter(r => r.gates.find(g => g.id === 'review-confirmed')?.status === 'fail').length;

  return (
    <>
      <div className="filters">
        <label className="small muted">Source&nbsp;
          <select value={source} onChange={e => setSource(e.target.value)}>
            <option value="all">All sources</option>
            {snapshot.sources.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </label>
        <label className="small muted">Kind&nbsp;
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="all">All runs</option>
            <option value="delivery">Delivery runs (factory run)</option>
            <option value="workflow">Workflows (review-gate, spec-pipeline…)</option>
            <option value="session">Agent sessions</option>
          </select>
        </label>
      </div>

      <div className="grid kpis">
        <Kpi label="Running now" value={runs.filter(r => r.running).length} accent={runs.some(r => r.running)}
          hint={running.length > runs.filter(r => r.running).length ? `+ ${running.length - runs.filter(r => r.running).length} stale lock(s) need recover` : 'live lock or active transcript'} />
        <Kpi label="Delivery runs accepted" value={<>{accepted}<span className="muted" style={{ fontSize: 18 }}> / {delivery.length}</span></>} hint={`${rejected} rejected by the evaluator`} />
        <Kpi label="Review gates not clean" value={<>{unclean}<span className="muted" style={{ fontSize: 18 }}> / {reviewRuns.length}</span></>} hint="workflow runs with confirmed findings" />
        <Kpi label="Integrity failures" value={<span style={{ color: integrityBad ? 'var(--rose-400)' : undefined }}>{integrityBad}</span>} hint="hash chain / evidence digests re-verified" />
        <Kpi label="Agent spend (finished runs)" value={spend.usd === null ? '—' : `${spend.partial ? '≥' : ''}${usd(spend.usd, 2)}`}
          hint={<>{spend.provenance === 'reported' ? 'reported by the CLI' : 'includes token × list-price estimates'}{spend.partial ? ' · some runs unknown' : ''}</>} />
      </div>

      <section className="block grid two">
        <Card title="Running now" sub="next-gen: lock.json held by a live controller pid · Claude Code: transcript written in the last 3 minutes">
          {running.length ? (
            <table><tbody>
              {running.map(r => (
                <tr key={r.key} className="clickable" onClick={() => openRun(r.key)}>
                  <td><OutcomePill outcome={r.outcome} /></td>
                  <td><b style={{ color: 'var(--text-display)' }}>{r.title}</b><div className="small muted">{r.source} · state {r.state}{r.attempts ? ` · attempt ${r.attempts}` : ''}</div>
                    <div className="small faint">{r.runningBasis}</div></td>
                  <td className="num small muted">{duration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">Nothing is running. Start a factory run (or <code>pnpm demo:live</code>) and it appears here within 5 seconds.</div>}
        </Card>
        <Card title="What failed and why" sub="Latest unaccepted outcomes with the evaluator's own reason (failed case details, blocked dependencies, builder errors)">
          {failures.length ? (
            <table><tbody>
              {failures.map(r => (
                <tr key={r.key} className="clickable" onClick={() => openRun(r.key)}>
                  <td style={{ width: 120 }}>{r.kind === 'workflow' && r.gates.find(g => g.id === 'review-confirmed')?.status === 'fail' ? <StatusPill status="fail" label="not clean" /> : <OutcomePill outcome={r.outcome} />}</td>
                  <td><b style={{ color: 'var(--text-display)' }}>{r.title}</b> <span className="small faint">{r.id} · {when(r.startedAt)}</span>
                    <div className="small issue wrap-any">{r.failure}</div></td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="empty">No failures in this selection.</div>}
        </Card>
      </section>

      <section className="block">
        <Card title="Runs" sub="Every factory run, workflow and agent session the sources recorded. Click a row for its trace.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Started</th><th>Run</th><th>Kind</th><th>Agent · model</th><th className="num">Attempts</th><th>Gates / checks</th><th>Outcome</th><th className="num">Cost</th><th>Integrity</th></tr></thead>
              <tbody>{runs.map(r => <RunRow key={r.key} run={r} onClick={() => openRun(r.key)} />)}</tbody>
            </table>
          </div>
        </Card>
      </section>

      <section className="block grid two">
        <Card title="Sources" sub="Where this snapshot was read from (read-only)">
          <table><tbody>
            {snapshot.sources.map(s => (
              <tr key={s.name}><td><b style={{ color: 'var(--text-display)' }}>{s.name}</b><div className="small faint mono wrap-any">{s.kind} · {s.path}</div>
                {s.warnings.map(w => <div key={w} className="small" style={{ color: 'var(--amber-300)' }}>{w}</div>)}</td>
                <td className="num">{s.ok ? <span className="ok">{s.items} items</span> : <span className="issue">error</span>}</td></tr>
            ))}
          </tbody></table>
        </Card>
        <Card title="What the factories do not record (yet)" sub="Gaps found while building this dashboard, with the smallest addition that would close each">
          <ul className="gaps">{snapshot.gaps.map(g => <li key={g}>{g}</li>)}</ul>
        </Card>
      </section>
    </>
  );
}

function RunRow({ run, onClick }: { run: RunSummary; onClick: () => void }) {
  return (
    <tr className="clickable" onClick={onClick}>
      <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{when(run.startedAt)}</td>
      <td><b style={{ color: 'var(--text-display)' }}>{run.title}</b>{run.feature && run.feature !== run.title && <span className="small muted"> · {run.feature}</span>}
        <div className="small faint">{run.source} · {run.id}</div></td>
      <td className="small">{run.kind}</td>
      <td className="small">{run.agent ?? '—'}<div className="faint mono">{run.model ?? ''}</div></td>
      <td className="num">{run.attempts ?? '—'}</td>
      <td><GateStrip gates={run.gates} /></td>
      <td><OutcomePill outcome={run.outcome} /></td>
      <td className="num"><CostCell cost={run.cost} /></td>
      <td className="small">{run.integrity.ok === null ? <span className="faint">n/a</span> : run.integrity.ok ? <span className="ok">✓ verified</span> : <span className="issue" title={run.integrity.issues.join('\n')}>✕ {run.integrity.issues.length} issue(s)</span>}</td>
    </tr>
  );
}
