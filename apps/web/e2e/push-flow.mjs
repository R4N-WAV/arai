// End-to-end: notifications. Subscribes this device (when the browser has a
// push service), then delivers an empty push to the service worker (as the
// push service would) and checks the notification it shows: names only.
// Usage: node apps/web/e2e/push-flow.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.ARAI_URL ?? 'http://localhost:8787';
const stamp = Date.now().toString(36);
const A = `pa_${stamp}`, B = `pb_${stamp}`;
const pw = 'studio take 42';
const problems = [];
const step = (s) => console.log('✓', s);
const browser = await chromium.launch({ channel: 'chromium' }); // full Chromium (the headless shell has no notification support)
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(['notifications'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of (401|404)|incognito/.test(m.text()) && problems.push(`${name} console: ${m.text()}`));
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

const a = await open('a');
const b = await open('b');
await register(a.page, A);
await register(b.page, B);
await a.page.goto(`${BASE}/settings`);
await a.page.getByRole('heading', { name: 'Notifications on this device' }).waitFor();
const btn = a.page.getByRole('button', { name: 'Turn on notifications' });
await btn.waitFor();
await btn.click();
const subscribed = await a.page.getByRole('button', { name: /Notifications are on/ }).waitFor({ timeout: 8000 }).then(() => true, () => false);
step(subscribed ? 'this device subscribed to Web Push' : 'this headless browser has no push service; subscription skipped (works on real devices)');

// Ben follows Ana; the server would now wake Ana's devices.
await b.page.evaluate((u) => fetch(`/api/social/${u}/follow`, { method: 'POST', headers: { 'X-Arai-CSRF': '1' } }), A);

// Deliver an empty push straight to Ana's service worker, as the push service would.
const cdp = await a.ctx.newCDPSession(a.page);
await cdp.send('ServiceWorker.enable');
const regId = await new Promise((resolve) => {
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    const r = e.registrations.find((x) => x.scopeURL.startsWith(BASE));
    if (r) resolve(r.registrationId);
  });
});
await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: regId, data: '' });
let notes = null;
for (let i = 0; i < 40 && !notes; i++) {
  await a.page.waitForTimeout(250);
  notes = await a.page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const n = await reg.getNotifications();
    return n.length ? n.map((x) => [x.title, x.body, x.data?.url]) : null;
  });
}
if (!notes) throw new Error('no notification shown after the push');
const [title, body, url] = notes[0];
if (!body.includes(`@${B} followed you`) || url !== '/activity') throw new Error(`unexpected notification ${JSON.stringify(notes)}`);
step(`empty push → notification “${title}: ${body}” linking to ${url}`);

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('ALL PASSED');
