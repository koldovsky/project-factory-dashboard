// Hand-written SVG charts: thin marks, a 2px surface gap between stacked segments, rounded data ends,
// recessive grid, a legend for ≥2 series and a hover tooltip on every mark. Text wears text tokens.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTooltip, usd } from './ui.tsx';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

/** Stable entity → colour assignment (by first appearance in a sorted key list), max 5 + Other. */
export function assignColors(keys: string[]): Map<string, string> {
  const map = new Map<string, string>();
  keys.forEach((k, i) => map.set(k, i < SERIES.length ? SERIES[i] : 'var(--series-other)'));
  return map;
}

export interface StackDatum { x: string; parts: { key: string; value: number; note?: string }[] }

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v) ?? v;
}

export function StackedBars({ data, colors, height = 220, format = usd }: { data: StackDatum[]; colors: Map<string, string>; height?: number; format?: (v: number) => string }) {
  const { bind, node } = useTooltip();
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(Math.floor(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  // Fill the card; scroll horizontally only when there are too many days for ~18px bars.
  const width = Math.max(available, data.length * 26 + 60, 280);
  const pad = { l: 52, r: 8, t: 10, b: 26 };
  const max = niceMax(Math.max(0, ...data.map(d => d.parts.reduce((s, p) => s + p.value, 0))));
  const plotH = height - pad.t - pad.b;
  const band = (width - pad.l - pad.r) / Math.max(1, data.length);
  const barW = Math.min(28, band * 0.6);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.max(1, Math.ceil((data.length * 44) / Math.max(1, width - 60)));
  return (
    <div ref={ref} style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} role="img" aria-label="Daily spend by model" style={{ display: 'block' }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-faint)" fontFamily="var(--font-mono)">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + band * i + band / 2;
          let acc = 0;
          const total = d.parts.reduce((s, p) => s + p.value, 0);
          const visible = d.parts.filter(p => p.value > 0);
          return (
            <g key={d.x}>
              {visible.map((p, j) => {
                const y0 = y(acc), y1 = y(acc + p.value);
                acc += p.value;
                const h = Math.max(0, y0 - y1 - (j < visible.length - 1 ? 2 : 0));
                const top = j === visible.length - 1;
                return (
                  <rect key={p.key} x={cx - barW / 2} y={y1} width={barW} height={Math.max(h, 1)} rx={top ? 4 : 0}
                    fill={colors.get(p.key) ?? 'var(--series-other)'} tabIndex={0}
                    {...bind(<><b>{d.x}</b><br />{p.key}: {format(p.value)}{p.note ? <><br /><span className="muted">{p.note}</span></> : null}<br /><span className="muted">day total {format(total)}</span></>)} />
                );
              })}
              {(i % labelEvery === 0) && (
                <text x={cx} y={height - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)" fontFamily="var(--font-mono)">{d.x.slice(5)}</text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
      </svg>
      {node}
    </div>
  );
}

export interface HBarDatum { label: string; value: number | null; color?: string; tip?: ReactNode; suffix?: ReactNode }

export function HBars({ data, format = usd, max: forcedMax }: { data: HBarDatum[]; format?: (v: number) => string; max?: number }) {
  const { bind, node } = useTooltip();
  const max = forcedMax ?? Math.max(0, ...data.map(d => d.value ?? 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map(d => (
        <div key={d.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 38%) 1fr auto', gap: 10, alignItems: 'center' }}
          {...bind(d.tip ?? <><b>{d.label}</b><br />{d.value === null ? 'unknown' : format(d.value)}</>)}>
          <span className="small wrap-any" style={{ color: 'var(--text-body)' }}>{d.label}</span>
          <span style={{ height: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
            {d.value !== null && max > 0 && (
              <span style={{ position: 'absolute', inset: 0, width: `${Math.max(1.5, (d.value / max) * 100)}%`, background: d.color ?? 'var(--series-1)', borderRadius: '0 4px 4px 0' }} />
            )}
            {d.value === null && <span style={{ position: 'absolute', inset: 0, border: '1px dashed var(--border-strong)', borderRadius: 4 }} />}
          </span>
          <span className="small mono" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.value === null ? 'unknown' : format(d.value)}{d.suffix}</span>
        </div>
      ))}
      {node}
    </div>
  );
}

export function Legend({ colors }: { colors: Map<string, string> }) {
  if (colors.size < 2) return null;
  return (
    <div className="legend">
      {[...colors].map(([k, c]) => <span key={k}><span className="swatch" style={{ background: c }} />{k}</span>)}
    </div>
  );
}
