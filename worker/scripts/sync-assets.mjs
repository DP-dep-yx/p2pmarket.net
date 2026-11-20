// Copies the static site from the repo root into worker/public for deployment.
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'public');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const EXCLUDE = new Set(['.git', '.gitignore', 'node_modules', 'worker', 'opencode.json', 'CNAME',
  'trust_net_system_v10.docx', 'trust_net_system_v12.docx']);

function isExcluded(name) {
  if (EXCLUDE.has(name)) return true;
  if (name.endsWith('.Zone.Identifier')) return true;
  return false;
}

function copyDir(src, dst) {
  for (const name of readdirSync(src)) {
    if (isExcluded(name)) continue;
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      cpSync(s, d);
    }
  }
}

copyDir(repoRoot, outDir);
console.log('Synced static site into worker/public');
