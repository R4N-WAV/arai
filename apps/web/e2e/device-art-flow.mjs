// End-to-end: remembered device (no password after closing the app), artwork
// upload (encrypted; public copy when public), readable dropdowns, quiet grain.
// Usage: node apps/web/e2e/device-art-flow.mjs [screenshotDir]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
const user = `dev_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
};
let page = await ctx.newPage();
watch(page);
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
await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor();
await page.waitForFunction(() => !!localStorage.getItem('arai.device-unlock'), null, { timeout: 10000 });

// "Close the app": close every page, open a fresh one in the same browser profile.
await page.close();
page = await ctx.newPage();
watch(page);
await page.goto(`${BASE}/`);
await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor({ timeout: 15000 });
if (await page.getByLabel('Password', { exact: true }).count()) throw new Error('asked for the password again');
step('reopening the app goes straight in (remembered device, no password)');

const raw = await page.evaluate(() => localStorage.getItem('arai.device-unlock'));
if (!raw || raw.includes('ask') || !JSON.parse(raw).iv2) throw new Error('stored unlock blob is not double-encrypted');
step('the stored keys are wrapped by a device-only key and the session’s server secret');

// Artwork
await page.getByRole('link', { name: 'New project' }).click();
await page.getByRole('textbox', { name: 'Name' }).fill('Cover Story');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Cover Story' }).waitFor();
const png = join(dir, 'art.png');
const art = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 600;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 900, 600);
  grad.addColorStop(0, '#d4552b'); grad.addColorStop(1, '#2b6fd4');
  g.fillStyle = grad; g.fillRect(0, 0, 900, 600);
  return c.toDataURL('image/png').split(',')[1];
});
writeFileSync(png, Buffer.from(art, 'base64'));
const sent = [];
page.on('request', (r) => r.method() === 'PUT' && r.url().endsWith('/art') && sent.push(r.postDataBuffer()));
await page.getByRole('button', { name: 'Edit details' }).click();
// The colour select in the overlay must be readable: solid dark options, light text.
const opt = await page.evaluate(() => { const o = document.querySelector('dialog[open] select option, select option'); if (!o) return null; const s = getComputedStyle(o); return [s.color, s.backgroundColor]; });
if (opt && (opt[1] === 'rgba(0, 0, 0, 0)' || opt[1] === 'rgb(255, 255, 255)')) throw new Error(`dropdown options unreadable: ${opt}`);
await page.locator('input[type=file][accept^="image/"]').setInputFiles(png);
await page.getByRole('button', { name: 'Use picture' }).click();
await page.getByText('Artwork saved.').waitFor({ timeout: 20000 });
if (!sent.length || sent[0].includes(Buffer.from('PNG')) || sent[0].includes(Buffer.from('WEBP'))) throw new Error('artwork left the browser unencrypted');
await page.keyboard.press('Escape');
await page.locator('.project-hero .cover img').waitFor();
step('artwork cropped, encrypted, uploaded and shown on the project');
await page.locator('.sidebar').getByRole('link', { name: 'Library' }).click();
await page.locator('.sleeve .cover img').waitFor();
step('library shows the artwork');
if (shots) await page.screenshot({ path: `${shots}/d1-library-art.png` });

const grain = await page.evaluate(() => { const g = document.querySelector('.ambient-grain'); const s = g && getComputedStyle(g); return s ? [s.mixBlendMode, Number(s.opacity)] : null; });
if (!grain || grain[0] !== 'overlay' || grain[1] > 0.3) throw new Error(`grain still sits on top: ${grain}`);
step('grain only blends into the colour (overlay, ≤ 0.3)');

// Signing out forgets the device.
await page.getByRole('button', { name: 'Sign out' }).first().click();
await page.getByRole('heading', { name: /Sign in/ }).first().waitFor();
if (await page.evaluate(() => localStorage.getItem('arai.device-unlock'))) throw new Error('sign out left the device unlock blob');
step('signing out removes the remembered device');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
