// End-to-end: authenticator-app sign-in (TOTP + recovery code) and project
// invite links for people without an account. Usage: node apps/web/e2e/security-invite-flow.mjs
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const stamp = Date.now().toString(36);
const A = `sec_${stamp}`, N = `newbie_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);

function fromBase32(s) {
  const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/\s/g, '')) {
    value = (value << 5) | A32.indexOf(ch);
    bits += 5;
    if (bits >= 8) (out.push((value >>> (bits - 8)) & 255), (bits -= 8));
  }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const step = Math.floor(Date.now() / 30000) + offset;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(step, 4);
  const h = createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[19] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

const browser = await chromium.launch();
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|404|409)/.test(m.text()) && problems.push(`${name} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  return page;
}
async function fillRegister(page, user) {
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Email').fill(`${user}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(pw);
  await page.getByLabel('Confirm password').fill(pw);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
  await page.getByLabel(/I understand/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

const a = await open('owner');
await a.goto(`${BASE}/register`);
await fillRegister(a, A);
await a.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 });

// --- authenticator app ---
await a.goto(`${BASE}/settings`);
await a.locator('.totp').getByRole('button', { name: 'Set up' }).click();
await a.locator('.totp').getByLabel('Password').fill(pw);
await a.locator('.totp').getByRole('button', { name: 'Continue' }).click();
const secret = (await a.getByLabel('Setup key').textContent()).replace(/\s/g, '');
await a.locator('.totp-qr').waitFor();
await a.getByLabel('Code from the app').fill(totp(secret));
await a.locator('.totp').getByRole('button', { name: 'Turn on' }).click();
await a.locator('.recovery-codes li').first().waitFor({ timeout: 15000 });
const codes = await a.locator('.recovery-codes li').allTextContents();
if (codes.length !== 10) throw new Error('expected 10 recovery codes');
await a.getByRole('button', { name: 'I saved them' }).click();
await a.locator('.totp').getByText('On', { exact: true }).waitFor();
step('authenticator app set up from a QR code; 10 recovery codes shown once');

await a.getByRole('button', { name: 'Sign out' }).first().click();
await a.getByLabel('Username').fill(A);
await a.getByLabel('Password').fill(pw);
await a.getByRole('button', { name: 'Sign in' }).click();
await a.getByLabel('Code from your authenticator app').fill('000000');
await a.getByRole('button', { name: 'Sign in' }).click();
await a.getByText('That code is not right').waitFor();
await a.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
await a.getByRole('button', { name: 'Sign in' }).click();
await a.getByRole('heading', { name: /Your space is quiet|Library/ }).first().waitFor({ timeout: 20000 });
step('sign-in asks for the code; a wrong code is refused; the right one gets in');
await a.getByRole('button', { name: 'Sign out' }).first().click();
await a.getByLabel('Username').fill(A);
await a.getByLabel('Password').fill(pw);
await a.getByRole('button', { name: 'Sign in' }).click();
await a.getByRole('button', { name: 'Use a recovery code instead' }).click();
await a.getByLabel('Recovery code').fill(codes[0]);
await a.getByRole('button', { name: 'Sign in' }).click();
await a.getByRole('heading', { name: /Your space is quiet|Library/ }).first().waitFor({ timeout: 20000 });
step('a recovery code works instead of the phone');

// --- invite link for someone without an account ---
await a.getByRole('link', { name: 'New project' }).first().click();
await a.getByRole('textbox', { name: 'Name' }).fill('Open Door');
await a.getByRole('button', { name: 'Create project' }).click();
await a.getByRole('heading', { name: 'Open Door' }).waitFor();
await a.getByRole('button', { name: 'People' }).click();
await a.getByRole('button', { name: 'Invite link…' }).click();
await a.getByLabel('Role', { exact: true }).last().selectOption('editor');
await a.getByRole('button', { name: 'Create link' }).click();
const link = await a.getByRole('textbox', { name: 'Invite link' }).inputValue();
if (!/\/join\/[a-z2-7]{26}#[A-Za-z0-9_-]{43}$/.test(link)) throw new Error(`unexpected invite link ${link}`);
step('invite link created (project key in the # part)');

const n = await open('newcomer');
await n.goto(link);
await n.getByRole('link', { name: 'Create an account' }).click();
await fillRegister(n, N);
await n.getByText('You are invited to “Open Door” as an editor.').waitFor({ timeout: 20000 });
await n.getByRole('button', { name: 'Join project' }).click();
await n.getByRole('heading', { name: 'Open Door' }).waitFor({ timeout: 20000 });
await n.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 }).catch(() => undefined);
step('a newcomer signed up from the link, came straight back, joined and opened the encrypted project');
const second = await open('third');
await second.goto(link);
await second.getByRole('link', { name: 'Create an account' }).click();
await fillRegister(second, `third_${stamp}`);
await second.getByText(/expired, was used up, or was turned off/).waitFor({ timeout: 20000 });
step('a one-person link cannot be used twice');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
