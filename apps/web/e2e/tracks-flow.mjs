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

await page.locator('input[type=file][multiple]').setInputFiles([glass, undertow]);
await page.getByText('Glass Hours', { exact: true }).waitFor({ timeout: 60000 });
await page.getByText('Undertow', { exact: true }).waitFor({ timeout: 60000 });
await page.locator('.track', { hasText: 'Glass Hours' }).getByText('0:30').waitFor();
step('two WAV files uploaded; tracks listed with durations');
if (chunkBodies.length < 4) throw new Error(`expected ≥4 chunk uploads, saw ${chunkBodies.length}`);
for (const b of chunkBodies) if (!b || b.includes(Buffer.from('RIFF')) || b.includes(Buffer.from('WAVE'))) throw new Error('a chunk left the browser unencrypted');
step(`all ${chunkBodies.length} uploaded chunks were ciphertext (no WAV headers)`);
await shot('t1-tracks');

await page.reload(); // let the streaming service worker take control of the page
await page.locator('.track-title', { hasText: 'Glass Hours' }).waitFor();
if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) throw new Error('streaming service worker is not controlling the page');
const t0 = Date.now();
await page.locator('.track', { hasText: 'Glass Hours' }).locator('.track-main').click(); // the row itself plays
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.05, null, { timeout: 30000 });
const startMs = Date.now() - t0;
if (!(await page.evaluate(() => document.querySelector('audio').src.includes('/_stream/')))) throw new Error('playback did not use streaming');
if (startMs > 1500) throw new Error(`playback took ${startMs} ms to start`);
step(`clicking the row streams and starts sound in ${startMs} ms`);
await page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.5, null, { timeout: 30000 });
await page.locator('h1').click();
await page.keyboard.press(' ');
await page.waitForFunction(() => document.querySelector('audio').paused);
await page.keyboard.press(' ');
await page.waitForFunction(() => !document.querySelector('audio').paused);
step('Space pauses and resumes');
// playback is universal: it keeps going while exploring the rest of Arai
const tBefore = await page.evaluate(() => document.querySelector('audio').currentTime);
await page.locator('.sidebar').getByRole('link', { name: 'Settings' }).click();
await page.getByRole('heading', { name: 'Settings' }).waitFor();
await page.locator('.sidebar .user-chip').click();
await page.locator('#profile-name').waitFor();
await page.locator('.sidebar').getByRole('link', { name: 'Library' }).click();
await page.waitForFunction((t) => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > t + 0.3; }, tBefore, { timeout: 10000 });
await page.locator('.player').getByText('Glass Hours').waitFor();
step('music keeps playing across Settings, Profile and Library');
await page.goBack(); await page.goBack(); await page.goBack();
await page.locator('.track-title', { hasText: 'Glass Hours' }).waitFor();
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
await first.getByRole('button', { name: /Show versions/ }).click();
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), first.getByRole('button', { name: 'Upload new version' }).click()]);
await chooser.setFiles(glass2);
await first.getByRole('button', { name: 'Play version 2' }).waitFor({ timeout: 60000 });
await first.getByText('LUFS').first().waitFor();
await first.getByText('44.1 kHz').first().waitFor();
await first.getByText('16-bit').first().waitFor();
step('version insights show loudness, sample rate and bit depth');
await first.locator('.version-badge', { hasText: 'v2' }).waitFor();
step('new version uploaded and became current');
await first.getByRole('button', { name: /Make current/ }).click();
await first.locator('.version-badge', { hasText: 'v1' }).waitFor();
step('restored version 1 as current; version 2 kept in history');

// reorder: keyboard on the handle, then drag with the mouse; order survives reload
const order = async () => (await page.locator('.track-title').allTextContents()).join(' | ');
const before = await order();
await page.locator('.track', { hasText: 'Undertow' }).locator('.drag-handle').focus();
await page.keyboard.press(Number(before.indexOf('Undertow') > 0) ? 'ArrowUp' : 'ArrowDown');
await page.waitForFunction((b) => [...document.querySelectorAll('.track-title')].map((e) => e.textContent).join(' | ') !== b, before, { timeout: 5000 });
const afterKey = await order();
await page.waitForTimeout(400);
await page.reload();
await page.locator('.track-title').first().waitFor();
if ((await order()) !== afterKey) throw new Error('keyboard reorder did not persist');
await page.waitForTimeout(800); // let the rows finish their entrance animation
const h1 = page.locator('.track').nth(0).locator('.drag-handle');
const row2 = await page.locator('.track').nth(1).boundingBox();
const hb = await h1.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2, row2.y + row2.height * 0.9, { steps: 12 });
await page.mouse.up();
await page.waitForFunction((b) => [...document.querySelectorAll('.track-title')].map((e) => e.textContent).join(' | ') !== b, afterKey);
step('tracks reorder by keyboard and by dragging; order persists');

await page.getByRole('button', { name: 'Add tracks' }).click();
await page.getByRole('dialog', { name: 'Add tracks' }).getByText('Drop audio here').waitFor();
await page.locator('input[type=file][multiple]').setInputFiles(fake);
await page.getByText('not a supported audio format').waitFor();
await page.keyboard.press('Escape');
step('Add tracks overlay opens; a fake .wav (text) is rejected by content sniffing');

await first.getByRole('button', { name: 'More for Glass Hours' }).click();
const menuOnTop = await page.evaluate(() => { const m = document.querySelector('.menu-list button'); const r = m.getBoundingClientRect(); return document.elementFromPoint(r.left + 10, r.top + r.height / 2) === m; });
if (!menuOnTop) throw new Error('track menu is covered by other rows');
step('track menu opens on top of the rows below');
await page.getByRole('menuitem', { name: 'Delete track…' }).click();
await first.getByRole('button', { name: 'Delete', exact: true }).click();
await page.locator('.track-title', { hasText: 'Glass Hours' }).waitFor({ state: 'detached' });
step('track deleted');

await page.setViewportSize({ width: 375, height: 760 });
if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('horizontal overflow on mobile');
await shot('t3-mobile');
step('tracks and player fit a phone screen');

// Nothing in the page may end up hidden behind the fixed player / tab bar.
if (!(await page.locator('.player').count())) await page.locator('.track-row').first().click();
await page.locator('.player').waitFor();
const clearOfChrome = async () => {
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const bars = [...document.querySelectorAll('.player, .tabbar')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const top = Math.min(...bars.map((r) => r.top));
    let bottom = 0;
    for (const el of document.querySelectorAll('.content *')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden') bottom = Math.max(bottom, r.bottom);
    }
    return { top, bottom };
  });
};
for (const [w, h] of [[375, 760], [1280, 800]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const where of ['project', 'library']) {
    if (where === 'library') await page.getByRole('link', { name: 'Library' }).filter({ visible: true }).first().click();
    await page.locator('.content').waitFor();
    const { top, bottom } = await clearOfChrome();
    if (bottom > top + 0.5) throw new Error(`content hidden behind player at ${w}px on ${where}: ends ${bottom}, bar starts ${top}`);
    await shot(`t4-bottom-${where}-${w}`);
  }
  await page.goBack();
}
step('scrolled to the bottom, all content sits above the player (phone + desktop)');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
