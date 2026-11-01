// End-to-end: centred layout, profiles (pictures, links, public view) and library import.
// Usage: node apps/web/e2e/profile-import-flow.mjs [screenshotDir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { zipSync } = require('../../../node_modules/fflate/lib/index.cjs');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-imp-'));

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = (g + x) & 255; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds, freq) {
  const rate = 22050, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const avatar = join(dir, 'me.png'); writeFileSync(avatar, png(900, 700, [180, 60, 40]));
const banner = join(dir, 'wide.png'); writeFileSync(banner, png(1200, 400, [40, 90, 160]));
const exportDir = join(dir, 'Library export');
mkdirSync(join(exportDir, 'Night Sessions'), { recursive: true });
mkdirSync(join(exportDir, 'Tidal EP'), { recursive: true });
writeFileSync(join(exportDir, 'Night Sessions', 'Glass Hours v1.wav'), wav(2, 220));
writeFileSync(join(exportDir, 'Night Sessions', 'Glass Hours v2.wav'), wav(3, 330));
writeFileSync(join(exportDir, 'Night Sessions', 'cover.png'), png(64, 64, [200, 40, 60]));
writeFileSync(join(exportDir, 'Tidal EP', 'Low Tide.wav'), wav(2, 440));
writeFileSync(join(exportDir, 'Tidal EP', 'notes.txt'), 'mix notes');
const zipPath = join(dir, 'Late Bloom.zip');
writeFileSync(zipPath, zipSync({ 'Late Bloom/Soft Machine.wav': new Uint8Array(wav(2, 550)), 'Late Bloom/__MACOSX/._x': new Uint8Array(3) }));

const user = `imp_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
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
await page.getByRole('heading', { name: 'Your space is quiet.' }).waitFor();

// centred layout: equal space either side of the content column (within the area right of the sidebar)
await page.getByRole('link', { name: 'Settings' }).first().click();
await page.getByRole('heading', { name: 'Settings' }).waitFor();
const box = await page.evaluate(() => { const r = document.querySelector('.content').getBoundingClientRect(); const s = document.querySelector('.sidebar').getBoundingClientRect(); return { left: r.left - s.right, right: window.innerWidth - r.right }; });
if (Math.abs(box.left - box.right) > 4) throw new Error(`content not centred: ${JSON.stringify(box)}`);
step('content column is centred on a wide screen');

// profile
await page.locator('.sidebar .user-chip').click();
await page.getByRole('heading', { name: user }).waitFor();
await page.getByRole('link', { name: 'Edit profile' }).click();
await page.getByLabel('Display name').fill('Ranuj');
await page.getByLabel('Bio').fill('Producer. Late nights, slow songs.');
await page.getByLabel('Location').fill('Chennai');
await page.getByRole('button', { name: 'Add link' }).click();
await page.getByLabel(/^Link 1/).fill('http://insecure.example');
await page.getByRole('button', { name: 'Save profile' }).click();
await page.getByRole('alert').getByText('full https:// address').waitFor();
await page.getByLabel(/^Link 1/).fill('https://soundcloud.com/ranuj');
const [ac] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add profile picture' }).click()]);
await ac.setFiles(avatar);
await page.getByRole('dialog', { name: 'Position your picture' }).waitFor();
await page.getByRole('slider', { name: 'Zoom' }).fill('1.6');
await page.getByRole('button', { name: 'Use picture' }).click();
await page.getByText('Profile picture updated.').waitFor();
await page.locator('.sidebar .user-chip img').waitFor();
const [bc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add header' }).click()]);
await bc.setFiles(banner);
await page.getByRole('dialog', { name: 'Position your header' }).waitFor();
await page.getByRole('button', { name: 'Use picture' }).click();
await page.getByText('Header updated.').waitFor();
await page.getByRole('button', { name: 'Save profile' }).click();
await page.getByRole('heading', { name: 'Ranuj' }).waitFor({ timeout: 8000 }).catch(async (e) => { if (shots) await page.screenshot({ path: `${shots}/pi-fail.png`, fullPage: true }); throw e; });
await page.getByRole('link', { name: /SoundCloud/ }).waitFor();
const imgOk = await page.evaluate(() => [...document.querySelectorAll('.profile img')].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.profile img').length === 2);
if (!imgOk) throw new Error('profile images did not load');
const av = await page.evaluate(() => { const i = document.querySelector('.profile-head img'); return [i.naturalWidth, i.naturalHeight]; });
if (av[0] !== av[1] || av[0] > 512) throw new Error(`avatar not cropped/resized: ${av}`);
step('profile edited: name, bio, location, safe link (http rejected); picture and header scaled/cropped then re-encoded; sidebar shows the picture');
await shot('pi1-profile');

const visitor = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await visitor.goto(`${BASE}/u/${user}`);
await visitor.getByRole('heading', { name: 'Ranuj' }).waitFor();
await visitor.getByRole('link', { name: 'Sign in' }).waitFor();
if (await visitor.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('profile overflows on mobile');
if (shots) await visitor.screenshot({ path: `${shots}/pi2-visitor-mobile.png`, fullPage: true });
step('signed-out visitor sees the public profile (phone layout)');

// import from a downloaded folder
await page.goto(`${BASE}/import`);
await page.getByRole('heading', { name: 'Import' }).waitFor();
await page.locator('input[type=file]').first().setInputFiles(exportDir);
await page.getByRole('heading', { name: 'Here is what will be created' }).waitFor();
await page.getByText('2 projects · 3 files').waitFor();
await page.getByText('1 file skipped').waitFor();
await page.getByRole('textbox', { name: 'Project name' }).last().fill('Tidal EP (demos)');
await shot('pi3-import-review');
await page.getByRole('button', { name: 'Import 2 projects' }).click();
await page.getByRole('heading', { name: 'Import finished' }).waitFor({ timeout: 120000 });
await page.getByText('3 of 3 files').waitFor();
step('folder import: 2 projects, versions grouped, notes.txt skipped, renamed before import');

await page.locator('#main').getByRole('link', { name: 'Night Sessions' }).click();
await page.locator('.track-title', { hasText: 'Glass Hours' }).waitFor();
await page.locator('.track', { hasText: 'Glass Hours' }).locator('.version-badge', { hasText: 'v2' }).waitFor();
step('imported track has both versions, newest current');

// import from a ZIP
await page.goto(`${BASE}/import`);
await page.locator('input[type=file]').last().setInputFiles(zipPath);
await page.getByText('1 project · 1 file').waitFor();
await page.getByRole('button', { name: 'Import 1 project' }).click();
await page.getByRole('heading', { name: 'Import finished' }).waitFor({ timeout: 60000 });
await page.getByRole('link', { name: 'Go to your library' }).click();
for (const n of ['Night Sessions', 'Tidal EP (demos)', 'Late Bloom']) await page.locator('#main').getByRole('link', { name: new RegExp(n.replace(/[()]/g, '\\$&')) }).waitFor();
step('ZIP import works; library shows all three projects');
await shot('pi4-library');

await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('ALL PASSED');
