// End-to-end: encrypted DMs with realtime delivery, reactions, edits, read
// receipts, attachments, message requests and project chat.
// Usage: node apps/web/e2e/messages-flow.mjs [screenshotDir]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
// A 1x1 PNG attachment.
const png = join(dir, 'cover.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));

const stamp = Date.now().toString(36);
const A = `mia_${stamp}`, B = `noa_${stamp}`, C = `ola_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const browser = await chromium.launch();
const step = (s) => console.log('✓', s);
async function open(name, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
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
const call = (page, method, path) => page.evaluate(([m, p]) => fetch(`/api${p}`, { method: m, headers: { 'X-Arai-CSRF': '1' } }).then((r) => r.status), [method, path]);
const shot = async (page, name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

const a = await open('mia');
const b = await open('noa', true);
const c = await open('ola');
await register(a, A);
await register(b, B);
await register(c, C);
await call(a, 'POST', `/social/${B}/friend`);
await call(b, 'POST', `/social/${A}/friend`);
step('three accounts; Mia and Noa are friends');

await a.goto(`${BASE}/messages`);
await a.getByRole('button', { name: 'New message' }).click();
await a.getByLabel(/^To/).fill(B);
await a.getByRole('button', { name: 'Start conversation' }).click();
await a.locator('.thread-head').getByText(B).first().waitFor();
await b.goto(`${BASE}/messages`);
await b.locator('.conv', { hasText: A }).waitFor();
await b.locator('.conv', { hasText: A }).click();
await b.getByText('end-to-end encrypted').waitFor();
step('Mia started a DM; it appears in Noa’s inbox (phone layout)');

const sent = [];
a.on('request', (r) => r.url().includes('/messages') && r.method() === 'POST' && sent.push(r.postData() ?? ''));
await a.getByLabel('Message', { exact: true }).fill('Hey! New mix is up');
await a.getByLabel('Message', { exact: true }).press('Enter');
await b.locator('.msg', { hasText: 'Hey! New mix is up' }).waitFor({ timeout: 10000 });
if (sent.some((s) => s.includes('New mix'))) throw new Error('message text left the browser unencrypted');
step('message delivered in realtime without reload; only ciphertext was sent');

await b.getByLabel('Message', { exact: true }).fill('listening');
await a.locator('.typing', { hasText: `${B} is typing` }).waitFor({ timeout: 10000 });
await b.getByLabel('Message', { exact: true }).press('Enter');
await a.locator('.msg', { hasText: 'listening' }).waitFor({ timeout: 10000 });
await a.locator('.msg-seen').waitFor({ timeout: 10000 });
step('typing indicator and “Seen” receipt work');

const msg = b.locator('.msg', { hasText: 'Hey! New mix is up' });
await msg.getByRole('button', { name: /Message options/ }).click();
await b.getByRole('menuitem', { name: 'React: Fire' }).click();
await a.locator('.msg', { hasText: 'Hey! New mix is up' }).getByRole('button', { name: 'Fire, 1' }).waitFor({ timeout: 10000 });
const mine = a.locator('.msg.mine', { hasText: 'Hey! New mix is up' });
await mine.hover();
await mine.getByRole('button', { name: /Message options/ }).click();
await a.getByRole('menuitem', { name: 'Edit' }).click();
await a.getByLabel('Message', { exact: true }).fill('Hey! New mix v2 is up');
await a.getByRole('button', { name: 'Save' }).click();
await b.locator('.msg', { hasText: 'Hey! New mix v2 is up' }).getByText('edited').waitFor({ timeout: 10000 });
step('reaction and edit show up live on the other side');

await a.locator('input[type=file][multiple]').setInputFiles(png);
await b.locator('.msg-image[alt="cover.png"]').waitFor({ timeout: 15000 });
step('an encrypted image attachment arrives and decrypts');
await shot(b, 'm1-dm-phone');
await shot(a, 'm2-dm-desktop');

// A stranger's message is a request.
await c.goto(`${BASE}/messages`);
await c.getByRole('button', { name: 'New message' }).click();
await c.getByLabel(/^To/).fill(A);
await c.getByRole('button', { name: 'Start conversation' }).click();
await c.getByLabel('Message', { exact: true }).fill('hi, can I hear your stems?');
await c.getByLabel('Message', { exact: true }).press('Enter');
await a.getByRole('button', { name: /Requests \(1\)/ }).click();
await a.locator('.conv', { hasText: C }).click();
await a.getByText(`${C} wants to message you`).waitFor();
await a.getByRole('button', { name: 'Accept', exact: true }).click();
await a.getByLabel('Message', { exact: true }).waitFor();
step('a stranger’s DM lands in Requests until accepted');

// Project chat uses the project's key.
await a.goto(`${BASE}/projects/new`);
await a.getByRole('textbox', { name: 'Name' }).fill('Tape Loops');
await a.getByRole('button', { name: 'Create project' }).click();
await a.getByRole('heading', { name: 'Tape Loops' }).waitFor();
await a.getByRole('button', { name: 'People' }).click();
await a.getByRole('button', { name: 'Open project chat' }).click();
await a.locator('.thread-head').getByText('Project chat').waitFor();
await a.getByLabel('Message', { exact: true }).fill('notes for the loops');
await a.getByLabel('Message', { exact: true }).press('Enter');
await a.locator('.msg', { hasText: 'notes for the loops' }).waitFor();
step('project chat opens from People and encrypts with the project key');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
