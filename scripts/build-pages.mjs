// Builds the static demo (no server; transcription simulated in the browser) for GitHub Pages.
//   PAGES_BASE=/my-repo/ node scripts/build-pages.mjs   -> dist/pages
// In GitHub Actions the base defaults to "/<repository name>/".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.PAGES_BASE ?? (repo ? `/${repo}/` : '/');
const outDir = path.join(root, 'dist/pages');

process.env.VITE_DEMO_MODE = 'true';
process.env.VITE_BASE = base.endsWith('/') ? base : `${base}/`;
process.env.VITE_OUT_DIR = outDir;

await build({ configFile: path.join(root, 'vite.config.ts') });

// GitHub Pages serves 404.html for unknown paths: reuse the app so deep links like
// /<repo>/t/<id> load the SPA, which then routes client-side.
fs.copyFileSync(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
// Serve files as-is (no Jekyll processing).
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
console.log(`Demo built for base ${process.env.VITE_BASE} in ${path.relative(root, outDir)}`);
