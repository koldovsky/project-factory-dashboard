import { buildSnapshot, loadConfig } from '../core/snapshot.ts';
import type { Snapshot } from '../core/types.ts';

/** Rebuilds the snapshot at most every `ttlMs`; concurrent requests share one build. */
export function snapshotProvider(configPath: string, ttlMs = 4000) {
  let cached: { at: number; value: Snapshot } | null = null;
  let inFlight: Promise<Snapshot> | null = null;
  return async (): Promise<Snapshot> => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    inFlight ??= (async () => {
      try {
        const { config } = loadConfig(configPath);
        const value = await buildSnapshot(config);
        cached = { at: Date.now(), value };
        return value;
      } finally { inFlight = null; }
    })();
    return inFlight;
  };
}
