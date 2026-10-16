// Usage: node src/server/cli.ts snapshot [--config FILE] [--out FILE]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { buildSnapshot, loadConfig } from '../core/snapshot.ts';
import { resolveConfigPath } from './config-path.ts';

const [command = 'snapshot', ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { config: { type: 'string' }, out: { type: 'string' } } });
if (command !== 'snapshot') {
  console.error('Usage: node src/server/cli.ts snapshot [--config FILE] [--out FILE]');
  process.exit(2);
}
const { config } = loadConfig(resolveConfigPath(values.config));
const snapshot = await buildSnapshot(config);
const json = JSON.stringify(snapshot, null, 2);
if (values.out) fs.writeFileSync(values.out, json);
else process.stdout.write(json + '\n');
