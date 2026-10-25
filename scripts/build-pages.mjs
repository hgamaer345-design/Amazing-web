// Builds the static demo for GitHub Pages: no server, transcription runs in the visitor's browser.
//   PAGES_BASE=/my-repo/ node scripts/build-pages.mjs   -> dist/pages
// In GitHub Actions the base defaults to "/<repository name>/".
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { fetchSpeechModels } from './fetch-speech-models.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.PAGES_BASE ?? (repo ? `/${repo}/` : '/');
const outDir = path.join(root, 'dist/pages');

process.env.VITE_DEMO_MODE = 'true';
process.env.VITE_BASE = base.endsWith('/') ? base : `${base}/`;
process.env.VITE_OUT_DIR = outDir;

const modelsDir = fetchSpeechModels();
await build({ configFile: path.join(root, 'vite.config.ts') });

// The speaker models are served from the site itself (see src/web/demo/speech/models.ts).
fs.cpSync(modelsDir, path.join(outDir, 'models'), { recursive: true });

// GitHub Pages can't send the COOP/COEP headers that multi-threaded WebAssembly needs; this
// service worker adds them (the page reloads once on the first visit).
fs.copyFileSync(
  require.resolve('coi-serviceworker/coi-serviceworker.min.js'),
  path.join(outDir, 'coi-serviceworker.js'),
);
const indexFile = path.join(outDir, 'index.html');
const html = fs.readFileSync(indexFile, 'utf8');
const charset = '<meta charset="UTF-8" />';
if (!html.includes(charset)) throw new Error('index.html has no charset meta tag');
fs.writeFileSync(
  indexFile,
  html.replace(
    charset,
    `${charset}\n    <script src="${process.env.VITE_BASE}coi-serviceworker.js"></script>`,
  ),
);

// GitHub Pages serves 404.html for unknown paths: reuse the app so deep links like
// /<repo>/t/<id> load the SPA, which then routes client-side.
fs.copyFileSync(indexFile, path.join(outDir, '404.html'));
// Serve files as-is (no Jekyll processing).
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
console.log(`Demo built for base ${process.env.VITE_BASE} in ${path.relative(root, outDir)}`);
