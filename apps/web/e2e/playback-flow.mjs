// End-to-end: gapless handoff between tracks (measured) and independent pitch
// shift (speed unchanged). Usage: node apps/web/e2e/playback-flow.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
function wav(name, seconds, freq) {
  const rate = 44100, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}
const user = `gap_${Date.now().toString(36)}`;
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
await page.getByRole('textbox', { name: 'Name' }).fill('Seamless');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Seamless' }).waitFor();
await page.locator('input[type=file][multiple]').setInputFiles([wav('Part One.wav', 5, 220), wav('Part Two.wav', 5, 330)]);
await page.locator('.track-title', { hasText: 'Part Two' }).waitFor({ timeout: 60000 });
await page.reload(); // service worker controls the page → streaming
await page.locator('.track-title', { hasText: 'Part One' }).waitFor();

// Record when each element stops/starts making sound.
await page.evaluate(() => {
  window.__log = [];
  [...document.querySelectorAll('audio')].forEach((a, i) => {
    a.addEventListener('playing', () => window.__log.push(['playing', performance.now(), i]));
    a.addEventListener('pause', () => window.__log.push(['pause', performance.now(), a.currentTime, a.duration, i]));
    a.addEventListener('ended', () => window.__log.push(['ended', performance.now(), i]));
  });
});
// Both files upload at once, so either may come first: play the first row, expect the second next.
const [firstTitle, secondTitle] = await page.locator('.track-title').allTextContents();
await page.locator('.track').first().locator('.track-main').click();
await page.locator('.player').getByText(secondTitle).waitFor({ timeout: 20000 });
void firstTitle;
await page.waitForTimeout(500);
const log = await page.evaluate(() => window.__log);
const plays = log.filter((e) => e[0] === 'playing');
if (plays.length < 2 || plays[1][2] === plays[0][2] || log.some((e) => e[0] === 'ended')) throw new Error(`no preloaded handoff: ${JSON.stringify(log)}`);
// Track one is 5.000 s long: the second element should take over right at its end.
const offsetMs = Math.round(plays[1][1] - plays[0][1] - 5000);
if (Math.abs(offsetMs) > 120) throw new Error(`switch landed ${offsetMs} ms from the end of track one`);
step(`next track took over on the preloaded element ${offsetMs >= 0 ? '+' : ''}${offsetMs} ms from the end of the first (no load gap)`);

// Pitch: transpose +3 semitones, speed stays 1×.
await page.locator('.player').getByLabel('Pitch in semitones').selectOption('3');
const t1 = await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused)?.currentTime ?? 0);
await page.waitForTimeout(1000);
const t2 = await page.evaluate(() => [...document.querySelectorAll('audio')].find((a) => !a.paused)?.currentTime ?? 0);
const advanced = t2 - t1;
if (advanced < 0.8 || advanced > 1.2) throw new Error(`speed changed with pitch (advanced ${advanced.toFixed(2)} s in 1 s)`);
if ((await page.locator('.player').getByLabel('Pitch in semitones').inputValue()) !== '3') throw new Error('pitch setting reverted (worklet failed)');
step(`pitch +3 semitones applied through the worklet; playback speed unchanged (${advanced.toFixed(2)} s per s)`);

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
