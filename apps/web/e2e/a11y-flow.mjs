// Accessibility: axe-core (WCAG 2.0/2.1/2.2 A + AA) on the main screens at
// 360, 768 and 1280 px. Fails on any serious or critical violation.
// Usage: node apps/web/e2e/a11y-flow.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const axe = readFileSync(join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const user = `a11y_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const failures = [];

const browser = await chromium.launch();
// CSP blocks injected scripts (as it should); the audit context bypasses it to load axe.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, bypassCSP: true });
const page = await ctx.newPage();

async function check(name) {
  await page.waitForTimeout(700); // let entrance animations settle (contrast is measured on final colours)
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(async () =>
    // eslint-disable-next-line no-undef
    (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
  );
  const w = page.viewportSize().width;
  for (const v of result) failures.push(`${name} @${w}px — ${v}`);
  console.log(`${result.length ? '✗' : '✓'} ${name} @${w}px${result.length ? ` (${result.length})` : ''}`);
}

async function each(name, go) {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 860 });
    await go();
    await check(name);
  }
}

await each('sign in', async () => { await page.goto(`${BASE}/signin`); await page.getByRole('heading', { name: /Sign in/ }).first().waitFor(); });
await each('register', async () => { await page.goto(`${BASE}/register`); await page.getByLabel('Username').waitFor(); });
await each('privacy', async () => { await page.goto(`${BASE}/privacy`); await page.getByRole('heading', { name: 'Privacy' }).waitFor(); });
await each('help', async () => { await page.goto(`${BASE}/help`); await page.getByRole('heading', { name: 'Help' }).waitFor(); });

await page.goto(`${BASE}/register`);
await page.getByLabel('Username').fill(user);
await page.getByLabel('Email').fill(`${user}@example.com`);
await page.getByLabel('Password', { exact: true }).fill(pw);
await page.getByLabel('Confirm password').fill(pw);
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
await check('recovery key step');
await page.getByLabel(/I understand/).check();
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByRole('dialog', { name: 'Welcome to அறை' }).waitFor({ timeout: 15000 });
await check('first-run guide');
await page.getByRole('button', { name: 'Next' }).click();
await check('guide spotlight step');
await page.getByRole('button', { name: 'Skip' }).click();
await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor();

await each('library (empty)', async () => { await page.goto(`${BASE}/`); await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor(); });
await each('new project', async () => { await page.goto(`${BASE}/projects/new`); await page.getByRole('textbox', { name: 'Name' }).waitFor(); });
await page.getByRole('textbox', { name: 'Name' }).fill('Contrast Check');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Contrast Check' }).waitFor();
const projectUrl = page.url();
await each('project', async () => { await page.goto(projectUrl); await page.getByRole('heading', { name: 'Contrast Check' }).waitFor(); });
await each('library', async () => { await page.goto(`${BASE}/`); await page.getByRole('heading', { name: 'Library' }).waitFor(); });
await each('settings', async () => { await page.goto(`${BASE}/settings`); await page.getByRole('heading', { name: 'Settings' }).waitFor(); });
await each('discover', async () => { await page.goto(`${BASE}/discover`); await page.getByRole('heading', { name: 'Discover' }).waitFor(); });
await each('activity', async () => { await page.goto(`${BASE}/activity`); await page.getByRole('heading', { name: 'Activity' }).waitFor(); });
await each('messages', async () => { await page.goto(`${BASE}/messages`); await page.getByRole('heading', { name: 'Messages' }).waitFor(); });
await each('profile', async () => { await page.goto(`${BASE}/u/${user}`); await page.locator('#profile-name').waitFor(); });

// Overlays
await page.setViewportSize({ width: 1280, height: 860 });
await page.goto(projectUrl);
await page.getByRole('button', { name: 'People' }).click();
await page.getByRole('dialog').waitFor();
await check('people dialog');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Edit details' }).click();
await page.getByRole('dialog').waitFor();
await check('edit details dialog');

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} serious/critical violation(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('ALL PASSED');
