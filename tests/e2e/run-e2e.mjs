// End-to-end test of the full app in a real browser: builds are served by the production server
// with the mock provider (no API key needed). Run `npm run build` first, then `npm run test:e2e`.
// Set E2E_SCREENSHOTS=<dir> to save screenshots of each step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, loadPlaywright, makeWav, startServer, writeFixture } from './harness.mjs';

const { chromium } = loadPlaywright();
const shots = process.env.E2E_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-e2e-files-'));
const interview = writeFixture(fixtures, 'Team interview.wav', makeWav(20));
const silent = writeFixture(fixtures, 'nospeech sample.wav', makeWav(5));
const failing = writeFixture(fixtures, 'fail sample.wav', makeWav(5));
const notes = writeFixture(fixtures, 'notes.txt', 'hello');

const server = await startServer({ MOCK_DELAY_MS: '1500' });
const browser = await chromium.launch();
const pageErrors = [];
let step = 0;

async function shot(page, name) {
  if (shots)
    await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`) });
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
}

async function upload(page, file, { quality, keepAudio = false } = {}) {
  await page.getByTestId('file-input').setInputFiles(file);
  await page.getByTestId('file-card').waitFor();
  if (quality) await page.getByTestId(`quality-${quality}`).click();
  // The switch's input is visually hidden; click its label like a user would.
  if (keepAudio) await page.getByText('Keep audio on the server after processing').click();
  await page.getByRole('button', { name: /Start transcription/ }).click();
  await page.waitForURL(/\/t\//, { timeout: 15_000 });
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await check('home page shows the upload panel and quality modes', async () => {
    await page.goto(server.baseUrl);
    await page.getByRole('heading', { name: /speaker-by-speaker/i }).waitFor();
    assert(await page.getByTestId('quality-ultra').isVisible(), 'quality picker visible');
    const usage = await page.getByTestId('quality-usage-ultra').textContent();
    assert(usage.includes('3 left today'), `ultra usage: ${usage}`);
    await shot(page, 'home');
  });

  await check('upload shows the file name and duration, then processes to a transcript', async () => {
    await page.getByTestId('file-input').setInputFiles(interview);
    await page.getByTestId('file-card').waitFor();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=file-duration]')?.textContent === '20s',
    );
    await page.getByTestId('quality-ultra').click();
    await page.getByRole('button', { name: /Start transcription/ }).click();
    await page.waitForURL(/\/t\//, { timeout: 15_000 });
    await page.locator('.tx-table tbody tr').first().waitFor({ timeout: 40_000 });
    const headers = (await page.locator('.tx-table thead th').allTextContents()).map((h) => h.trim());
    for (const h of ['#', 'Speaker', 'Start', 'End', 'Text']) assert(headers.includes(h), `header ${h}`);
    assert((await page.locator('.tx-table tbody tr').count()) > 3, 'several rows');
    assert((await page.locator('.tx-quality-badge').textContent()) === 'Ultra High', 'quality badge');
    await shot(page, 'transcript');
  });

  await check('clicking a row seeks the audio and highlights it', async () => {
    const third = page.locator('.tx-table tbody tr').nth(2);
    await third.locator('.tx-time-button').click();
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
    assert(t > 0, `audio position ${t}`);
    assert((await page.locator('.tx-row.is-active').count()) === 1, 'one highlighted row');
    await page
      .getByRole('button', { name: 'Pause' })
      .click()
      .catch(() => {});
  });

  await check('renaming a speaker updates every row', async () => {
    const before = await page
      .locator('.tx-table tbody tr .spk-chip-name', { hasText: /^Speaker 1$/ })
      .count();
    await page.getByRole('button', { name: /^Rename Speaker 1/ }).click();
    const input = page.getByRole('textbox', { name: /New name for Speaker 1/ });
    await input.fill('Interviewer');
    await input.press('Enter');
    await page.waitForTimeout(300);
    const after = await page
      .locator('.tx-table tbody tr .spk-chip-name', { hasText: /^Interviewer$/ })
      .count();
    assert(before > 0 && after === before, `renamed ${after} of ${before} rows`);
  });

  await check('merge, reassign and text edits are applied and saved', async () => {
    const rows = await page.locator('.tx-table tbody tr').count();
    await page.getByRole('button', { name: 'Merge row 1 with next row' }).click();
    assert((await page.locator('.tx-table tbody tr').count()) === rows - 1, 'merge removed a row');

    await page.getByRole('button', { name: /change speaker of row 2/ }).click();
    await page.getByRole('menuitem', { name: 'New speaker…' }).click();
    const name = page.getByRole('textbox', { name: 'New speaker name' });
    await name.fill('Guest');
    await name.press('Enter');
    await page.waitForTimeout(300);
    const speaker = await page.locator('.tx-table tbody tr').nth(1).locator('.spk-chip-name').textContent();
    assert(speaker === 'Guest', `row 2 speaker ${speaker}`);

    await page.getByRole('button', { name: 'Edit text of row 1' }).click();
    const text = page.getByRole('textbox', { name: 'Text of row 1' });
    await text.fill('Edited first line.');
    await text.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.save-status-text')?.textContent?.toLowerCase().includes('saved'),
    );
  });

  await check('exports download in every format', async () => {
    for (const format of [/CSV/i, /Word|DOCX/i, /Excel|XLSX/i, /SRT|Subtitles/i, /Text|TXT/i]) {
      await page.getByRole('button', { name: /Export/ }).click();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        page.getByRole('menuitem', { name: format }).click(),
      ]);
      const file = path.join(fixtures, download.suggestedFilename());
      await download.saveAs(file);
      assert(fs.statSync(file).size > 50, `${download.suggestedFilename()} is not empty`);
      if (file.endsWith('.csv')) {
        const csv = fs.readFileSync(file, 'utf8');
        assert(csv.includes('#,Speaker,Start,End,Text'), 'CSV header');
        assert(csv.includes('Edited first line.') && csv.includes('Interviewer'), 'CSV has the edits');
      }
    }
  });

  await check('edits persist after a reload', async () => {
    await page.reload();
    await page.locator('.tx-table tbody tr').first().waitFor();
    const text = await page.locator('.tx-table tbody tr').first().locator('.tx-text').textContent();
    assert(text === 'Edited first line.', `first row after reload: ${text}`);
  });

  await check('history lists the transcript and Ultra High usage went down', async () => {
    await page.getByRole('link', { name: 'Speaker Transcriber home' }).click();
    await page.getByTestId('history-item').first().waitFor();
    const item = await page.getByTestId('history-item').first().textContent();
    assert(item.includes('Team interview') && item.includes('Done'), `history item: ${item}`);
    const usage = await page.getByTestId('quality-usage-ultra').textContent();
    assert(usage.includes('2 left today'), `ultra usage: ${usage}`);
    await shot(page, 'history');
  });

  await check('a file without speech shows a clear error', async () => {
    await upload(page, silent);
    await page.getByText('No speech was detected in this audio.').waitFor({ timeout: 30_000 });
    await shot(page, 'no-speech');
  });

  await check('a failed transcription keeps kept audio so it can be retried', async () => {
    await page.goto(server.baseUrl);
    await upload(page, failing, { keepAudio: true });
    await page.getByText('Transcription failed').waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.getByText('Transcription failed').waitFor({ timeout: 30_000 });
  });

  await check('unsupported files are rejected before uploading', async () => {
    await page.goto(server.baseUrl);
    await page.getByTestId('file-input').setInputFiles(notes);
    await page.getByText(/isn’t a supported audio file/).waitFor();
  });

  await check('mobile layout has no horizontal scrolling', async () => {
    const mobile = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const phone = await mobile.newPage();
    phone.on('pageerror', (e) => pageErrors.push(e.message));
    await phone.goto(server.baseUrl);
    await phone.getByRole('heading', { name: /speaker-by-speaker/i }).waitFor();
    assert((await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'home fits');
    await upload(phone, interview);
    await phone.locator('.tx-table tbody tr').first().waitFor({ timeout: 40_000 });
    assert(
      (await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0,
      'transcript fits',
    );
    await shot(phone, 'mobile-transcript');
  });

  await check('no uncaught page errors', async () => {
    assert(pageErrors.length === 0, pageErrors.join(' | '));
  });
  console.log('\nAll end-to-end checks passed.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error(`\nServer output:\n${server.output()}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(fixtures, { recursive: true, force: true });
}
