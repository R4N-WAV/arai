// End-to-end: invitations, roles, comments, removal + key rotation, share links,
// public listening and discovery. Run against `wrangler dev`.
// Usage: node apps/web/e2e/collab-flow.mjs [screenshotDir]
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
step('two accounts registered');

// Ana: project + track
await a.page.getByRole('link', { name: 'New project' }).click();
await a.page.getByRole('textbox', { name: 'Name' }).fill('Harbour');
await a.page.getByRole('button', { name: 'Create project' }).click();
await a.page.getByRole('heading', { name: 'Harbour' }).waitFor();
await a.page.locator('input[type=file][multiple]').setInputFiles([tone]);
await a.page.locator('.track-title', { hasText: 'Harbour Lights' }).waitFor({ timeout: 60000 });
const projectUrl = a.page.url();
step('Ana created “Harbour” with one track');

// Invite Ben as editor
await a.page.getByRole('button', { name: 'People' }).click();
await a.page.getByLabel('Invite by username').fill(B);
await a.page.getByLabel('Role').selectOption('editor');
await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
await a.page.getByText(`Invited @${B}`).waitFor();
await a.page.locator('.member', { hasText: B }).getByText('invited').waitFor();
await shot(a.page, 'c1-people');
await a.page.keyboard.press('Escape');
step('Ana invited Ben; he shows as invited');

// Ben: invitation in library (project name decrypts before accepting), accept, play
await b.page.reload();
await b.page.locator('.invite-row', { hasText: 'Harbour' }).waitFor();
await b.page.locator('.invite-row').getByText(`@${A} invited you as an editor`).waitFor();
await shot(b.page, 'c2-invite');
await b.page.getByRole('button', { name: 'Accept Harbour' }).click();
await b.page.locator('.sleeve', { hasText: 'Harbour' }).click();
await b.page.getByRole('heading', { name: 'Harbour' }).waitFor();
await b.page.locator('.track-title', { hasText: 'Harbour Lights' }).waitFor();
await b.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.track-main').click();
await b.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 1.2, null, { timeout: 30000 });
step('Ben saw the invitation (name decrypted), accepted, and plays the track');

// Ben comments at the current time
await b.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.version-badge').click();
await b.page.getByLabel('Add a comment').fill('Kick is too loud here');
await b.page.getByRole('button', { name: 'Comment', exact: true }).click();
await b.page.locator('.comment', { hasText: 'Kick is too loud here' }).locator('.time-chip').waitFor();
if ((await b.page.locator('.wave-marker').count()) !== 1) throw new Error('comment marker missing on the waveform');
step('Ben left a time-coded comment; a marker appears on the waveform');

// Ana sees it decrypted, replies, resolves
await a.page.reload();
await a.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.version-badge').click();
await a.page.locator('.comment', { hasText: 'Kick is too loud here' }).waitFor();
await a.page.getByRole('button', { name: 'Reply' }).click();
await a.page.getByLabel(`Reply to ${B}`).fill('Fixed in the next version');
await a.page.getByRole('button', { name: 'Reply', exact: true }).last().click();
await a.page.locator('.comment.reply', { hasText: 'Fixed in the next version' }).waitFor();
await a.page.getByRole('button', { name: 'Resolve' }).click();
await a.page.getByRole('button', { name: /Show 1 resolved/ }).waitFor();
await shot(a.page, 'c3-comments');
step('Ana read the comment, replied and resolved it');
const commentBodies = await a.page.evaluate(async () => (await fetch(location.pathname.replace('/projects/', '/api/projects/') + '/tracks').then((r) => r.json())).tracks[0].versions[0].id);
const raw = await a.page.evaluate(async (v) => (await fetch(`/api/versions/${v}/comments`).then((r) => r.text())), commentBodies);
if (raw.includes('Kick is too loud') || raw.includes('Fixed in the next')) throw new Error('comment text reached the server in plaintext');
step('the server only holds ciphertext for comments');

// Share link with password, opened by a stranger
await a.page.getByRole('button', { name: 'Share' }).click();
await a.page.getByLabel('Password (optional)').fill('opensesame');
await a.page.getByRole('button', { name: 'Create link' }).click();
const link = await a.page.getByLabel('Share link').inputValue();
if (!/\/s\/[a-z2-7]{26}#[A-Za-z0-9_-]{43}$/.test(link)) throw new Error(`unexpected link ${link}`);
await a.page.keyboard.press('Escape');
const g = await open('guest');
await g.page.goto(link);
await g.page.getByRole('heading', { name: 'Protected link' }).waitFor();
await g.page.getByLabel('Password').fill('wrong');
await g.page.getByRole('button', { name: 'Open' }).click();
await g.page.getByText('That password is not right.').waitFor();
await g.page.getByLabel('Password').fill('opensesame');
await g.page.getByRole('button', { name: 'Open' }).click();
await g.page.getByRole('heading', { name: 'Harbour' }).waitFor();
await g.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.track-main').click();
await g.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.5, null, { timeout: 30000 });
await g.page.getByLabel('Your name').fill('Sam');
await g.page.getByLabel('Add a comment').fill('Love the intro');
await g.page.getByRole('button', { name: 'Comment', exact: true }).click();
await g.page.locator('.comment', { hasText: 'Love the intro' }).waitFor();
await shot(g.page, 'c4-share');
step('a signed-out guest opened the password link, played the track and commented');
await a.page.reload();
await a.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.version-badge').click();
await a.page.locator('.comment', { hasText: 'Love the intro' }).getByText('guest').waitFor();
step('Ana sees the guest comment, decrypted with the link key');

