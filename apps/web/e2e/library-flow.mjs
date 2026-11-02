// End-to-end: library search (projects + decrypted track titles), pins,
// folders and recently played; preferences are stored encrypted and survive
// a reload. Usage: node apps/web/e2e/library-flow.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
function wav(name, seconds) {
  const rate = 44100, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}
const user = `lib_${Date.now().toString(36)}`;
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
for (const name of ['Alpha Room', 'Beta Tapes']) {
  await page.getByRole('link', { name: 'New project' }).first().click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('heading', { name }).waitFor();
  if (name === 'Beta Tapes') {
    await page.locator('input[type=file][multiple]').setInputFiles([wav('Moonlit Bassline.wav', 3)]);
    await page.locator('.track-title', { hasText: 'Moonlit Bassline' }).waitFor({ timeout: 60000 });
  }
  await page.locator('.sidebar').getByRole('link', { name: 'Library' }).click();
}
await page.getByRole('heading', { name: 'Library' }).waitFor();

await page.getByLabel('Search your library').fill('moonlit');
await page.locator('.row-title', { hasText: 'Moonlit Bassline' }).waitFor({ timeout: 15000 });
await page.getByRole('button', { name: 'Play Moonlit Bassline' }).click();
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.2, null, { timeout: 15000 });
step('search finds a track by its (decrypted) title and plays it');
await page.getByLabel('Search your library').fill('');

await page.getByRole('button', { name: 'Pin Alpha Room' }).click();
await page.getByRole('button', { name: 'Folders…' }).click();
await page.getByLabel('New folder name').fill('Live set');
await page.getByRole('button', { name: 'Add folder' }).click();
await page.getByRole('dialog').getByLabel('Beta Tapes').check();
await page.keyboard.press('Escape');
await page.waitForTimeout(1500); // let the encrypted prefs save
await page.reload();
await page.getByRole('heading', { name: 'Library' }).waitFor();
await page.locator('.recent-item', { hasText: 'Moonlit Bassline' }).waitFor({ timeout: 10000 });
const first = await page.locator('.sleeve-name').first().textContent();
if (first !== 'Alpha Room') throw new Error(`pinned project should come first, got ${first}`);
await page.getByRole('button', { name: 'Live set' }).click();
const inFolder = await page.locator('.sleeve-name').allTextContents();
if (inFolder.join() !== 'Beta Tapes') throw new Error(`folder shows ${inFolder}`);
step('pins, folders and recently played persist across a reload');
const raw = await page.evaluate(() => fetch('/api/account/prefs').then((r) => r.text()));
if (raw.includes('Live set') || raw.includes('Moonlit')) throw new Error('preferences reached the server unencrypted');
step('preferences are stored encrypted');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
