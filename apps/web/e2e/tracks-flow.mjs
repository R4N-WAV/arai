// End-to-end: encrypted uploads, playback, versions. Run against `wrangler dev`.
// Usage: node apps/web/e2e/tracks-flow.mjs [screenshotDir]
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));

/** 16-bit mono PCM WAV with a sine tone. */
function wav(name, seconds, freq) {
  const rate = 44100, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * (0.6 + 0.4 * Math.sin(i / 9000))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}
const glass = wav('Glass Hours.wav', 30, 220); // ~2.6 MB → 3 chunks
const undertow = wav('Undertow.wav', 4, 330);
const glass2 = wav('Glass Hours v2.wav', 5, 440);
const fake = join(dir, 'not-audio.wav');
writeFileSync(fake, 'this is just text pretending to be audio');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const glassHash = sha(Buffer.from(await import('node:fs').then((f) => f.readFileSync(glass))));

const user = `trk_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const chunkBodies = [];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && !m.text().includes('status of 404') && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('request', (r) => r.method() === 'PUT' && r.url().includes('/chunks/') && chunkBodies.push(r.postDataBuffer()));
const step = (s) => console.log('✓', s);
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

await page.goto(`${BASE}/register`);
await page.getByLabel('Username').fill(user);
await page.getByLabel('Email').fill(`${user}@example.com`);
await page.getByLabel('Password', { exact: true }).fill(pw);
await page.getByLabel('Confirm password').fill(pw);
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
await page.getByLabel(/I understand/).check();
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('link', { name: 'New project' }).click();
await page.getByRole('textbox', { name: 'Name' }).fill('Night Sessions');
await page.getByLabel('Brick').check({ force: true });
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Night Sessions' }).waitFor();
step('signed up and created a project');

await page.locator('.dropzone input[type=file]').setInputFiles([glass, undertow]);
await page.getByText('Glass Hours', { exact: true }).waitFor({ timeout: 60000 });
await page.getByText('Undertow', { exact: true }).waitFor({ timeout: 60000 });
await page.locator('.track', { hasText: 'Glass Hours' }).getByText('0:30').waitFor();
step('two WAV files uploaded; tracks listed with durations');
if (chunkBodies.length < 4) throw new Error(`expected ≥4 chunk uploads, saw ${chunkBodies.length}`);
for (const b of chunkBodies) if (!b || b.includes(Buffer.from('RIFF')) || b.includes(Buffer.from('WAVE'))) throw new Error('a chunk left the browser unencrypted');
step(`all ${chunkBodies.length} uploaded chunks were ciphertext (no WAV headers)`);
await shot('t1-tracks');

await page.getByRole('button', { name: 'Play Glass Hours' }).click();
await page.locator('.player').getByText('Glass Hours').waitFor();
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.5, null, { timeout: 30000 });
step('decrypted and playing (audio clock advancing)');
const playedHash = await page.evaluate(async () => {
  const blob = await (await fetch(document.querySelector('audio').src)).arrayBuffer();
  const d = await crypto.subtle.digest('SHA-256', blob);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
});
if (playedHash !== glassHash) throw new Error('decrypted audio differs from the original file');
step('decrypted audio is byte-identical to the uploaded original (lossless)');
const slider = page.getByRole('slider', { name: /Seek in Glass Hours/ });
await slider.focus();
await page.keyboard.press('PageUp');
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 20, null, { timeout: 10000 });
step('keyboard seeking on the waveform works');
await page.locator('.player').getByRole('combobox', { name: 'Playback speed' }).selectOption('1.5');
if ((await page.evaluate(() => document.querySelector('audio').playbackRate)) !== 1.5) throw new Error('speed not applied');
step('playback speed changes');
await shot('t2-playing');

const first = page.locator('.track', { hasText: 'Glass Hours' });
await first.getByRole('button', { name: /Versions/ }).click();
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), first.getByRole('button', { name: 'Upload new version' }).click()]);
await chooser.setFiles(glass2);
await first.getByRole('button', { name: 'Play version 2' }).waitFor({ timeout: 60000 });
await first.getByText('v2 ·').waitFor();
step('new version uploaded and became current');
await first.getByRole('button', { name: /Make current/ }).click();
await first.getByText('v1 ·').waitFor();
step('restored version 1 as current; version 2 kept in history');

await page.locator('.dropzone input[type=file]').setInputFiles(fake);
await page.getByText('not a supported audio format').waitFor();
step('a fake .wav (text) is rejected by content sniffing');

await first.getByRole('button', { name: 'Delete track…' }).click();
await first.getByRole('button', { name: 'Delete', exact: true }).click();
await page.locator('.track-title', { hasText: 'Glass Hours' }).waitFor({ state: 'detached' });
step('track deleted');

await page.setViewportSize({ width: 375, height: 760 });
if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('horizontal overflow on mobile');
await shot('t3-mobile');
step('tracks and player fit a phone screen');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
