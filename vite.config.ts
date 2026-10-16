import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveConfigPath } from './src/server/config-path.ts';
import { snapshotProvider } from './src/server/provider.ts';

// `pnpm dev` serves the snapshot API from the same process as the UI (no second server to start).
export default defineConfig({
  plugins: [react(), {
    name: 'factory-snapshot-api',
    configureServer(server) {
      // Resolved on the first request: Vitest also starts this server, and needs no factory config.
      let getSnapshot: ReturnType<typeof snapshotProvider> | null = null;
      server.middlewares.use('/api/snapshot', async (_req, res) => {
        try {
          getSnapshot ??= snapshotProvider(resolveConfigPath());
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(await getSnapshot()));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  }],
  server: { port: 4318, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
