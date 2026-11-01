// End-to-end: encrypted projects. Run against `wrangler dev` (http://localhost:8787).
// Usage: node apps/web/e2e/projects-flow.mjs [screenshotDir]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const shots = process.argv[2];
const user = `prj_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const secretName = `Midnight Tapes ${Date.now().toString(36)}`;
const problems = [];
const sent = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('request', (r) => r.url().includes('/api/') && r.postData() && sent.push(r.postData()));
const step = (s) => console.log('✓', s);
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

// sign up
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
step('empty library shows the quiet state with a New project action');

// create a private project
await page.getByRole('link', { name: 'New project' }).click();
await page.getByRole('textbox', { name: 'Name' }).fill(secretName);
await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Late-night demos, unreleased.');
await page.getByRole('textbox', { name: 'Genre', exact: true }).fill('ambient');
await page.getByRole('textbox', { name: 'Tags', exact: true }).fill('demo, night');
await page.getByLabel('Teal').check({ force: true });
await shot('p1-new-project');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: secretName }).waitFor();
step('private project created and opened');
const leaked = sent.filter((b) => b.includes(secretName) || b.includes('Late-night demos'));
if (leaked.length) throw new Error('private project name/description was sent to the server in plaintext');
step('name and description never left the browser unencrypted');
await page.locator('.content-back').click();
await page.getByRole('link', { name: 'New project' }).first().waitFor();
if (await page.locator('.content-back').count()) throw new Error('back button shown on a top-level page');
await page.goForward();
await page.getByRole('heading', { name: secretName }).waitFor();
step('back button returns to the library (and is hidden on top-level pages)');

// library lists it, survives a reload (decrypted again from ciphertext)
await page.locator('.sidebar').getByRole('link', { name: 'Library' }).click();
await page.locator('#main').getByRole('link', { name: new RegExp(secretName) }).waitFor();
await page.reload();
await page.locator('#main').getByRole('link', { name: new RegExp(secretName) }).waitFor();
await shot('p2-library');
step('library lists the project after reload (decrypted client-side)');

// edit
await page.locator('#main').getByRole('link', { name: new RegExp(secretName) }).click();
await page.getByRole('button', { name: 'Edit details' }).click();
const dlg = page.getByRole('dialog', { name: 'Edit details' });
await dlg.waitFor();
await dlg.getByRole('textbox', { name: 'Description', exact: true }).fill('Late-night demos, now with strings.');
await dlg.getByRole('button', { name: 'Save' }).click();
await dlg.waitFor({ state: 'hidden' });
await page.getByText('now with strings').waitFor();
step('details edited in the overlay and re-encrypted');
const actions = await page.locator('.project-actions button').allTextContents();
if (actions.join('|') !== 'Edit details') throw new Error(`unexpected project buttons: ${actions}`);
step('project page shows only Edit details (Add tracks appears once there are tracks)');

// make public, then private again (inside the overlay)
await page.getByRole('button', { name: 'Edit details' }).click();
await dlg.getByRole('button', { name: 'Make public…' }).click();
await dlg.getByRole('button', { name: 'Make public', exact: true }).click();
await page.locator('.project-meta', { hasText: 'public ·' }).waitFor();
if (!sent.some((b) => b.includes('"publicMeta"') && b.includes(secretName))) throw new Error('public details were not sent when publishing');
await dlg.getByRole('button', { name: 'Make private…' }).click();
await dlg.getByRole('button', { name: 'Make private', exact: true }).click();
await page.locator('.project-meta', { hasText: 'private ·' }).waitFor();
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'hidden' });
step('visibility switched public → private with confirmation; Esc closes the overlay');
await shot('p3-project');

// mobile
await page.setViewportSize({ width: 375, height: 760 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) throw new Error('horizontal overflow on mobile project page');
await page.setViewportSize({ width: 1280, height: 860 });
step('project page fits a phone screen');

// delete (requires typing the name)
await page.getByRole('button', { name: 'Edit details' }).click();
const del = dlg.getByRole('button', { name: 'Delete project' });
if (!(await del.isDisabled())) throw new Error('delete enabled before typing the name');
await dlg.getByLabel(/Type the project name/).fill(secretName);
await del.click();
await page.getByRole('heading', { name: 'Your space is quiet.' }).waitFor();
step('deleted after typing its name; library is empty again');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
