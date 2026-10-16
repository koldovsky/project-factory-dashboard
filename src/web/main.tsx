import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot } from '../core/types.ts';
import { Monitor } from './views/Monitor.tsx';
import { Gates } from './views/Gates.tsx';
import { Cost } from './views/Cost.tsx';
import { Trace } from './views/Trace.tsx';
import { Evidence } from './views/Evidence.tsx';
import { when } from './ui.tsx';
import './styles.css';

const TABS = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'gates', label: 'Gates & review' },
  { id: 'cost', label: 'Cost' },
  { id: 'trace', label: 'Agent trace' },
  { id: 'evidence', label: 'Trace chain & holdout' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function readHash(): { tab: Tab; run: string | null } {
  const [tab, run] = decodeURIComponent(location.hash.replace(/^#/, '')).split('/');
  return { tab: (TABS.some(t => t.id === tab) ? tab : 'monitor') as Tab, run: run || null };
}

function App() {
  const [{ tab, run }, setRoute] = useState(readHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setSnapshot(body);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => { clearInterval(timer); window.removeEventListener('hashchange', onHash); };
  }, [load]);

  const go = (t: Tab, r: string | null = null) => { location.hash = r ? `${t}/${encodeURIComponent(r)}` : t; };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1>Factory Control Room</h1>
          <span className="eyebrow">project-factory-next · v2</span>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}>{t.label}</button>)}
        </nav>
        <div className="live">
          <span className={`dot${error ? ' off' : ''}`} aria-hidden />
          {error ? <span className="issue">API error: {error}</span> : snapshot ? <>live · snapshot {when(snapshot.generatedAt, false)}</> : 'loading…'}
        </div>
      </header>
      {!snapshot ? <div className="empty">{error ? 'Could not load the snapshot. Is the config pointing at a factory checkout?' : 'Reading factory data…'}</div> : (
        <main>
          {tab === 'monitor' && <Monitor snapshot={snapshot} openRun={key => go('trace', key)} />}
          {tab === 'gates' && <Gates snapshot={snapshot} openRun={key => go('trace', key)} />}
          {tab === 'cost' && <Cost snapshot={snapshot} />}
          {tab === 'trace' && <Trace snapshot={snapshot} selected={run} select={key => go('trace', key)} />}
          {tab === 'evidence' && <Evidence snapshot={snapshot} />}
        </main>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
