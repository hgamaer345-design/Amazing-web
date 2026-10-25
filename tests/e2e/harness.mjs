// Helpers for the end-to-end test: start the built server with the mock provider in a temp
// data directory, generate WAV fixtures, and load Playwright.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed. Install it with `npm i -D playwright && npx playwright install chromium`.',
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts dist/server/index.js with the mock provider. Returns { baseUrl, dataDir, stop }. */
export async function startServer(extraEnv = {}) {
  const entry = path.join(ROOT, 'dist/server/index.js');
  if (!fs.existsSync(entry) || !fs.existsSync(path.join(ROOT, 'dist/public/index.html'))) {
    throw new Error('Build the app first: npm run build');
  }
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-e2e-'));
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_DIR: path.join(ROOT, 'dist/public'),
      TRANSCRIPTION_PROVIDER: 'mock',
      MOCK_DELAY_MS: '1500',
      WORKER_POLL_INTERVAL_MS: '200',
      ASSEMBLYAI_API_KEY: '',
      DEEPGRAM_API_KEY: '',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`Server exited early:\n${output}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    baseUrl,
    dataDir,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => {
        if (child.exitCode != null) r();
        else child.once('exit', r);
        setTimeout(r, 5000);
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A mono 16-bit PCM WAV with a quiet tone, `seconds` long. */
export function makeWav(seconds, sampleRate = 8000) {
  const samples = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2000), 44 + i * 2);
  }
  return buf;
}

export function writeFixture(dir, name, contents) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
