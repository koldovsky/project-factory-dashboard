import { useMemo, useState } from 'react';
import type { Role, Snapshot } from '../../core/types.ts';
import { sumCosts, totalTokens } from '../../core/pricing.ts';
import { HBars, Legend, StackedBars, assignColors } from '../charts.tsx';
import { Card, Kpi, ROLE_COLOR, ROLE_LABEL, Toggle, tokens, usd } from '../ui.tsx';

export function Cost({ snapshot }: { snapshot: Snapshot }) {
  const [source, setSource] = useState('all');
  const [metric, setMetric] = useState<'usd' | 'tokens'>('usd');
  const runs = useMemo(() => snapshot.runs.filter(r => !r.running && (source === 'all' || r.source === source)), [snapshot, source]);

  // Daily spend by model. The daily table is per source-agnostic model; filter runs-based views by source.
  const daily = snapshot.dailyCost;
  const recorded = [...new Set(daily.map(d => d.day))].filter(d => /^d{4}-d{2}-d{2}$/.test(d)).sort();
  // Continuous day axis: idle days show as gaps, not as missing columns.
  const days: string[] = [];
  if (recorded.length) for (let t = Date.parse(recorded[0]); t <= Date.parse(recorded.at(-1)!) && days.length < 400; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const modelTotals = new Map<string, number>();
  for (const d of daily) modelTotals.set(d.model, (modelTotals.get(d.model) ?? 0) + (metric === 'usd' ? d.usd ?? 0 : totalTokens(d.tokens)));
  const models = [...modelTotals].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const top = models.slice(0, 5);
  const colors = assignColors([...top, ...(models.length > 5 ? ['other'] : [])]);
  const stack = days.map(day => {
    const rows = daily.filter(d => d.day === day);
    const parts = top.map(m => {
      const r = rows.filter(x => x.model === m);
      return { key: m, value: r.reduce((s, x) => s + (metric === 'usd' ? x.usd ?? 0 : totalTokens(x.tokens)), 0),
        note: r.some(x => x.usd === null) && metric === 'usd' ? 'includes unpriced usage' : r.some(x => x.provenance === 'estimated') ? 'token × list-price estimate' : 'reported by the CLI' };
    });
    const rest = rows.filter(x => !top.includes(x.model)).reduce((s, x) => s + (metric === 'usd' ? x.usd ?? 0 : totalTokens(x.tokens)), 0);
    if (models.length > 5) parts.push({ key: 'other', value: rest, note: `${models.length - 5} more model(s)` });
    return { x: day, parts };
  });

  const unpriced = daily.filter(d => d.usd === null && totalTokens(d.tokens) > 0).length;
  const spend = sumCosts(runs.map(r => r.cost));
  const reported = sumCosts(runs.filter(r => r.cost.provenance === 'reported').map(r => r.cost));
  const allTokens = runs.reduce((s, r) => s + totalTokens(r.cost.tokens), 0);

  const byRole = new Map<Role, { usd: number; unknown: number; runs: number }>();
  for (const r of runs) for (const a of r.agents) {
    const v = byRole.get(a.role) ?? { usd: 0, unknown: 0, runs: 0 };
    if (a.cost.usd === null) v.unknown++; else v.usd += a.cost.usd;
    v.runs++;
    byRole.set(a.role, v);
  }
  const byAgent = new Map<string, { usd: number; unknown: number; role: Role; n: number }>();
  for (const r of runs) for (const a of r.agents) {
    const key = a.label.replace(/ · attempt \d+$/, '').replace(/^verify:.*$/, 'verify:* (adversarial verifiers)').replace(/ — .*$/, '').replace(/^persist:.*$/, 'persist:*').replace(/^draft:.*$/, 'draft:*');
    const v = byAgent.get(key) ?? { usd: 0, unknown: 0, role: a.role, n: 0 };
    if (a.cost.usd === null) v.unknown++; else v.usd += a.cost.usd;
    v.n++;
    byAgent.set(key, v);
  }
  const byFeature = new Map<string, { usd: number; partial: boolean; runs: number }>();
  for (const r of runs) {
    const key = r.feature ?? (r.kind === 'session' ? 'unattributed sessions' : r.kind === 'workflow' ? `${r.title} (no change scope)` : r.id);
    const v = byFeature.get(key) ?? { usd: 0, partial: false, runs: 0 };
    if (r.cost.usd === null) v.partial = true; else v.usd += r.cost.usd;
    if (r.cost.partial) v.partial = true;
    v.runs++;
    byFeature.set(key, v);
  }
  const cpa = snapshot.costPerAccepted.filter(c => source === 'all' || c.scope.startsWith(`${source} ·`) || c.factory === 'experiment');
  // Only scopes whose spend is known: dividing by changes from projects without cost data would understate it.
  const headline = cpa.filter(c => c.factory !== 'experiment' && !c.scope.includes('(review only)') && c.spendUsd !== null);
  const excluded = cpa.filter(c => c.factory !== 'experiment' && !c.scope.includes('(review only)') && c.spendUsd === null).length;
  const totalAccepted = headline.reduce((s, c) => s + c.accepted, 0);
  const totalSpend = headline.reduce((s, c) => s + (c.spendUsd ?? 0), 0);
  const anyPartial = headline.some(c => c.spendPartial);

  return (
    <>
      <div className="filters">
        <label className="small muted">Source&nbsp;
          <select value={source} onChange={e => setSource(e.target.value)}>
            <option value="all">All sources</option>
            {snapshot.sources.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </label>
        <Toggle value={metric} onChange={setMetric} options={[{ value: 'usd', label: 'USD' }, { value: 'tokens', label: 'Tokens' }]} />
      </div>
      <div className="grid kpis">
        <Kpi accent label="Cost per accepted change" value={totalAccepted ? `${anyPartial ? '≥' : ''}${usd(totalSpend / totalAccepted, 2)}` : '—'}
          hint={`${usd(totalSpend, 2)} over ${totalAccepted} accepted change(s), failed attempts included${excluded ? ` · ${excluded} scope(s) without cost data excluded` : ''}`} />
        <Kpi label="Agent spend" value={spend.usd === null ? '—' : `${spend.partial ? '≥' : ''}${usd(spend.usd, 2)}`} hint={`${usd(reported.usd ?? 0, 2)} reported by the CLI, the rest estimated`} />
        <Kpi label="Tokens (all classes)" value={tokens(allTokens)} hint="input + output + cache write + cache read" />
        <Kpi label="Runs with unknown cost" value={runs.filter(r => r.cost.usd === null || r.cost.partial).length} hint="truncated output, unpriced model, missing transcript" />
      </div>

      <section className="block">
        <Card title={metric === 'usd' ? 'Spend per day by model' : 'Tokens per day by model'}
          sub="Builder spend from builder.json and Claude Code usage from transcripts, deduplicated by message id. On a subscription these are API-equivalent figures, not invoices.">
          {stack.length ? <><StackedBars data={stack} colors={colors} format={metric === 'usd' ? v => usd(v) : tokens} /><Legend colors={colors} />
            {metric === 'usd' && unpriced > 0 && <p className="small faint" style={{ marginBottom: 0 }}>{unpriced} day/model slice(s) have tokens but no price (e.g. Codex output that does not name its model) and are not drawn in USD: switch to Tokens to see them.</p>}</> : <div className="empty">No dated spend recorded.</div>}
        </Card>
      </section>

      <section className="block grid two">
        <Card title="By role: maker vs checker" sub="Who the money goes to. Makers build candidates; checkers and verifiers try to refute them.">
          <HBars data={[...byRole].sort((a, b) => b[1].usd - a[1].usd).map(([role, v]) => ({ label: ROLE_LABEL[role], value: v.usd, color: ROLE_COLOR[role],
            suffix: v.unknown ? <span className="faint"> +{v.unknown} unknown</span> : null,
            tip: <><b>{ROLE_LABEL[role]}</b><br />{usd(v.usd, 2)} across {v.runs} agent invocation(s){v.unknown ? <><br />{v.unknown} with unknown cost (not counted)</> : null}</> }))} />
        </Card>
        <Card title="By agent" sub="Top 12 agent types / workflow labels">
          <HBars data={[...byAgent].sort((a, b) => b[1].usd - a[1].usd).slice(0, 12).map(([label, v]) => ({ label, value: v.n === v.unknown ? null : v.usd, color: ROLE_COLOR[v.role],
            suffix: v.unknown && v.n !== v.unknown ? <span className="faint"> +{v.unknown}?</span> : null,
            tip: <><b>{label}</b><br />{ROLE_LABEL[v.role]} · {v.n} invocation(s)<br />{usd(v.usd, 2)}{v.unknown ? ` + ${v.unknown} unknown` : ''}</> }))} />
        </Card>
      </section>

      <section className="block grid two">
        <Card title="By feature / task" sub="next: task id · v2: OpenSpec change named in the review-gate scope. Sessions carry no change link.">
          <HBars data={[...byFeature].sort((a, b) => b[1].usd - a[1].usd).slice(0, 14).map(([label, v]) => ({ label, value: v.usd, color: 'var(--series-1)',
            suffix: v.partial ? <span className="faint"> ≥</span> : null, tip: <><b>{label}</b><br />{v.partial ? '≥ ' : ''}{usd(v.usd, 2)} over {v.runs} run(s)</> }))} />
        </Card>
        <Card title="Cost per accepted change" sub="Not cost per merged PR: every attempt, failed run and review round counts toward the change it produced.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Scope</th><th className="num">Spend</th><th className="num">Attempts</th><th className="num">Accepted</th><th className="num">Per accepted</th></tr></thead>
              <tbody>
                {cpa.map(c => (
                  <tr key={c.scope} title={c.definition}>
                    <td className="small"><span style={{ color: 'var(--text-display)' }}>{c.scope}</span><div className="faint">{c.definition}</div></td>
                    <td className="num mono">{c.spendUsd === null ? 'unknown' : `${c.spendPartial ? '≥' : ''}${usd(c.spendUsd, 2)}`}</td>
                    <td className="num mono">{c.attempts}</td>
                    <td className="num mono">{c.accepted}</td>
                    <td className="num mono" style={{ color: 'var(--text-display)' }}>{c.costPerAccepted === null ? '—' : `${c.spendPartial ? '≥' : ''}${usd(c.costPerAccepted, 2)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </>
  );
}
