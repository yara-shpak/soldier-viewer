// Вага до першого показу (розділ 10, п. 8): прод-збірка, усе, що завантажено до ready.
//   npm run build && npx vite preview --port 4173   →   node tests/weight.mjs [http://127.0.0.1:4173]
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
// vite preview не стискає відповіді; хостинг (CF Pages, Netlify, Vercel) віддає текст у gzip/brotli.
const gz = (url, bytes) => {
  const path = DIST + decodeURIComponent(url.split('?')[0]).replace(/^\//, '');
  if (!/\.(js|json|svg|html|css)$/.test(path) || !existsSync(path)) return bytes;
  return gzipSync(readFileSync(path), { level: 9 }).length;
};

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const out = {};
for (const [name, vp] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__readyAt, null, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const ready = window.__readyAt;
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance
      .getEntriesByType('resource')
      .filter((e) => e.responseEnd <= ready)
      .map((e) => ({ url: e.name.replace(location.origin, ''), bytes: e.transferSize || e.encodedBodySize }));
    return { ready: Math.round(ready), doc: nav.transferSize || nav.encodedBodySize, res };
  });
  for (const f of r.res) f.gzip = gz(f.url, f.bytes);
  const raw = r.doc + r.res.reduce((a, e) => a + e.bytes, 0);
  const total = gz('/index.html', r.doc) + r.res.reduce((a, e) => a + e.gzip, 0);
  out[name] = { readyMs: r.ready, totalKB: Math.round(total / 1024), files: r.res };
  console.log(`${name}: до ready ${(total / 1024).toFixed(0)} КБ з gzip (без стиснення ${(raw / 1024).toFixed(0)} КБ), ліміт 1536 КБ`);
  for (const f of r.res.sort((a, b) => b.gzip - a.gzip))
    console.log(`   ${(f.gzip / 1024).toFixed(1).padStart(7)} КБ  ${f.url}`);
  await ctx.close();
}
await browser.close();
