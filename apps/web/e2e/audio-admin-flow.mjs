// End-to-end: trim, section loop, varispeed, offline copies, play counts,
// and the administration dashboard (owner granted via scripts/admin.mjs).
// Usage: node apps/web/e2e/audio-admin-flow.mjs [screenshotDir]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
function wav(name, seconds, freq) {
  const rate = 44100, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}
const stamp = Date.now().toString(36);
const OWNER = `own_${stamp}`, USER = `usr_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const step = (s) => console.log('✓', s);
async function open(name) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403|404|409)/.test(m.text()) && problems.push(`${name} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  return page;
}
async function register(page, user) {
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Email').fill(`${user}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(pw);
  await page.getByLabel('Confirm password').fill(pw);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
  await page.getByLabel(/I understand/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: /Library|Your space is quiet/ }).first().waitFor();
}
const audioTime = (page) => page.evaluate(() => document.querySelector('audio')?.currentTime ?? 0);

const u = await open('user');
await register(u, USER);
await u.getByRole('link', { name: 'New project' }).click();
await u.getByRole('textbox', { name: 'Name' }).fill('Drift');
await u.getByRole('button', { name: 'Create project' }).click();
await u.getByRole('heading', { name: 'Drift' }).waitFor();
await u.locator('input[type=file][multiple]').setInputFiles([wav('Long Drift.wav', 20, 196)]);
await u.locator('.track-title', { hasText: 'Long Drift' }).waitFor({ timeout: 60000 });
await u.reload();
await u.locator('.track-title', { hasText: 'Long Drift' }).waitFor();
step('uploaded a 20 s track');

// Trim 5 s – 12 s
const row = u.locator('.track', { hasText: 'Long Drift' });
await row.getByRole('button', { name: 'More for Long Drift' }).click();
await u.getByRole('menuitem', { name: 'Trim…' }).click();
const start = u.getByLabel(/^Start/);
await start.focus();
for (let i = 0; i < 50; i++) await start.press('ArrowRight');
const end = u.getByLabel(/^End/);
await end.focus();
for (let i = 0; i < 80; i++) await end.press('ArrowLeft');
await u.getByRole('button', { name: 'Save trim' }).click();
await row.getByText('trimmed').waitFor({ state: 'attached' });
await row.locator('.track-main').click();
await u.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 4.5, null, { timeout: 15000 });
const t0 = await audioTime(u);
if (t0 < 4.5 || t0 > 7) throw new Error(`trimmed playback should start near 5 s, was at ${t0}`);
step(`trim saved (encrypted with the track); playback starts at ${t0.toFixed(1)} s`);

// A–B loop
await u.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 6, null, { timeout: 10000 });
await u.locator('.player').getByRole('button', { name: /Loop a section/ }).click();
await u.waitForTimeout(1500);
await u.locator('.player').getByRole('button', { name: /set end \(B\)/ }).click();
const a = await u.evaluate(() => document.querySelector('audio').currentTime);
await u.waitForTimeout(2500);
const later = await audioTime(u);
if (later > a + 0.6) throw new Error(`A–B loop did not wrap (at ${later}, B was ${a})`);
await u.locator('.player').getByRole('button', { name: /Clear loop/ }).click();
step('A–B section loop wraps back to A');

await u.locator('.player').getByRole('button', { name: 'Varispeed' }).click();
if (await u.evaluate(() => document.querySelector('audio').preservesPitch)) throw new Error('varispeed did not turn off pitch preservation');
step('varispeed lets pitch follow speed');

// Offline copy
await row.getByRole('button', { name: 'More for Long Drift' }).click();
await u.getByRole('menuitem', { name: 'Keep offline' }).click();
await row.locator('.row-sub', { hasText: ' · offline' }).waitFor({ state: 'attached', timeout: 20000 });
await u.locator('.sidebar').getByRole('link', { name: 'Settings' }).click();
await u.locator('section', { hasText: 'Offline copies' }).locator('.row-title', { hasText: 'Long Drift' }).waitFor();
const cached = await u.evaluate(async () => (await (await caches.open('arai-offline-v1')).keys()).length);
if (cached < 1) throw new Error('no encrypted chunks in the offline cache');
step(`offline copy stored (${cached} encrypted chunk${cached === 1 ? '' : 's'}) and listed in Settings`);

// Play count visible in insights
await u.goBack();
await row.locator('.version-badge').click();
await row.getByText(/1 in 30 days/).waitFor({ timeout: 10000 });
step('play count shows in the version insights');

// Report the user's public project, then moderate as the platform owner.
await u.getByRole('button', { name: 'Edit details' }).click();
await u.getByRole('button', { name: 'Make public…' }).click();
await u.getByRole('button', { name: 'Make public', exact: true }).click();
await u.getByText(/The project is public now/).waitFor();
const projectId = new URL(u.url()).pathname.split('/').pop();
const o = await open('owner');
await register(o, OWNER);
execFileSync('node', [join(root, 'scripts', 'admin.mjs'), 'grant-owner', OWNER, '--local'], { stdio: 'pipe' });
await o.evaluate(([pid]) => fetch('/api/reports', { method: 'POST', headers: { 'X-Arai-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType: 'project', targetId: pid, reason: 'copyright', details: 'not theirs' }) }), [projectId]);
await o.goto(`${BASE}/settings`);
await o.getByRole('link', { name: 'Open the dashboard' }).click();
await o.getByRole('heading', { name: 'Administration' }).waitFor();
await o.getByText('The hash chain is intact').waitFor();
const report = o.locator('.report', { hasText: 'Drift' });
await report.getByText('copyright').waitFor();
o.once('dialog', (d) => d.accept('test takedown'));
await report.getByRole('button', { name: 'Hide project' }).click();
await o.getByText('Done. The action is in the audit log.').waitFor();
await o.locator('.row', { hasText: 'moderation.hide_project' }).first().waitFor();
if (shots) await o.screenshot({ path: `${shots}/a1-admin.png`, fullPage: true });
const listed = await o.evaluate(() => fetch('/api/discover?q=drift').then((r) => r.json()).then((j) => j.projects.length));
if (listed !== 0) throw new Error('hidden project still discoverable');
step('owner granted from the CLI; report reviewed; project hidden from discovery; audit chain intact');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
