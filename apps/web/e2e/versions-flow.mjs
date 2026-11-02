// End-to-end: A/B compare (synced, instant switch, loudness-matched) and AIFF
// playback in Chromium via in-browser WAV rewrite.
// Usage: node apps/web/e2e/versions-flow.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
const rate = 44100;
function pcm(seconds, freq, amp) {
  const n = rate * seconds, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp);
  return out;
}
function wav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}
function aiff(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16BE(s, i * 2));
  const comm = Buffer.alloc(26);
  comm.write('COMM', 0); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(1, 8); comm.writeUInt32BE(samples.length, 10); comm.writeUInt16BE(16, 14);
  comm.writeUInt16BE(16383 + 15, 16); comm.writeUInt32BE(44100 * 2 ** 16, 18); comm.writeUInt32BE(0, 22);
  const ssnd = Buffer.alloc(16); ssnd.write('SSND', 0); ssnd.writeUInt32BE(8 + data.length, 4);
  const body = Buffer.concat([Buffer.from('AIFF'), comm, ssnd, data]);
  const head = Buffer.alloc(8); head.write('FORM', 0); head.writeUInt32BE(body.length, 4);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([head, body]));
  return p;
}
const v1 = wav('Halo.wav', pcm(6, 220, 6000));
const v2 = wav('Halo v2.wav', pcm(6, 220, 16000)); // louder mix
const aif = aiff('Room Tone.aif', pcm(4, 330, 9000));

const user = `ver_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/register`);
await page.getByLabel('Username').fill(user);
await page.getByLabel('Email').fill(`${user}@example.com`);
await page.getByLabel('Password', { exact: true }).fill(pw);
await page.getByLabel('Confirm password').fill(pw);
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
await page.getByLabel(/I understand/).check();
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 }); // first-run guide
await page.getByRole('link', { name: 'New project' }).first().click();
await page.getByRole('textbox', { name: 'Name' }).fill('Versions');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Versions' }).waitFor();
await page.locator('input[type=file][multiple]').setInputFiles([v1, aif]);
await page.locator('.track-title', { hasText: 'Room Tone' }).waitFor({ timeout: 60000 });
await page.locator('.track-title', { hasText: 'Halo' }).waitFor({ timeout: 60000 });
const halo = page.locator('.track', { hasText: 'Halo' });
await halo.getByRole('button', { name: 'More for Halo' }).click();
await page.getByRole('menuitem', { name: 'Upload new version' }).click();
await page.locator('input[type=file]:not([multiple])').first().setInputFiles(v2);
await halo.locator('.row-sub', { hasText: 'v2' }).waitFor({ state: 'attached', timeout: 60000 });

// AIFF in Chromium (which cannot decode AIFF itself).
const room = page.locator('.track', { hasText: 'Room Tone' });
if (!(await room.locator('.track-time').textContent()).includes('0:04')) throw new Error('AIFF was not analysed (no duration)');
await room.locator('.track-main').click();
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.3, null, { timeout: 20000 });
step('AIFF upload analysed and plays in Chromium (WAV rewrite in the browser)');
await page.locator('.player').getByRole('button', { name: 'Pause' }).click();

await halo.getByRole('button', { name: 'More for Halo' }).click();
await page.getByRole('menuitem', { name: 'Compare versions…' }).click();
const dlg = page.getByRole('dialog');
await dlg.getByText(/B is .* dB (louder|quieter) than A; levels matched/).waitFor({ timeout: 20000 });
await dlg.getByRole('button', { name: 'Play both' }).click();
await page.waitForTimeout(2200);
await page.keyboard.press('b');
if ((await dlg.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')) !== 'true') throw new Error('B key did not switch');
await page.keyboard.press('a');
if ((await dlg.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')) !== 'true') throw new Error('A key did not switch');
const t = await dlg.locator('.compare-controls .mono').textContent();
if (t.startsWith('0:00 /')) throw new Error('compare playback did not advance');
step(`A/B compare plays both in sync, switches with A/B keys, matches loudness (${t})`);

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
