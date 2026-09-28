import { cpSync, mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The docs directory is the GitHub Pages deployment artifact, generated from dist.
const root = dirname(fileURLToPath(import.meta.url));
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });
cpSync(join(root, 'dist'), docs, { recursive: true });
// Remove only obsolete generated bundles, retaining every other docs file.
const assets = join(docs, 'assets');
for (const name of readdirSync(assets)) {
  if (/^index-[\w-]+\.(js|css)$/.test(name) && !existsSync(join(root, 'dist', 'assets', name))) unlinkSync(join(assets, name));
}
writeFileSync(join(docs, '.nojekyll'), '');
console.log('GitHub Pages build prepared in docs/');
