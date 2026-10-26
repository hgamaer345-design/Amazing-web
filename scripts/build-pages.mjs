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

const modelsDir = await fetchSpeechModels();
await build({ configFile: path.join(root, 'vite.config.ts') });

// The speaker models, SenseVoice and Omnilingual ASR are served from the site itself (see
// scripts/fetch-speech-models.mjs).
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
    // Always "require-corp": Safari ignores COEP "credentialless" (the library's default there)
    // and would never be cross-origin isolated. The only cross-origin fetches (Hugging Face) use
    // CORS, which require-corp allows. On iPhone and iPad the demo runs single-threaded (iOS
    // handles multi-threaded WebAssembly badly and kills the tab), so isolation isn't needed: no
    // service worker there, and one installed by an earlier version is removed.
    `${charset}\n    <script>(() => { const appleMobile = /iP(hone|ad|od)/.test(navigator.userAgent) || ` +
      `(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); window.coi = { ` +
      `coepCredentialless: () => false, shouldRegister: () => !appleMobile, ` +
      `shouldDeregister: () => appleMobile, quiet: true }; })();</script>` +
      `\n    <script src="${process.env.VITE_BASE}coi-serviceworker.js"></script>`,
  ),
);

// Licences of the libraries bundled into the speech worker (their notices don't survive minification).
const licence = (name, file) =>
  `${name}\n${'='.repeat(name.length)}\n\n${fs.readFileSync(path.join(root, 'node_modules', file), 'utf8').trim()}\n`;
fs.writeFileSync(
  path.join(outDir, 'THIRD-PARTY-LICENSES.txt'),
  [
    'Third-party software in the in-browser demo. Speech models: see models/ATTRIBUTION.txt.\n' +
      'Whisper (OpenAI, MIT) is downloaded at run time from the Hugging Face hub (ONNX conversions by Xenova).\n',
    licence('Transformers.js (@huggingface/transformers)', '@huggingface/transformers/LICENSE'),
    `ONNX Runtime Web (onnxruntime-web)\n${'='.repeat(34)}\n\nMIT License\n\nCopyright (c) Microsoft Corporation\n\n` +
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and ' +
      'associated documentation files (the "Software"), to deal in the Software without restriction, including ' +
      'without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell ' +
      'copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the ' +
      'following conditions:\n\nThe above copyright notice and this permission notice shall be included in all ' +
      'copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ' +
      'ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A ' +
      'PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY ' +
      'CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF ' +
      'OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n',
    licence('coi-serviceworker', 'coi-serviceworker/LICENSE'),
  ].join('\n'),
);

// GitHub Pages serves 404.html for unknown paths: reuse the app so deep links like
// /<repo>/t/<id> load the SPA, which then routes client-side.
fs.copyFileSync(indexFile, path.join(outDir, '404.html'));
// Serve files as-is (no Jekyll processing).
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

// GitHub refuses pushes with files over 100 MB, and Pages sites may be at most 1 GB.
let siteBytes = 0;
for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const { size } = fs.statSync(file);
  if (size >= 100 * 1000 * 1000)
    throw new Error(`${path.relative(outDir, file)} is over GitHub's 100 MB limit`);
  siteBytes += size;
}
if (siteBytes > 1000 * 1000 * 1000)
  throw new Error(`The site is ${Math.round(siteBytes / 1e6)} MB, over the 1 GB limit`);
console.log(
  `Demo built for base ${process.env.VITE_BASE} in ${path.relative(root, outDir)} (${Math.round(siteBytes / 1e6)} MB)`,
);
