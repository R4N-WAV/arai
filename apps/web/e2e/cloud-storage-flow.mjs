// End-to-end: bring-your-own storage with Dropbox, against a local mock.
// The browser's calls to the Dropbox API are intercepted (as Dropbox would
// answer them) and the uploaded bytes are served by a tiny range-capable
// server that stands in for dl.dropboxusercontent.com (apps/api/.dev.vars:
// DROPBOX_APP_KEY=e2e-test-app, DROPBOX_DL_ORIGIN=http://127.0.0.1:8790).
// Usage: node apps/web/e2e/cloud-storage-flow.mjs
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const dir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'arai-e2e-'));
function wav(name, seconds) {
  const rate = 44100, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 247 * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const p = join(dir, name);
  writeFileSync(p, Buffer.concat([h, data]));
  return p;
}

// --- the mock "Dropbox": sessions, files, share links, ranged downloads ---
const sessions = new Map();
const files = new Map(); // path -> Buffer
const links = new Map(); // share id -> path
const server = createServer((req, res) => {
  const id = req.url.split('/')[3];
  const path = links.get(id);
  const buf = path && files.get(path);
  if (!buf) return res.writeHead(404).end();
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
  if (!m) return res.writeHead(200, { 'Content-Length': buf.length }).end(buf);
  const s = Number(m[1]), e = Math.min(Number(m[2]), buf.length - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1 }).end(buf.subarray(s, e + 1));
});
await new Promise((r) => server.listen(8790, '127.0.0.1', r));

const stamp = Date.now().toString(36);
const A = `cloud_${stamp}`, B = `cfriend_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && problems.push(`${name} console: ${m.text()}`));
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
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 });
}

const a = await open('owner');
const sentToDropbox = [];
// Dropbox, as seen from the browser.
await a.ctx.route('https://www.dropbox.com/oauth2/authorize**', (route) => {
  const u = new URL(route.request().url());
  route.fulfill({ status: 302, headers: { Location: `${u.searchParams.get('redirect_uri')}?code=e2e-code&state=${u.searchParams.get('state')}` } });
});
await a.ctx.route('https://api.dropboxapi.com/**', async (route) => {
  const url = route.request().url();
  const body = route.request().postData() ?? '';
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.endsWith('/oauth2/token')) return route.fulfill({ headers: cors, json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 14400 } });
  if (url.endsWith('/sharing/create_shared_link_with_settings')) {
    const { path } = JSON.parse(body);
    const id = `e2e${Math.random().toString(36).slice(2, 12)}`;
    links.set(id, path);
    return route.fulfill({ headers: cors, json: { url: `https://www.dropbox.com/scl/fi/${id}/${encodeURIComponent(path.split('/').pop())}?rlkey=abcdefgh1234&dl=0` } });
  }
  if (url.endsWith('/files/delete_v2')) {
    files.delete(JSON.parse(body).path);
    return route.fulfill({ headers: cors, json: {} });
  }
  route.fulfill({ status: 400, headers: cors, body: '' });
});
await a.ctx.route('https://content.dropboxapi.com/**', async (route) => {
  const req = route.request();
  const arg = JSON.parse(req.headers()['dropbox-api-arg'] ?? '{}');
  const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
  sentToDropbox.push(bytes);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.url().endsWith('/start')) {
    const sid = `s${sessions.size}`;
    sessions.set(sid, [bytes]);
    return route.fulfill({ headers: cors, json: { session_id: sid } });
  }
  if (req.url().endsWith('/append_v2')) {
    sessions.get(arg.cursor.session_id).push(bytes);
    return route.fulfill({ headers: cors, json: {} });
  }
  if (req.url().endsWith('/finish')) {
    files.set(arg.commit.path, Buffer.concat([...sessions.get(arg.cursor.session_id), bytes]));
    return route.fulfill({ headers: cors, json: { path_display: arg.commit.path } });
  }
  route.fulfill({ status: 400, headers: cors, body: '' });
});

await register(a.page, A);
await a.page.goto(`${BASE}/settings`);
await a.page.locator('.row', { hasText: 'Dropbox' }).getByRole('button', { name: 'Connect' }).click();
await a.page.getByText('Dropbox is connected.').waitFor({ timeout: 20000 });
if ((await a.page.getByLabel('My Dropbox').isChecked()) !== true) throw new Error('new uploads should go to Dropbox after connecting');
step('connected Dropbox (PKCE; token stored encrypted with a key from the account key)');
const stored = await a.page.evaluate(() => fetch('/api/account/storage-accounts').then((r) => r.text()));
if (stored.includes('rt-1') || stored.includes('at-1')) throw new Error('cloud tokens reached Arai in the clear');
step('Arai only holds the cloud token encrypted');

await a.page.goto(`${BASE}/projects/new`);
await a.page.getByRole('textbox', { name: 'Name' }).fill('In My Cloud');
await a.page.getByRole('button', { name: 'Create project' }).click();
await a.page.getByRole('heading', { name: 'In My Cloud' }).waitFor();
const wavPath = wav('Cloud Song.wav', 14); // ~1.2 MB → 2 chunks
await a.page.locator('input[type=file][multiple]').setInputFiles([wavPath]);
await a.page.locator('.track-title', { hasText: 'Cloud Song' }).waitFor({ timeout: 60000 });
const [path, buf] = [...files.entries()][0] ?? [];
if (!path?.startsWith('/Arai (encrypted)/')) throw new Error(`unexpected Dropbox path ${path}`);
if (sentToDropbox.some((b) => b.includes(Buffer.from('RIFF')) || b.includes(Buffer.from('WAVE')))) throw new Error('audio reached Dropbox unencrypted');
const used = await a.page.evaluate(() => fetch('/api/account/storage').then((r) => r.json()).then((j) => j.used));
if (used !== 0) throw new Error(`Dropbox upload counted toward the Arai quota (${used})`);
step(`uploaded as one encrypted file to Dropbox:${path} (${buf.length} bytes, no WAV header, Arai quota untouched)`);

// The owner plays it; a collaborator (no Dropbox at all) plays it too, through Arai.
await a.page.locator('.track', { hasText: 'Cloud Song' }).locator('.track-main').click();
await a.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.3, null, { timeout: 20000 });
const b = await open('friend');
await register(b.page, B);
await a.page.getByRole('button', { name: 'People' }).click();
await a.page.getByLabel('Invite by username').fill(B);
await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
await a.page.getByText(`Invited @${B}`).waitFor();
await a.page.keyboard.press('Escape');
await b.page.reload();
await b.page.getByRole('button', { name: 'Accept In My Cloud' }).click();
await b.page.locator('.sleeve', { hasText: 'In My Cloud' }).click();
await b.page.locator('.track', { hasText: 'Cloud Song' }).locator('.track-main').click();
await b.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.3, null, { timeout: 20000 });
step('owner and a collaborator without Dropbox both play it (Arai relays the encrypted ranges)');

// Deleting the track removes it from the owner's Dropbox too.
const row = a.page.locator('.track', { hasText: 'Cloud Song' });
await row.getByRole('button', { name: 'More for Cloud Song' }).click();
await a.page.getByRole('menuitem', { name: 'Delete track…' }).click();
await row.getByRole('button', { name: 'Delete', exact: true }).click();
await a.page.locator('.track-title', { hasText: 'Cloud Song' }).waitFor({ state: 'detached' });
await a.page.waitForTimeout(1000);
if (files.size !== 0) throw new Error('the Dropbox copy was not removed');
step('deleting the track also deleted the file from Dropbox');

await browser.close();
server.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
