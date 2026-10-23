// Крос-браузерний smoke (розділ 10, п. 9): Chromium, WebKit (рушій Safari), Firefox.
//   npm run dev   →   node tests/browsers.mjs [http://127.0.0.1:5173]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../qa/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failed++;
};

const ENGINES = [
  ['chromium', chromium, { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }],
  ['webkit', webkit, {}],
  ['firefox', firefox, {}],
];

for (const [name, type, launch] of ENGINES) {
  const browser = await type.launch(launch);
  for (const [vpName, ctxOpts] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['touch', { viewport: { width: 390, height: 844 }, hasTouch: true, ...(name === 'firefox' ? {} : { isMobile: true }) }],
  ]) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(BASE + '/');
    const ok = await page
      .waitForFunction(() => window.viewer && window.viewer.stage.loadProgress >= 1 && window.viewer.stage.bg.fullReady, null, {
        timeout: 120000,
      })
      .then(() => true, () => false);
    if (!ok) {
      check(false, `${name} ${vpName}: не завантажився (${errors.join('; ') || 'таймаут'})`);
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => ({
      webgl: !document.querySelector('.sv-stage').classList.contains('sv-fallback'),
      zones: document.querySelectorAll('g[data-zone]').length,
      on: document.querySelector('.sv-stage').classList.contains('sv-zones-on'),
    }));
    await page.screenshot({ path: join(OUT, `browser_${name}_${vpName}.png`) });

    // Замкненість: 0° і після +360°.
    // Лише сцена: UI-кнопки мають fade, а тач-маркери пульсують безперервно.
    await page.addStyleTag({ content: '.sv-views,.sv-hint,.sv-zone-markers{display:none!important}.sv-zones path{animation:none!important;transition:none!important}' });
    const shot = () => page.locator('.sv-stage').screenshot();
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
    await settle();
    const a = await shot();
    for (const d of [120, 240, 360]) {
      await page.evaluate((x) => window.viewer.setAngle(x), d);
      await settle();
    }
    await page.waitForTimeout(400);
    const b = await shot();

    // Взаємодія: миша — hover шолома + drag; тач — тап по рукавиці.
    await page.evaluate(() => window.viewer.setAngle(0));
    await page.waitForTimeout(500);
    let interact = '';
    // Точка ближче до центру зони (Firefox округлює тач-координати до цілих px).
    const pt = await page.evaluate((key) => {
      const g = document.querySelector(`g[data-zone="${key}"]`);
      const r = g.querySelector('path').getBoundingClientRect();
      const c = [];
      for (let j = 1; j < 20; j++)
        for (let i = 1; i < 20; i++) {
          const x = Math.round(r.x + (r.width * i) / 20);
          const y = Math.round(r.y + (r.height * j) / 20);
          if (document.elementFromPoint(x, y)?.closest?.('g[data-zone]') === g) c.push([x, y]);
        }
      const mx = c.reduce((a, p) => a + p[0], 0) / c.length;
      const my = c.reduce((a, p) => a + p[1], 0) / c.length;
      return c.reduce((a, p) => ((p[0] - mx) ** 2 + (p[1] - my) ** 2 < (a[0] - mx) ** 2 + (a[1] - my) ** 2 ? p : a));
    }, vpName === 'desktop' ? 'helmet' : 'gloves');
    if (vpName === 'desktop') {
      await page.mouse.move(pt[0], pt[1]);
      await page.waitForTimeout(300);
      const label = await page.evaluate(() => document.querySelector('.sv-zone-label.sv-visible')?.textContent ?? null);
      await page.mouse.move(200, 400);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(200 + i * 5, 400);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(500);
      const th = await page.evaluate(() => window.viewer.getAngle());
      interact = `hover «${label}», drag 200 px → ${th.toFixed(1)}°`;
      check(label === 'Шолом' && Math.abs(th - 90) < 0.5, `${name} ${vpName}: ${interact}`);
    } else {
      await page.touchscreen.tap(pt[0], pt[1]);
      await page.waitForTimeout(300);
      const label = await page.evaluate(() => document.querySelector('.sv-zone-label.sv-visible')?.textContent ?? null);
      interact = `тап по рукавиці → «${label}»`;
      check(label === 'Тактичні рукавиці', `${name} ${vpName}: ${interact}`);
    }
    check(
      info.webgl && info.zones === 12 && info.on && Buffer.compare(a, b) === 0 && errors.length === 0,
      `${name} ${vpName}: WebGL ${info.webgl ? 'так' : 'НІ'}, зон ${info.zones}, активні ${info.on}, ` +
        `замкненість ${Buffer.compare(a, b) === 0 ? 'ок' : 'ВІДРІЗНЯЄТЬСЯ'}, помилок у консолі ${errors.length}` +
        (errors.length ? ` (${errors.slice(0, 2).join('; ')})` : ''),
    );
    await ctx.close();
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
