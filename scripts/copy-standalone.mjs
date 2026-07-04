import { cpSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

const root = process.cwd();
const standaloneDir = join(root, '.next', 'standalone');

function copyRecursive(src, dest) {
  if (!existsSync(src)) return;
  if (statSync(src).isDirectory()) {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
  } else {
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    try {
      copyFileSync(src, dest);
    } catch (err) {
      // Skip files with invalid Windows chars (e.g., colons in names like node:inspector)
      if (err.code === 'EINVAL') {
        console.warn(`Skipping (invalid filename on Windows): ${src}`);
      } else {
        throw err;
      }
    }
  }
}

const nextDir = join(standaloneDir, '.next');
copyRecursive(join(root, '.next', 'static'), join(nextDir, 'static'));
copyRecursive(join(root, 'public'), join(standaloneDir, 'public'));
