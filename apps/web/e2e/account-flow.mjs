// End-to-end: change password (content stays readable), change username,
// download my data (decrypted JSON), delete account.
// Usage: node apps/web/e2e/account-flow.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const stamp = Date.now().toString(36);
let user = `acc_${stamp}`;
const pw = 'studio take 42';
const pw2 = 'a brand new passphrase';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })).newPage();
page.on('console', (m) => m.type() === 'error' && !/status of (401|404|409)/.test(m.text()) && problems.push(`console: ${m.text()}`));
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
await page.getByRole('link', { name: 'New project' }).click();
await page.getByRole('textbox', { name: 'Name' }).fill('Secret Sketches');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Secret Sketches' }).waitFor();

await page.goto(`${BASE}/settings`);
await page.getByRole('button', { name: 'Change password' }).click();
await page.getByLabel('Current password').fill('wrong password here');
await page.getByLabel('New password', { exact: true }).fill(pw2);
await page.getByLabel('Repeat new password').fill(pw2);
await page.locator('form').getByRole('button', { name: 'Change password' }).click();
await page.getByText('That is not your current password.').waitFor({ timeout: 20000 });
await page.getByLabel('Current password').fill(pw);
await page.locator('form').getByRole('button', { name: 'Change password' }).click();
await page.getByText('Password changed.').waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Sign out' }).first().click();
await page.getByLabel('Username').fill(user);
await page.getByLabel('Password').fill(pw);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('alert').waitFor();
await page.getByLabel('Password').fill(pw2);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.locator('.sleeve', { hasText: 'Secret Sketches' }).waitFor({ timeout: 30000 });
step('password changed; old one refused; new one opens the same encrypted project');

await page.goto(`${BASE}/settings`);
await page.getByRole('button', { name: 'Change username' }).click();
user = `acc2_${stamp}`;
await page.getByLabel('New username').fill(user);
await page.getByLabel('Password', { exact: true }).fill(pw2);
await page.locator('form').getByRole('button', { name: 'Change username' }).click();
await page.getByText('Username changed.').waitFor();
await page.getByText(`for ${user}`).waitFor();
step('username changed');

await page.getByRole('button', { name: 'Download my data' }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Prepare download' }).click()]);
const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
if (data.format !== 'arai-export/1' || !data.projects.some((p) => p.meta?.name === 'Secret Sketches')) throw new Error('export is missing the decrypted project');
step('data export contains the decrypted project');

await page.getByRole('button', { name: 'Delete account…' }).click();
await page.getByLabel(/Type “delete my account”/).fill('delete my account');
await page.getByLabel('Password', { exact: true }).fill(pw2);
await page.getByRole('button', { name: 'Delete my account' }).click();
await page.getByRole('heading', { name: /Sign in/ }).first().waitFor({ timeout: 20000 });
await page.getByLabel('Username').fill(user);
await page.getByLabel('Password').fill(pw2);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('alert').waitFor();
step('account deleted; signing in no longer works');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
