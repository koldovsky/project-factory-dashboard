import { useMemo } from 'react';
import type { RunSummary, Snapshot } from '../../core/types.ts';
import { Card, STATUS_META, StatusPill, useTooltip, when } from '../ui.tsx';

const GATE_TITLES: Record<string, string> = {
  G0: 'Scaffold', G1: 'Framing', G2: 'Specs', G3: 'Plan', G4: 'Per slice', G5: 'Hardening', G6: 'QA pack', G7: 'Release', G8: 'UAT',
};

const SHORT: Record<string, string> = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCK', 'not-earned': 'N-E', 'needs-signoff': 'SIGN', pending: '—', unknown: '?' };

export function Gates({ snapshot, openRun }: { snapshot: Snapshot; openRun: (key: string) => void }) {
  const { bind, node } = useTooltip();
  const nextTasks = useMemo(() => {
    const byTask = new Map<string, RunSummary[]>();
    for (const r of snapshot.runs.filter(r => r.kind === 'delivery')) byTask.set(r.feature ?? r.id, [...(byTask.get(r.feature ?? r.id) ?? []), r]);
    return [...byTask];
  }, [snapshot]);

  return (
    <>
      <div className="legend" style={{ marginTop: 0, marginBottom: 16 }}>
        {(Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map(s => <StatusPill key={s} status={s} />)}
        <span className="faint">N-E = NOT-EARNED, SIGN = needs sign-off. Verdicts are shown exactly as the factory wrote them. NOT-EARNED, sign-off, pending and blocked are never folded into pass.</span>
      </div>

      {nextTasks.length > 0 && (
        <section className="block">
          <Card title="Deterministic checks per delivery run (project-factory-next)"
            sub="Dependency-ordered acceptance checks from each run's latest evidence.json. A failed producer blocks its consumers; preparation failure means acceptance never ran.">
            {nextTasks.map(([task, runs]) => {
              const ids = [...new Set(runs.flatMap(r => r.gates.map(g => g.id)))];
              return (
                <div key={task} style={{ marginBottom: 18 }} className="table-wrap">
                  <div className="eyebrow" style={{ margin: '8px 0' }}>{task}</div>
                  <table className="heat">
                    <thead><tr><th /> {ids.map(id => <th key={id} className="small muted" style={{ fontWeight: 500 }}>{id.replace('preparation:', 'prep ')}</th>)}<th /></tr></thead>
                    <tbody>
                      {runs.map(r => (
                        <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => openRun(r.key)}>
                          <td className="rowhead">{r.id}<div className="faint">{when(r.startedAt)}</div></td>
                          {ids.map(id => {
                            const g = r.gates.find(x => x.id === id);
                            const status = g?.status ?? 'unknown';
                            return (
                              <td key={id} className={`cell ${status}`} tabIndex={0}
                                {...bind(<><b>{r.id} · {id}</b><br />{g ? `${g.raw}${g.durationMs ? ` · ${g.durationMs} ms` : ''}` : 'not recorded in the latest evidence'}
                                  {g?.cases && <><br />{g.cases.map(c => `${c.status === 'passed' ? '✓' : '✕'} ${c.id}`).join('  ')}</>}
                                  {g?.detail && <><br /><span className="muted">{g.detail}</span></>}
                                  {g?.dependsOn?.length ? <><br /><span className="muted">depends on {g.dependsOn.join(', ')}</span></> : null}</>)}>
                                {STATUS_META[status].icon} {g?.cases ? `${g.cases.filter(c => c.status === 'passed').length}/${g.cases.length}` : ''}
                              </td>
                            );
                          })}
                          <td className="small" style={{ paddingLeft: 10 }}>{r.integrity.ok === false && <span className="issue">✕ integrity</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </Card>
        </section>
      )}

      {snapshot.gateHistory.map(h => (
        <section className="block" key={h.source}>
          <Card title={`Quality gates G0–G8 · ${h.source}`}
            sub={h.snapshots.length ? `${h.snapshots.length} gate-status runs from trace/ledger.jsonl, newest first. Frontier = the furthest gate truly satisfied.` : 'No gate-status-run events in the ledger yet.'}>
            {h.snapshots.length > 0 && (
              <div className="table-wrap">
                <table className="heat">
                  <thead><tr><th />{['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].map(g => <th key={g} className="small"><div style={{ color: 'var(--text-display)' }}>{g}</div><div className="faint" style={{ fontWeight: 400 }}>{GATE_TITLES[g]}</div></th>)}<th className="small muted">frontier</th></tr></thead>
                  <tbody>
                    {[...h.snapshots].reverse().slice(0, 14).map(s => (
                      <tr key={s.at}>
                        <td className="rowhead">{when(s.at)}<div className="faint mono">phase {s.phase ?? '?'} · {s.gitHead?.slice(0, 7)}</div></td>
                        {['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].map(id => {
                          const g = s.gates.find(x => x.id === id);
                          const status = g?.status ?? 'unknown';
                          return <td key={id} className={`cell ${status}`} tabIndex={0} {...bind(<><b>{id} · {g?.label ?? GATE_TITLES[id]}</b><br />{g?.raw ?? 'not reported'}<br /><span className="muted">{when(s.at)} · open corrections {s.openCorrections ?? '?'}</span></>)}>
                            {STATUS_META[status].icon} {SHORT[status]}</td>;
                        })}
                        <td className="small mono" style={{ paddingLeft: 10, color: 'var(--text-display)' }}>{s.frontier}{s.openCorrections ? <span className="issue"> · {s.openCorrections} open correction</span> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {h.checkRuns.filter(c => c.event !== 'hook-run').length > 0 && (
              <>
                <div className="eyebrow" style={{ margin: '18px 0 8px' }}>deterministic checks · latest runs</div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>When</th><th>Check</th><th>Event</th><th className="num">Exit</th><th className="num">Scope</th><th>Verdict</th></tr></thead>
                    <tbody>
                      {h.checkRuns.filter(c => c.event !== 'hook-run').slice(-14).reverse().map((c, i) => (
                        <tr key={`${c.at}${i}`}>
                          <td className="small muted">{when(c.at)}</td><td className="mono">{c.check}</td><td className="small muted">{c.event}</td>
                          <td className="num mono">{c.exitCode ?? '—'}</td><td className="num mono">{c.scopeN ?? '—'}</td>
                          <td>{c.vacuous ? <StatusPill status="not-earned" label="vacuous: PASS on 0 items" />
                            : c.overall ? <StatusPill status={/^pass/i.test(c.overall) ? 'pass' : /not-earned/i.test(c.overall) ? 'not-earned' : 'fail'} label={c.overall} />
                            : <StatusPill status={c.exitCode === 0 ? 'pass' : c.exitCode === null ? 'unknown' : 'fail'} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </section>
      ))}

      {snapshot.reviews.filter(r => r.findings.length).map(r => (
        <section className="block" key={r.source}>
          <Card title={`Adversarial review evidence · ${r.source}`} sub="openspec/changes/**/review-findings.json from the review-gate workflow: finders per dimension, every finding verified by two refuting agents. Archive requires clean:true.">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Change</th><th>clean</th>{['correctness', 'security', 'spec-compliance', 'visual'].map(d => <th key={d} className="num">{d}<div className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>conf / cont / rej</div></th>)}<th>Generated</th><th>Confirmed titles</th></tr></thead>
                <tbody>
                  {r.findings.map(f => (
                    <tr key={f.path}>
                      <td><b style={{ color: 'var(--text-display)' }}>{f.change}</b><div className="small faint">{f.archived ? 'archived' : 'active'} · {f.baseRef ?? '?'}..{f.headRef ?? '?'}</div></td>
                      <td>{f.clean === null ? <StatusPill status="unknown" label="missing" /> : <StatusPill status={f.clean ? 'pass' : 'fail'} label={`clean: ${f.clean}`} />}</td>
                      {['correctness', 'security', 'spec-compliance', 'visual'].map(d => {
                        const x = f.dimensions.find(y => y.name === d);
                        return <td key={d} className="num mono">{x ? <><span style={{ color: x.confirmed ? 'var(--rose-400)' : undefined }}>{x.confirmed}</span> / {x.contested} / <span className="faint">{x.rejected}</span></> : '—'}</td>;
                      })}
                      <td className="small muted">{f.generatedAt ? when(f.generatedAt) : <span className="faint">unstamped</span>}</td>
                      <td className="small" style={{ maxWidth: 420 }}>
                        {f.confirmedTitles.length ? <details><summary className="muted">{f.confirmedTitles.length} confirmed</summary><ul className="gaps">{f.confirmedTitles.map(t => <li key={t}>{t}</li>)}</ul></details> : <span className="faint">none</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      ))}
      {node}
    </>
  );
}
