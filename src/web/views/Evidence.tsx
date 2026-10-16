import type { Snapshot } from '../../core/types.ts';
import { Card, StatusPill, usd, when } from '../ui.tsx';

export function Evidence({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      {snapshot.experiments.map(exp => (
        <section className="block" key={exp.id}>
          <Card title={`Holdout discipline · ${exp.id}`}
            sub={<>Measured self-improvement (src/learning.mjs): the optimizer sees development tasks, selection ranks candidates, and the final audit stays held out until the finalist is frozen{exp.heldOutUntil ? ` (held out until ${when(exp.heldOutUntil)})` : ''}. Stage: <b>{exp.stage}</b>.</>}>
            <div className="split" style={{ marginBottom: 16 }}>
              {exp.splits.map(s => (
                <div key={s.name} className={`box${s.heldOut ? ' held' : ''}${s.active ? ' active' : ''}`}>
                  <div className="eyebrow">{s.name}</div>
                  <div className="n">{s.tasks}</div>
                  <div className="small muted">{s.heldOut ? 'held-out audit split' : s.name === 'development' ? 'visible to the optimizer' : 'ranks candidates'}{s.active ? ' · evaluated in this assessment' : ''}</div>
                </div>
              ))}
            </div>
            <div className="grid two">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Arm</th><th>Version · model</th><th className="num">Runs</th><th className="num">Accepted</th><th className="num">Spend</th><th className="num">Per accepted</th></tr></thead>
                  <tbody>{exp.arms.map(a => (
                    <tr key={a.arm}><td>{a.arm}</td><td className="small mono">{a.version} · {a.model}</td><td className="num">{a.runs}</td><td className="num">{a.accepted}</td>
                      <td className="num mono">{usd(a.costUsd, 2)}</td><td className="num mono" style={{ color: 'var(--text-display)' }}>{usd(a.costPerAccepted, 2)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
              <div>
                {exp.assessment ? (
                  <>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                      <StatusPill status={exp.assessment.status === 'improved' ? 'pass' : exp.assessment.status === 'regressed' ? 'fail' : 'pending'} label={exp.assessment.status} />
                      <span className="small muted">action: <b style={{ color: 'var(--text-display)' }}>{exp.assessment.action}</b></span>
                    </div>
                    <div className="small muted" style={{ marginBottom: 8 }}>{exp.assessment.reasonCodes.join(' · ')}</div>
                    <table>
                      <thead><tr><th>Metric (paired, Hoeffding + Bonferroni)</th><th className="num">Lower</th><th className="num">Mean</th><th className="num">Upper</th></tr></thead>
                      <tbody>{Object.entries(exp.assessment.metrics).map(([k, m]) => (
                        <tr key={k}><td className="mono small">{k}</td><td className="num mono">{m.lower.toFixed(3)}</td><td className="num mono">{m.mean.toFixed(3)}</td><td className="num mono">{m.upper.toFixed(3)}</td></tr>
                      ))}</tbody>
                    </table>
                  </>
                ) : <div className="notice">No <code>factory improve</code> assessment configured for this experiment.</div>}
              </div>
            </div>
          </Card>
        </section>
      ))}

      {snapshot.traces.map(trace => (
        <section className="block" key={`${trace.source}${trace.title}`}>
          <Card title={`Trace chain · ${trace.source}`} sub={<>{trace.title}. {trace.factory === 'next'
            ? 'Requirement → acceptance check → expected case, evaluated against the newest verified evidence.'
            : <>Requirement → commits with <code>Refs:</code> → <code>Slice:</code> → review evidence → archive.{trace.untracedCommits ? ` ${trace.untracedCommits} feat/fix commit(s) carry no trace trailer.` : ''}</>}</>}>
            <div className="chain">
              {trace.requirements.slice(0, 60).map(req => (
                <div className="req" key={req.id}>
                  <div>
                    <div className="mono" style={{ color: 'var(--text-display)' }}>{req.id}</div>
                    <StatusPill status={req.status} label={req.status === 'unknown' ? 'no evidence' : undefined} />
                    {req.description && <div className="small muted" style={{ marginTop: 6 }}>{req.description}</div>}
                  </div>
                  <div className="links">
                    {req.links.length ? req.links.map((l, i) => (
                      <span key={i} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {i > 0 && <span className="arrow">{l.kind === 'case' ? '·' : '→'}</span>}
                        <span className="small" style={{ color: l.kind === 'commit' ? 'var(--text-muted)' : 'var(--text-body)' }}>
                          <span className="faint mono">{l.kind}</span> {l.id}
                        </span>
                        {l.status && l.kind !== 'commit' && <StatusPill status={['pass', 'fail', 'blocked', 'not-earned', 'pending', 'needs-signoff', 'unknown'].includes(l.status) ? l.status as never
                          : l.status === 'passed' ? 'pass' : l.status === 'failed' ? 'fail' : l.status === 'blocked' ? 'blocked' : 'unknown'} label={l.kind === 'case' ? String(l.status) : undefined} />}
                      </span>
                    )) : <span className="faint small">No commit, check or slice references this requirement.</span>}
                  </div>
                </div>
              ))}
              {trace.requirements.length > 60 && <div className="faint small">+ {trace.requirements.length - 60} more</div>}
            </div>
          </Card>
        </section>
      ))}
    </>
  );
}
