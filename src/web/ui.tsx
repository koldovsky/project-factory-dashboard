import { useState, type ReactNode } from 'react';
import type { Cost, GateResult, GateStatus, Outcome, Role } from '../core/types.ts';

export const STATUS_META: Record<GateStatus, { icon: string; label: string; color: string }> = {
  pass: { icon: '✓', label: 'pass', color: 'var(--st-pass)' },
  fail: { icon: '✕', label: 'fail', color: 'var(--st-fail)' },
  blocked: { icon: '⊘', label: 'blocked', color: 'var(--st-blocked)' },
  'not-earned': { icon: '◐', label: 'not earned', color: 'var(--st-not-earned)' },
  'needs-signoff': { icon: '✎', label: 'needs sign-off', color: 'var(--st-signoff)' },
  pending: { icon: '…', label: 'pending', color: 'var(--st-pending)' },
  unknown: { icon: '?', label: 'unknown', color: 'var(--st-unknown)' },
};

export function StatusPill({ status, label }: { status: GateStatus; label?: string }) {
  const meta = STATUS_META[status];
  return <span className={`pill ${status}`}><span className="ic" aria-hidden>{meta.icon}</span>{label ?? meta.label}</span>;
}

const OUTCOME: Record<Outcome, { status: GateStatus | 'running'; label: string }> = {
  accepted: { status: 'pass', label: 'accepted' },
  unverified: { status: 'fail', label: 'passed · unverified' },
  rejected: { status: 'fail', label: 'rejected' },
  running: { status: 'running', label: 'running' },
  interrupted: { status: 'blocked', label: 'interrupted' },
  'stale-lock': { status: 'not-earned', label: 'stale lock' },
  completed: { status: 'pending', label: 'completed' },
  failed: { status: 'fail', label: 'failed' },
  unknown: { status: 'unknown', label: 'unknown' },
};

export function OutcomePill({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome];
  if (o.status === 'running') return <span className="pill running"><span className="ic" aria-hidden>●</span>running</span>;
  return <StatusPill status={o.status} label={o.label} />;
}

export function GateStrip({ gates }: { gates: GateResult[] }) {
  if (!gates.length) return <span className="faint small">no evidence</span>;
  return (
    <span className="gate-strip">
      {gates.map(g => (
        <span key={g.id} className="gate-chip" title={`${g.label}: ${g.raw}`} style={{ background: STATUS_META[g.status].color }}>
          {STATUS_META[g.status].icon}
        </span>
      ))}
    </span>
  );
}

export function usd(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  const d = digits ?? (Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 3);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function tokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function CostCell({ cost }: { cost: Cost }) {
  return (
    <span title={cost.note ?? undefined} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
      <span>{cost.usd === null ? 'unknown' : `${cost.partial ? '≥ ' : ''}${usd(cost.usd)}`}</span>
      <span className={`pill prov-${cost.provenance}`}>{cost.provenance}</span>
    </span>
  );
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function when(iso: string | null | undefined, withDate = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return withDate
    ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const ROLE_COLOR: Record<Role, string> = {
  maker: 'var(--series-1)', checker: 'var(--series-2)', verifier: 'var(--series-3)', writer: 'var(--series-4)',
  orchestrator: 'var(--series-5)', controller: 'var(--series-other)', human: 'var(--series-other)',
};
export const ROLE_LABEL: Record<Role, string> = {
  controller: 'controller', maker: 'maker', checker: 'checker', verifier: 'verifier', writer: 'writer', orchestrator: 'orchestrator', human: 'human',
};

export function Card({ title, sub, children, right }: { title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Kpi({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={`card kpi${accent ? ' accent' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Shared hover tooltip: one element following the pointer. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const bind = (content: ReactNode) => ({
    onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => { const r = (e.target as Element).getBoundingClientRect(); setTip({ x: r.right, y: r.top, content }); },
    onBlur: () => setTip(null),
  });
  const node = tip ? (
    <div className="tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 330), top: tip.y + 14 }}>{tip.content}</div>
  ) : null;
  return { bind, node };
}

export function Toggle<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="toggle" role="group">
      {options.map(o => <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </span>
  );
}
