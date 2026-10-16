import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Mirrors project-factory-next src/files.mjs so the dashboard can re-verify evidence on its own,
// without importing (or trusting) code from the run store it is inspecting.
export const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export const digestJson = (value: unknown) => sha256(JSON.stringify(value));

export function treeManifest(root: string): { files: Record<string, string>; digest: string } {
  const files: Record<string, string> = Object.create(null);
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in evidence: ${relative}`);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) files[relative] = sha256(fs.readFileSync(absolute));
    }
  };
  walk(root);
  return { files, digest: digestJson(files) };
}