// Remove Ben → key rotation; Ben loses access
await a.page.getByRole('button', { name: 'People' }).click();
await a.page.locator('.member', { hasText: B }).getByRole('button', { name: 'Remove' }).click();
await a.page.getByRole('button', { name: `Remove @${B}` }).click();
await a.page.getByText(/A new project key was made/).waitFor();
await a.page.keyboard.press('Escape');
const kv = await a.page.evaluate(async (u) => (await fetch(u.replace('/projects/', '/api/projects/')).then((r) => r.json())).project.keyVersion, projectUrl);
if (kv !== 2) throw new Error(`expected key version 2 after removal, got ${kv}`);
await b.page.reload();
await b.page.getByText('This project does not exist, or you no longer have access to it.').waitFor();
step('removing Ben rotated the project key (v2) and cut his access');
// Old content still opens for Ana after rotation; new uploads use the new key.
await a.page.reload();
await a.page.locator('.track-title', { hasText: 'Harbour Lights' }).waitFor();
await a.page.locator('input[type=file][multiple]').setInputFiles([wav('After Rotation.wav', 3, 392)]);
await a.page.locator('.track-title', { hasText: 'After Rotation' }).waitFor({ timeout: 60000 });
if ((await a.page.locator('.track-title', { hasText: 'Locked track' }).count()) > 0) throw new Error('a track became unreadable after rotation');
step('after rotation, old and new tracks both decrypt');
// The guest link keeps working and picks up the new track.
await g.page.reload();
await g.page.getByLabel('Password').fill('opensesame');
await g.page.getByRole('button', { name: 'Open' }).click();
await g.page.locator('.track-title', { hasText: 'After Rotation' }).waitFor({ timeout: 15000 });
step('the share link still works and now includes the new track');

// Public listening + discovery
await a.page.getByRole('button', { name: 'Edit details' }).click();
await a.page.getByRole('button', { name: 'Make public…' }).click();
await a.page.getByRole('button', { name: 'Make public', exact: true }).click();
await a.page.getByText(/The project is public now/).waitFor();
await a.page.keyboard.press('Escape');
const pid = new URL(projectUrl).pathname.split('/').pop();
const anon = await open('anon');
await anon.page.goto(`${BASE}/listen/${pid}`);
await anon.page.getByRole('heading', { name: 'Harbour' }).waitFor();
await anon.page.locator('.track', { hasText: 'Harbour Lights' }).locator('.track-main').click();
await anon.page.waitForFunction(() => (document.querySelector('audio')?.currentTime ?? 0) > 0.3, null, { timeout: 30000 });
await anon.page.goto(`${BASE}/u/${A}`);
await anon.page.locator('.sleeve', { hasText: 'Harbour' }).getByText('Listen').waitFor();
step('public project: anyone can listen from the profile');
await b.page.locator('.sidebar').getByRole('link', { name: 'Discover' }).click();
await b.page.getByLabel('Search public projects and people').fill('harb');
await b.page.locator('.sleeve', { hasText: A }).waitFor();
await b.page.getByLabel('Search public projects and people').fill(A);
await b.page.locator('.row', { hasText: `@${A}` }).waitFor();
step('discovery finds the public project and its owner');

// Social: Ben follows Ana; Ana sees it in Activity
await b.page.locator('.row', { hasText: `@${A}` }).getByRole('link').click();
await b.page.getByRole('button', { name: 'Follow' }).click();
await b.page.getByRole('button', { name: 'Following' }).waitFor();
await b.page.getByRole('button', { name: 'Add friend' }).click();
await b.page.getByRole('button', { name: 'Request sent' }).waitFor();
await a.page.goto(`${BASE}/activity`);
await a.page.getByText(`@${B} followed you`).waitFor();
await a.page.getByRole('button', { name: `Accept @${B}` }).click();
await a.page.locator('section[aria-labelledby="fl-h"]').getByRole('link', { name: B, exact: true }).waitFor();
await shot(a.page, 'c5-activity');
step('follow + friend request show up in Activity; accepting makes them friends');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
