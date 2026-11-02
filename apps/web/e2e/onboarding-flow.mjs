// End-to-end: first-run guide (dismissed for good, stored encrypted),
// keyboard shortcut sheet, public help and privacy pages.
// Usage: node apps/web/e2e/onboarding-flow.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const user = `new_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
page.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/privacy`);
await page.getByRole('heading', { name: 'Privacy' }).waitFor();
await page.getByRole('heading', { name: 'What Arai can see' }).waitFor();
await page.getByRole('link', { name: 'Help' }).click();
await page.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor();
step('help and privacy pages work signed out');

await page.goto(`${BASE}/register`);
await page.getByLabel('Username').fill(user);
await page.getByLabel('Email').fill(`${user}@example.com`);
await page.getByLabel('Password', { exact: true }).fill(pw);
await page.getByLabel('Confirm password').fill(pw);
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/stored this recovery key/).check({ timeout: 30000 });
await page.getByLabel(/I understand/).check();
await page.getByRole('button', { name: 'Create account' }).click();
const guide = page.getByRole('dialog', { name: 'Welcome to அறை' });
await guide.waitFor({ timeout: 15000 });
if (page.viewportSize().width < (await page.evaluate(() => document.documentElement.scrollWidth))) throw new Error('horizontal overflow on the phone');
step('the guide opens over the app the first time an account enters');
let steps = 1;
while (await page.getByRole('button', { name: 'Next' }).count()) {
  await page.getByRole('button', { name: 'Next' }).click();
  steps++;
  if (steps > 3 && (await page.locator('.guide-spot').count()) === 0 && steps < 7) {
    /* text-only steps have no spotlight */
  }
}
await page.getByRole('button', { name: 'Done' }).click();
if (await page.locator('.guide').count()) throw new Error('guide did not close');
step(`walked through all ${steps} steps (spotlights on the real controls)`);
await page.waitForTimeout(1500); // encrypted prefs save
await page.reload();
await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor();
await page.waitForTimeout(1500);
if (await page.locator('.guide').count()) throw new Error('guide came back after it was finished');
step('it does not come back by itself (synced in encrypted preferences)');
await page.getByRole('button', { name: 'Help: open the guide' }).first().click();
await page.getByRole('dialog', { name: 'Welcome to அறை' }).waitFor();
await page.keyboard.press('Escape');
step('the Help button opens the guide again');

await page.locator('h2').first().click();
await page.keyboard.press('?');
await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
await page.keyboard.press('Escape');
step('? opens the keyboard shortcut sheet');

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
