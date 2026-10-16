// Captures README screenshots of a running dashboard: node scripts/shots.ts [--url http://127.0.0.1:4317] [--out docs/screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
const base = values.url ?? 'http://127.0.0.1:4317';
const out = path.resolve(values.out ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });
const pages = [
  { name: 'monitor', hash: '#monitor' },
  { name: 'gates', hash: '#gates' },
  { name: 'cost', hash: '#cost' },
  { name: 'trace-delivery', hash: `#trace/${encodeURIComponent('demo next-gen store:csv-export-01')}` },
  { name: 'trace-review-gate', hash: `#trace/${encodeURIComponent('demo v2 project (token-shop):wf_demo03')}` },
  { name: 'evidence', hash: '#evidence' },
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
for (const p of pages) {
  await page.goto(`${base}/${p.hash}`);
  await page.waitForSelector('main');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `${p.name}.png`), fullPage: true });
  console.log(`${p.name}.png`);
}
await browser.close();
