// End-to-end: sharing without reloads. A project created public is listenable straight away;
// invitations, new tracks and removals reach people who already have Arai open. Run against `wrangler dev`.
// Usage: node apps/web/e2e/live-sharing-flow.mjs [screenshotDir]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
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
const tone = wav('Harbour Lights.wav', 12, 262);

const stamp = Date.now().toString(36);
const A = `ana_${stamp}`;
const B = `ben_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const step = (s) => console.log('✓', s);

async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403|404|409)/.test(m.text()) && problems.push(`${name} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  return { ctx, page };
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
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 }); // first-run guide
  await page.getByRole('heading', { name: /Library|Your space is quiet/ }).first().waitFor();
}
const shot = async (page, name) => shots && (await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

const a = await open('ana');
const b = await open('ben');
await register(a.page, A);
await register(b.page, B);
step('two accounts registered; Ben leaves his library open');

// A project that is public from the start must be playable by anyone once it has a track.
await a.page.getByRole('link', { name: 'New project' }).click();
await a.page.getByRole('textbox', { name: 'Name' }).fill('Harbour');
await a.page.getByRole('radio', { name: /Public/ }).check();
await a.page.getByRole('button', { name: 'Create project' }).click();
await a.page.getByRole('heading', { name: 'Harbour' }).waitFor();
await a.page.locator('input[type=file][multiple]').setInputFiles([tone]);
await a.page.locator('.track-title', { hasText: 'Harbour Lights' }).waitFor({ timeout: 60000 });
const pid = a.page.url().split('/').pop();
const anon = await open('anon');
await expectListen(anon.page, 'Harbour Lights');
await anon.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.track-main').click();
await anon.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.5, null, { timeout: 30000 });
step('a project created as public can be played by anyone, without the owner toggling anything');

async function expectListen(page, title) {
  // The owner's browser publishes shortly after a change; poll like a visitor refreshing.
  for (let i = 0; i < 20; i++) {
    await page.goto(`${BASE}/listen/${pid}`);
    try {
      await page.locator('.track-title', { hasText: title }).waitFor({ timeout: 1500 });
      return;
    } catch {
      /* not published yet */
    }
  }
  throw new Error(`public page never showed “${title}”`);
}

// Invitation reaches Ben while his library is already open (no reload).
await a.page.getByRole('button', { name: 'People' }).click();
await a.page.getByLabel('Invite by username').fill(B);
await a.page.getByLabel('Role').selectOption('editor');
await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
await a.page.getByText(`Invited @${B}`).waitFor();
await b.page.locator('.invite-row', { hasText: 'Harbour' }).waitFor({ timeout: 15000 });
step('Ben saw the invitation appear without reloading');
await b.page.getByRole('button', { name: 'Accept Harbour' }).click();
await b.page.locator('.sleeve', { hasText: 'Harbour' }).click();
await b.page.locator('.track-title', { hasText: 'Harbour Lights' }).waitFor();
// Ana's open People dialog notices that Ben accepted.
await a.page.locator('.member', { hasText: B }).getByText('invited').waitFor({ state: 'detached', timeout: 15000 });
await a.page.keyboard.press('Escape');
step('Ben accepted; Ana’s People list updated by itself');

// A track Ana adds shows up for Ben, who has the project open.
await a.page.locator('input[type=file][multiple]').setInputFiles([wav('Second Wind.wav', 3, 392)]);
await a.page.locator('.track-title', { hasText: 'Second Wind' }).waitFor({ timeout: 60000 });
await b.page.locator('.track-title', { hasText: 'Second Wind' }).waitFor({ timeout: 15000 });
step('a new track appeared for the other member without reloading');
await expectListen(anon.page, 'Second Wind');
step('the public page picked up the new track');

// A track Ben (editor) adds reaches Ana and the public page too.
await b.page.locator('input[type=file][multiple]').setInputFiles([wav('Third Shore.wav', 3, 330)]);
await b.page.locator('.track-title', { hasText: 'Third Shore' }).waitFor({ timeout: 60000 });
await a.page.locator('.track-title', { hasText: 'Third Shore' }).waitFor({ timeout: 15000 });
await expectListen(anon.page, 'Third Shore');
step('an editor’s upload reached the owner and the public page');

// A rename changes no audio, so only the browser that made it can publish it.
await a.page.getByRole('button', { name: 'More for Second Wind' }).click();
await a.page.getByRole('menuitem', { name: 'Rename…' }).click();
await a.page.getByLabel('Title').fill('Second Breath');
await a.page.getByRole('button', { name: 'Save' }).click();
await b.page.locator('.track-title', { hasText: 'Second Breath' }).waitFor({ timeout: 15000 });
await expectListen(anon.page, 'Second Breath');
step('a rename reached the other member and the public page');

// Removing Ben takes the project away from his open tab.
await a.page.getByRole('button', { name: 'People' }).click();
await a.page.locator('.member', { hasText: B }).getByRole('button', { name: 'Remove' }).click();
await a.page.getByRole('button', { name: `Remove @${B}` }).click();
await a.page.getByText(/A new project key was made/).waitFor();
await b.page.getByText('This project does not exist, or you no longer have access to it.').waitFor({ timeout: 15000 });
step('removal reached Ben’s open tab');

await browser.close();
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
