import { useMemo, useState } from 'react';
import type { Role, RunSummary, Snapshot, TimelineEvent } from '../../core/types.ts';
import { CostCell, GateStrip, OutcomePill, ROLE_COLOR, ROLE_LABEL, StatusPill, duration, useTooltip, when } from '../ui.tsx';

const ROLES: Role[] = ['controller', 'orchestrator', 'maker', 'checker', 'verifier', 'writer', 'human'];

function statusClass(status?: string) {
  if (!status) return null;
  if (['passed', 'done', 'completed', 'confirmed-clean'].includes(status)) return <StatusPill status="pass" label={status} />;
  if (['failed', 'attempt-failed', 'error', 'timeout', 'output-limit', 'confirmed'].includes(status)) return <StatusPill status="fail" label={status} />;
  if (status === 'blocked' || status === 'interrupted') return <StatusPill status="blocked" label={status} />;
  if (status === 'contested') return <StatusPill status="needs-signoff" label={status} />;
  if (status === 'rejected') return <StatusPill status="pending" label="refuted" />;
  if (status === 'running') return <span className="pill running">running</span>;
  return <span className="pill pending">{status}</span>;
}

/** Gantt of phases (next-gen: controller states per attempt) or workflow agents (fan-out of finders/verifiers). */
function Gantt({ run }: { run: RunSummary }) {
  const { bind, node } = useTooltip();
  const bars: { lane: string; role: Role; label: string; start: number; end: number; status?: string }[] = [];
  if (run.kind === 'delivery') {
    const transitions = run.events.filter(e => e.kind === 'transition' && e.at);
    transitions.forEach((e, i) => {
      const next = transitions[i + 1];
      const end = next?.at ? Date.parse(next.at) : run.running ? Date.now() : Date.parse(e.at!);
      if (['building', 'preparing', 'evaluating'].includes(e.title)) {
        bars.push({ lane: `attempt ${e.attempt ?? '?'}`, role: e.title === 'building' ? 'maker' : e.title === 'evaluating' ? 'checker' : 'controller',
          label: e.title, start: Date.parse(e.at!), end: Math.max(end, Date.parse(e.at!) + 1000), status: next?.title });
      }
    });
  } else if (run.kind === 'workflow') {
    for (const e of run.events.filter(x => x.kind === 'agent' && x.at)) {
      const start = Date.parse(e.at!);
      bars.push({ lane: e.actor.split(':')[0], role: e.role, label: e.actor, start, end: start + (e.durationMs ?? 1000), status: e.status });
    }
  }
  if (bars.length < 2) return null;
  const t0 = Math.min(...bars.map(b => b.start));
  const t1 = Math.max(...bars.map(b => b.end));
  const lanes = [...new Set(bars.map(b => b.lane))];
  const rowH = 22;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ margin: '4px 0 8px' }}>{run.kind === 'delivery' ? 'attempts: build → prepare → evaluate' : 'agent fan-out over time'}</div>
      {lanes.map(lane => (
        <div key={lane} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', marginBottom: 4 }}>
          <span className="small mono muted">{lane}</span>
          <div style={{ position: 'relative', height: Math.max(1, bars.filter(b => b.lane === lane).length > 6 ? 2 : 1) * rowH, background: 'rgba(255,255,255,0.025)', borderRadius: 4 }}>
            {bars.filter(b => b.lane === lane).map((b, i, arr) => {
              const left = ((b.start - t0) / Math.max(1, t1 - t0)) * 100;
              const width = Math.max(0.8, ((b.end - b.start) / Math.max(1, t1 - t0)) * 100);
              const top = arr.length > 6 ? (i % 2) * rowH : 0;
              return <span key={i} tabIndex={0} {...bind(<><b>{b.label}</b><br />{duration(b.end - b.start)}{b.status ? ` → ${b.status}` : ''}<br /><span className="muted">{when(new Date(b.start).toISOString(), false)}</span></>)}
                style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: top + 4, height: rowH - 8, background: ROLE_COLOR[b.role], borderRadius: 4, opacity: 0.9, outline: '2px solid var(--surface-card)' }} />;
            })}
          </div>
        </div>
      ))}
      <div className="small faint" style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 130 }}><span>{when(new Date(t0).toISOString())}</span><span>{duration(t1 - t0)}</span></div>
      {node}
    </div>
  );
}

