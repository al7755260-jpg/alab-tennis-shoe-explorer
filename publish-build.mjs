import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The docs directory is the GitHub Pages deployment artifact, generated from dist.
const root = dirname(fileURLToPath(import.meta.url));
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });
cpSync(join(root, 'dist'), docs, { recursive: true });
writeFileSync(join(docs, '.nojekyll'), '');
console.log('GitHub Pages build prepared in docs/');
