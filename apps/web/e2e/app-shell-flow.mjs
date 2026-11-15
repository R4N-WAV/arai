// End-to-end: Arai installed on a phone (home-screen app). The page is a fixed frame: only the content
// pane scrolls, the bars never move. Messages open their menu on press-and-hold. Uploads keep their order.
// Usage: node apps/web/e2e/app-shell-flow.mjs [screenshotDir]
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

const user = `app_${Date.now().toString(36)}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
// What iOS reports for a page opened from the home screen.
await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
page.on('console', (m) => m.type() === 'error' && !/status of (401|403|404|409)/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

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
if (!(await page.evaluate(() => document.documentElement.classList.contains('standalone')))) throw new Error('the installed-app frame was not applied');

// Several files chosen together keep the order they were chosen in, whichever finishes uploading first.
await page.getByRole('link', { name: 'New project' }).first().click();
await page.getByRole('textbox', { name: 'Name' }).fill('Night Bus');
await page.getByRole('button', { name: 'Create project' }).click();
await page.getByRole('heading', { name: 'Night Bus' }).waitFor();
const names = ['01 Long Opening', '02 Short', '03 Middle', '04 Closer', '05 Coda', '06 Reprise'];
await page.locator('input[type=file][multiple]').setInputFiles(names.map((n, i) => wav(`${n}.wav`, [9, 1, 4, 2, 6, 3][i], 220 + i * 40)));
await page.locator('.track-title', { hasText: '06 Reprise' }).waitFor({ timeout: 90000 });
await page.waitForFunction((n) => document.querySelectorAll('.track-title').length === n, names.length, { timeout: 30000 });
const order = await page.locator('.track-title').allTextContents();
if (order.join('|') !== names.join('|')) throw new Error(`tracks out of order: ${order.join(', ')}`);
step('six files dropped together became six tracks in the order they were chosen');
await page.locator('.upload').first().waitFor({ state: 'detached', timeout: 10000 });
step('finished upload rows clear themselves');

// The frame: the page cannot scroll; the content pane does; the bars stay put.
const frame = async () =>
  page.evaluate(() => {
    const bar = document.querySelector('.mobile-bar').getBoundingClientRect();
    const tabs = document.querySelector('.tabbar').getBoundingClientRect();
    const pane = document.querySelector('.content');
    return { pageScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1, scrollY: window.scrollY, barTop: bar.top, tabsBottom: tabs.bottom, paneScroll: pane.scrollTop, paneMax: pane.scrollHeight - pane.clientHeight, h: window.innerHeight };
  });
let f = await frame();
if (f.pageScrollable || f.scrollY !== 0) throw new Error(`the page itself can scroll: ${JSON.stringify(f)}`);
if (f.paneMax < 50) throw new Error(`expected the content pane to have something to scroll: ${JSON.stringify(f)}`);
await page.mouse.move(196, 500);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(300);
await page.evaluate(() => window.scrollTo(0, 400));
f = await frame();
if (f.scrollY !== 0 || f.barTop !== 0 || Math.abs(f.tabsBottom - f.h) > 1) throw new Error(`bars moved: ${JSON.stringify(f)}`);
if (f.paneScroll < 50) throw new Error(`the content pane did not scroll: ${JSON.stringify(f)}`);
const last = await page.locator('.track').last().boundingBox();
await page.evaluate(() => document.querySelector('.content').scrollTo(0, 1e6));
await page.waitForTimeout(200);
const tabsTop = await page.evaluate(() => document.querySelector('.tabbar').getBoundingClientRect().top);
const lastNow = await page.locator('.track').last().boundingBox();
if (!last || !lastNow || lastNow.y + lastNow.height > tabsTop) throw new Error('the last track is hidden behind the tab bar at the end of the list');
await shot('app1-project');
step('only the content pane scrolls; top bar and tab bar never move; the list ends clear of the tab bar');

if ((await page.locator('.mobile-bar').getByText('Sign out').count()) > 0) throw new Error('Sign out should not sit in the top bar');
await page.locator('.tabbar').getByRole('link', { name: 'Library' }).click();
await page.getByRole('heading', { name: 'Library' }).waitFor();
if ((await page.getByRole('link', { name: 'Import' }).count()) > 0) throw new Error('the library still says Import');
await page.getByRole('link', { name: 'Upload', exact: true }).waitFor();
step('top bar has no Sign out; the library says Upload');

// Opening a project seen before shows its tracks at once (no loading state).
await page.locator('.sleeve', { hasText: 'Night Bus' }).click();
await page.locator('.track-title', { hasText: '01 Long Opening' }).waitFor({ timeout: 1000 });
if ((await page.getByText('Loading tracks…').count()) > 0) throw new Error('a project already seen showed a loading state');
step('a project opened before appears instantly');

// Press and hold a message for its menu.
const pid = page.url().split('/').pop();
await page.goto(`${BASE}/messages/p-${pid}`);
await page.getByLabel('Message', { exact: true }).fill('Mix two is up');
await page.getByRole('button', { name: 'Send' }).click();
const msg = page.locator('.msg', { hasText: 'Mix two is up' });
await msg.waitFor({ timeout: 2000 });
await page.locator('.msg:not(.pending)', { hasText: 'Mix two is up' }).waitFor({ timeout: 10000 });
if ((await page.getByRole('button', { name: /Message options/ }).count()) > 0) throw new Error('three-dot button still present');
const box = await msg.locator('.msg-text').boundingBox();
const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
// A short tap does nothing.
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
await page.waitForTimeout(120);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(500);
if ((await page.getByRole('menu').count()) > 0) throw new Error('a tap opened the message menu');
// Holding opens it; the finger lifting does not choose anything.
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
await page.getByRole('menu').waitFor({ timeout: 2000 });
await shot('app2-message-menu');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(300);
await page.getByRole('menu').getByRole('button', { name: 'Fire' }).tap();
await msg.getByRole('button', { name: 'Fire, 1' }).waitFor({ timeout: 10000 });
if ((await page.getByRole('menu').count()) > 0) throw new Error('the menu stayed open after choosing');
step('press and hold opens the message menu; a reaction chosen there lands on the message');

await browser.close();
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