export function Trace({ snapshot, selected, select }: { snapshot: Snapshot; selected: string | null; select: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<Role>>(new Set());
  const runs = snapshot.runs;
  const run = runs.find(r => r.key === selected) ?? runs[0];
  const list = useMemo(() => runs.filter(r => !query || `${r.title} ${r.id} ${r.feature ?? ''} ${r.source}`.toLowerCase().includes(query.toLowerCase())), [runs, query]);
  if (!run) return <div className="empty">No runs in this snapshot.</div>;
  const rolesPresent = ROLES.filter(role => run.events.some(e => e.role === role));
  const events = run.events.filter(e => !hidden.has(e.role));
  const toggle = (role: Role) => setHidden(prev => { const n = new Set(prev); n.has(role) ? n.delete(role) : n.add(role); return n; });

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="filters">
        <input type="search" placeholder="Filter runs…" value={query} onChange={e => setQuery(e.target.value)} />
        <select value={run.key} onChange={e => select(e.target.value)} style={{ minWidth: 0, flex: '1 1 320px' }}>
          {list.map(r => <option key={r.key} value={r.key}>{`${when(r.startedAt)} · ${r.kind} · ${r.title} · ${r.id} (${r.outcome})`}</option>)}
        </select>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">{run.source} · {run.kind}</div>
            <h2 style={{ fontSize: 22, margin: '6px 0' }}>{run.title} <span className="muted mono" style={{ fontSize: 13 }}>{run.id}</span></h2>
            <div className="small muted">{run.agent ?? '—'}{run.model ? ` · ${run.model}` : ''} · started {when(run.startedAt)} · {duration(run.durationMs)}{run.attempts ? ` · ${run.attempts} attempt(s)` : ''}{run.feature ? ` · feature ${run.feature}` : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <OutcomePill outcome={run.outcome} /><CostCell cost={run.cost} />
          </div>
        </div>
        {run.failure && <div className="issue" style={{ marginTop: 10 }}>{run.failure}</div>}
        {run.runningBasis && <div className="small" style={{ marginTop: 6, color: 'var(--cyan-300)' }}>{run.runningBasis}</div>}
        <div style={{ marginTop: 12 }} className="small">
          {run.integrity.ok === null ? <span className="faint">Integrity: not applicable (no hash-chained record for this source)</span>
            : run.integrity.ok ? <span className="ok">✓ Integrity verified: history hash chain, execution digest, evidence digest and attempt manifest match.</span>
            : <div className="notice" style={{ borderColor: 'rgba(244,71,95,.6)' }}><b>Integrity check failed — do not trust this evidence.</b>
              <ul className="gaps">{run.integrity.issues.map(i => <li key={i} className="issue">{i}</li>)}</ul></div>}
        </div>
        {run.gates.length > 0 && <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><span className="eyebrow">evidence</span><GateStrip gates={run.gates} />
          {run.gates.map(g => <span key={g.id} className="small muted">{g.label}: <b style={{ color: 'var(--text-display)' }}>{g.raw}</b></span>)}</div>}
      </div>

      {run.agents.length > 0 && (
        <div className="card">
          <h2>Agents in this run</h2>
          <p className="sub">Maker ≠ checker: who built, who judged, who tried to refute — with each one's own spend.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Role</th><th>Agent</th><th>Model</th><th className="num">Tool calls</th><th className="num">Duration</th><th>State</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {run.agents.map(a => (
                  <tr key={a.id}>
                    <td><span className="pill" style={{ color: ROLE_COLOR[a.role], borderColor: ROLE_COLOR[a.role] }}>{ROLE_LABEL[a.role]}</span></td>
                    <td className="small wrap-any">{a.label}</td><td className="small mono muted">{a.model ?? '—'}</td>
                    <td className="num mono">{a.toolCalls ?? '—'}</td><td className="num small">{duration(a.durationMs)}</td>
                    <td>{statusClass(a.state ?? undefined)}</td><td className="num"><CostCell cost={a.cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Timeline</h2>
        <p className="sub">Controller transitions, maker steps and tool calls, checker verdicts, verifier findings and handoffs, in recorded order.</p>
        <Gantt run={run} />
        <div className="filters">
          {rolesPresent.map(role => (
            <button key={role} className="pill" aria-pressed={!hidden.has(role)} onClick={() => toggle(role)}
              style={{ cursor: 'pointer', background: 'none', color: hidden.has(role) ? 'var(--text-faint)' : ROLE_COLOR[role], borderColor: hidden.has(role) ? 'var(--border-subtle)' : ROLE_COLOR[role], textDecoration: hidden.has(role) ? 'line-through' : 'none' }}>
              {ROLE_LABEL[role]} · {run.events.filter(e => e.role === role).length}
            </button>
          ))}
        </div>
        <div className="seq">
          {events.length ? events.map((e, i) => <EventRow key={i} e={e} prev={events[i - 1]} />) : <div className="empty">No events for the selected roles.</div>}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e, prev }: { e: TimelineEvent; prev?: TimelineEvent }) {
  const color = ROLE_COLOR[e.role];
  const newAttempt = e.attempt && e.attempt !== prev?.attempt && e.kind === 'transition' && e.title === 'building';
  return (
    <>
      {newAttempt && <div className="seq-row attempt-break"><span /><span className="eyebrow">attempt {e.attempt}</span><span /></div>}
      <div className="seq-row" style={{ ['--lane-color' as string]: color }}>
        <span className="mono small faint">{when(e.at, false)}</span>
        <span className="who">{e.kind === 'handoff' ? 'handoff' : ROLE_LABEL[e.role]}<div className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>{e.actor}</div></span>
        <span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="title" style={{ color: 'var(--text-display)', overflowWrap: 'anywhere' }}>{e.title}</span>
            {e.kind !== 'transition' && statusClass(e.status)}
            {e.durationMs ? <span className="small faint">{duration(e.durationMs)}</span> : null}
            <span className="small faint">{e.kind}</span>
          </span>
          {e.detail && <div className="small muted wrap-any" style={{ marginTop: 2 }}>{e.detail}</div>}
        </span>
      </div>
    </>
  );
}
