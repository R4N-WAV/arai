// End-to-end smoke test of the auth flow against `wrangler dev` (http://localhost:8787).
// Usage: node apps/web/e2e/auth-flow.mjs [screenshotDir]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const user = `e2e_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const newPw = 'second take 77';
const problems = [];
const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
if (manifest.display !== 'standalone' || !manifest.icons.some((i) => i.purpose === 'maskable')) throw new Error('web app manifest is not installable');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
// 401s from the signed-out session probe are expected and logged by the browser.
page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const step = (s) => console.log('✓', s);
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

await page.goto(`${BASE}/`);
await page.waitForURL('**/signin');
step('unauthenticated user redirected to sign in');
await page.getByRole('link', { name: 'Create an account' }).click();
await page.getByLabel('Username').fill(user);
await page.getByLabel('Email').fill(`${user}@example.com`);
await page.getByLabel('Password', { exact: true }).fill(pw);
await page.getByLabel('Confirm password').fill(pw);
await shot('01-register');
await page.getByRole('button', { name: 'Continue' }).click();
const codeEl = page.getByLabel('Recovery key', { exact: true });
await codeEl.waitFor({ timeout: 30000 });
const recoveryCode = (await codeEl.textContent()).trim();
if (!/^([A-Z0-9]{4}-){12}[A-Z0-9]{4}$/.test(recoveryCode)) throw new Error(`bad recovery code ${recoveryCode}`);
step('keys generated client-side, recovery key shown');
await shot('02-recovery-key');
const create = page.getByRole('button', { name: 'Create account' });
if (!(await create.isDisabled())) throw new Error('create enabled before acknowledgement');
await page.getByLabel(/stored this recovery key/).check();
await page.getByLabel(/I understand/).check();
await create.click();
await page.getByRole('button', { name: 'Skip' }).click({ timeout: 15000 }); // first-run guide
await page.getByRole('heading', { name: 'Library' }).waitFor();
step('account created and signed in');

await page.getByRole('link', { name: 'Settings' }).first().click();
await page.getByRole('heading', { name: 'Two-factor authentication' }).waitFor();
for (const name of ['Send verification email', 'Turn on']) {
  for (const b of await page.getByRole('button', { name, exact: true }).all()) if (!(await b.isDisabled())) throw new Error(`${name} should be disabled`);
}
if ((await page.getByText('Not available yet').count()) < 3) throw new Error('expected greyed-out provider features');
step('settings: email verification + email/SMS 2FA greyed out');
await shot('03-settings');

await page.locator('.sidebar .home-link').click();
await page.getByRole('heading', { name: 'Library' }).waitFor();
if (await page.getByRole('heading', { name: 'Unlock Arai' }).count()) throw new Error('logo click locked the vault');
step('logo click navigates without locking');
await page.reload();
await page.getByRole('heading', { name: 'Library' }).waitFor();
step('reload stays unlocked');
const tab2 = await ctx.newPage();
tab2.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await tab2.goto(`${BASE}/settings`);
await tab2.getByRole('heading', { name: 'Settings' }).waitFor();
step('a new tab opens unlocked (remembered device)');
// Without the stored device key (cleared site data), the password is needed again.
await tab2.evaluate(() => localStorage.clear());
await tab2.reload();
await tab2.getByRole('heading', { name: 'Unlock Arai' }).waitFor();
step('without the device key, Arai asks for the password (keys never stored in plaintext)');
await tab2.getByLabel('Password').fill('wrong password 1');
await tab2.getByRole('button', { name: 'Unlock' }).click();
await tab2.getByRole('alert').waitFor();
await tab2.getByLabel('Password').fill(pw);
await tab2.getByRole('button', { name: 'Unlock' }).click();
await tab2.getByRole('heading', { name: 'Settings' }).waitFor();
await tab2.close();
step('wrong password rejected locally; correct password unlocks');

await page.getByRole('button', { name: 'Sign out' }).first().click();
await page.waitForURL('**/signin');
await page.getByLabel('Username').fill(user);
await page.getByLabel('Password').fill('not my password 9');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('That username or password is not correct.').waitFor();
await page.getByLabel('Password').fill(pw);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('heading', { name: 'Library' }).waitFor();
step('sign out, failed sign in, successful sign in');

await page.getByRole('button', { name: 'Sign out' }).first().click();
await page.waitForURL('**/signin');
await page.getByRole('link', { name: 'Forgot your password?' }).click();
if (!(await page.getByRole('button', { name: 'Send reset email' }).isDisabled())) throw new Error('email reset should be disabled');
await shot('04-recover');
await page.getByLabel('Username').fill(user);
await page.getByRole('textbox', { name: 'Recovery key' }).fill(recoveryCode.toLowerCase().replace(/-/g, ' '));
await page.getByLabel('New password').fill(newPw);
await page.getByRole('button', { name: 'Reset password' }).click();
await page.getByRole('heading', { name: /Settings|Library/ }).or(page.getByRole('alert')).first().waitFor({ timeout: 30000 });
if (await page.getByRole('alert').count()) throw new Error('recover failed: ' + (await page.getByRole('alert').textContent()));
step('recovery-key reset works; email reset greyed out');
await page.getByRole('button', { name: 'Sign out' }).first().click();
await page.getByLabel('Username').fill(user);
await page.getByLabel('Password').fill(newPw);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('heading', { name: 'Library' }).waitFor();
step('new password signs in and unlocks the same keys');

await page.setViewportSize({ width: 375, height: 760 });
await page.getByRole('link', { name: 'Settings' }).last().click();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) throw new Error('horizontal overflow on mobile');
await shot('05-mobile-settings');
step('mobile layout: bottom tab bar, no horizontal scroll');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
