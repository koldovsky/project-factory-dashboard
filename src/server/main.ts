// Production server: serves the built UI from dist/ and the snapshot API. Read-only: it never writes
// into run stores or projects (only its own transcript cache, if configured).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfigPath } from './config-path.ts';
import { snapshotProvider } from './provider.ts';

const { values } = parseArgs({ options: { config: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' } } });
const configPath = resolveConfigPath(values.config);
const getSnapshot = snapshotProvider(configPath);
const port = Number(values.port ?? process.env.PORT ?? 4317);
const host = values.host ?? '127.0.0.1';
const dist = path.resolve(import.meta.dirname, '..', '..', 'dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/snapshot') {
    try {
      const body = JSON.stringify(await getSnapshot());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }
  const file = path.join(dist, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^([\/]|\.\.)+/, ''));
  const target = file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html');
  if (!fs.existsSync(target)) { res.writeHead(503); res.end('UI not built: run `pnpm build` (or use `pnpm dev`).'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});
server.listen(port, host, () => console.log(`Factory dashboard on http://${host}:${port}  (config: ${configPath})`));
