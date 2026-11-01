// Renders Arai's app icons (home screen, Android, maskable) from the outlined
// அ mark in apps/web/src/components/logoPaths.ts. Run when the logo changes:
//   NODE_PATH=$(npm root -g) node scripts/build-icons.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const src = readFileSync(new URL('../apps/web/src/components/logoPaths.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('export const MARK'));
const viewBox = /viewBox: '([^']+)'/.exec(block)[1];
const d = /d: '([^']+)'/.exec(block)[1];
const tilt = /tilt: '([^']+)'/.exec(block)[1];

const out = new URL('../apps/web/public/icons/', import.meta.url).pathname;
const icons = [
  { file: 'apple-touch-icon.png', size: 180, mark: 0.64 },
  { file: 'icon-192.png', size: 192, mark: 0.64 },
  { file: 'icon-512.png', size: 512, mark: 0.64 },
  { file: 'maskable-512.png', size: 512, mark: 0.5 }, // safe zone for Android masks
];

const browser = await chromium.launch();
for (const i of icons) {
  const page = await browser.newPage({ viewport: { width: i.size, height: i.size } });
  // Full-bleed square: iOS/Android apply their own rounded mask.
  await page.setContent(`<html><body style="margin:0;background:#08080a;display:grid;place-items:center;width:${i.size}px;height:${i.size}px;overflow:hidden">
    <div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 38%, rgba(242,239,234,0.07), transparent 62%)"></div>
    <svg viewBox="${viewBox}" style="position:relative;height:${Math.round(i.size * i.mark)}px;transform:translate(0, ${Math.round(i.size * 0.02)}px)"><path fill="#f2efea" transform="${tilt}" d="${d}"/></svg>
  </body></html>`);
  await page.screenshot({ path: out + i.file, omitBackground: false });
  await page.close();
}
await browser.close();
console.log('icons written to', out);
