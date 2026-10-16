import fs from 'node:fs';
import path from 'node:path';

/** --config, then FACTORY_DASH_CONFIG, then ./factory-dash.config.json, then the bundled demo dataset. */
export function resolveConfigPath(explicit?: string): string {
  const candidates = [explicit, process.env.FACTORY_DASH_CONFIG, 'factory-dash.config.json'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
    if (candidate === explicit || candidate === process.env.FACTORY_DASH_CONFIG) throw new Error(`Config not found: ${candidate}`);
  }
  const demo = path.resolve('.demo', 'factory-dash.config.json');
  if (fs.existsSync(demo)) return demo;
  throw new Error('No factory-dash.config.json found. Copy factory-dash.config.example.json, or run `pnpm demo:data` for the demo dataset.');
}
