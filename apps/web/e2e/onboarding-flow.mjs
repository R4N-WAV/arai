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
await page.getByRole('heading', { name: 'Welcome to அறை' }).waitFor();
if (page.viewportSize().width < (await page.evaluate(() => document.documentElement.scrollWidth))) throw new Error('horizontal overflow on the phone');
step('first-run guide shows on a new account (phone width, no overflow)');
await page.getByRole('button', { name: 'Got it' }).click();
await page.waitForTimeout(1500); // encrypted prefs save
await page.reload();
await page.getByRole('heading', { name: /Your space is quiet/ }).waitFor();
if (await page.getByRole('heading', { name: 'Welcome to அறை' }).count()) throw new Error('guide came back after dismissal');
step('dismissing the guide sticks (synced in encrypted preferences)');

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
