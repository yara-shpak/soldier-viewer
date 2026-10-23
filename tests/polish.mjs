// M5: підказка, «до фронту», інерція/снеп, клавіатура, reduced-motion, тач-скрол,
// fallback без WebGL, long tasks, «Copy config» (розділ 10, п. 10).
//   npm run dev   →   node tests/polish.mjs [http://127.0.0.1:5173]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../qa/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
const metrics = {};
let failed = 0;
const check = (ok, msg) => {
  const line = `${ok ? '✓' : '✗'} ${msg}`;
  results.push(line);
  console.log(line);
  if (!ok) failed++;
};

async function open(page, query = '', full = true) {
  await page.goto(`${BASE}/${query}`);
  await page.waitForFunction(
    (f) => window.viewer && (!f || (window.viewer.stage.loadProgress >= 1 && window.viewer.stage.bg.fullReady)),
    full,
    { timeout: 120000 },
  );
  await page.addStyleTag({ content: '.lil-gui{display:none!important}' });
  await page.waitForTimeout(500);
}
const theta = (page) => page.evaluate(() => window.viewer.getAngle());
const normDeg = (d) => ((d % 360) + 360) % 360;
const visible = (page, sel) => page.evaluate((s) => document.querySelector(s)?.classList.contains('sv-visible'), sel);

async function drag(page, dx, { steps = 20, stepMs = 16, holdMs = 0 } = {}) {
  const box = await page.locator('.sv-stage').boundingBox();
  const x0 = box.x + box.width * 0.25;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y);
    if (stepMs) await page.waitForTimeout(stepMs);
  }
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

// ---------- підказка жесту, «до фронту», інерція, снеп, клавіатура ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page);
  check(await visible(page, '.sv-hint'), 'підказка «Потягніть, щоб обернути» після ready');
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'polish_hint.png') });

  // Повільний drag на 12° і відпускання: снеп до фронту (ease-out 350 мс).
  await drag(page, 12 / 0.45, { steps: 10, stepMs: 30, holdMs: 150 });
  check(!(await visible(page, '.sv-hint')), 'підказка зникла після першого drag');
  await page.waitForFunction(() => Math.abs(window.viewer.getAngle()) < 1e-6, null, { timeout: 3000 }).catch(() => {});
  const snapped = await theta(page);
  check(Math.abs(snapped) < 1e-6, `снеп: відпущено на ~12°, θ → ${snapped.toFixed(3)}°`);

  // Повільний drag на 90°: без інерції і без снепу.
  await drag(page, 200, { steps: 40, stepMs: 16, holdMs: 150 });
  await page.waitForTimeout(500);
  const t90 = await theta(page);
  check(Math.abs(t90 - 90) < 0.01, `повільний drag 200 px → θ ${t90.toFixed(2)}° (інерції немає, бо палець зупинився)`);

  // Кнопки ракурсів: найкоротший шлях, активна кнопка, зони у фронті.
  const view = async (key) => {
    await page.click(`.sv-view-btn[data-view="${key}"]`, { timeout: 3000 });
    const seen = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const vals = [];
          const t0 = performance.now();
          const poll = () => {
            vals.push(window.viewer.getAngle());
            if (performance.now() - t0 < 1500 && window.viewer.stage.input.moving) setTimeout(poll, 10);
            else setTimeout(() => resolve([...vals, window.viewer.getAngle()]), 50);
          };
          poll();
        }),
    );
    const active = await page.evaluate(() => [...document.querySelectorAll('.sv-view-btn.sv-active')].map((b) => b.dataset.view));
    return { from: seen[0], to: seen.at(-1), steps: new Set(seen.map((v) => v.toFixed(1))).size, active };
  };
  check((await visible(page, '.sv-views')) && (await page.locator('.sv-view-btn').count()) === 4, 'чотири кнопки ракурсів видимі');
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'views_right.png') });
  const VIEW = { front: 0, left: 270, right: 90, back: 180 };
  for (const key of ['back', 'left', 'front', 'right', 'left', 'back']) {
    const r = await view(key);
    const d = r.to - r.from;
    check(
      Math.abs(normDeg(r.to) - VIEW[key]) < 1e-6 && Math.abs(d) <= 180 && r.active.length === 1 && r.active[0] === key && r.steps > 2,
      `«${key}»: θ ${r.from.toFixed(0)}° → ${r.to}° (≡ ${normDeg(r.to)}°, поворот ${d > 0 ? '+' : ''}${d}°, плавно), активна ${r.active.join(',')}`,
    );
  }
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'views_back.png') });
  await view('front');
  await page.waitForFunction(() => document.querySelector('.sv-stage').classList.contains('sv-zones-on'), null, { timeout: 3000 }).catch(() => {});
  const zonesOn = await page.evaluate(() => document.querySelector('.sv-stage').classList.contains('sv-zones-on'));
  check(Math.abs(normDeg(await theta(page))) < 1e-6 && zonesOn, 'після «Фронтально» зони знову активні');
  const ev = await page.evaluate(() => {
    let sel = 0;
    window.viewer.on('zone:select', () => sel++);
    document.querySelector('.sv-view-btn[data-view="front"]').click();
    return sel;
  });
  check(ev === 0, 'клік по кнопці не вибирає зону під нею і не запускає drag');

  // Клавіатура: → +15° з твіном 250 мс, Home → фронт.
  await page.evaluate(() => window.viewer.setAngle(100));
  await page.locator('.sv-stage').focus();
  await page.keyboard.press('ArrowRight');
  const seen = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const vals = [];
        const t0 = performance.now();
        const poll = () => {
          vals.push(window.viewer.getAngle());
          if (performance.now() - t0 < 1200) setTimeout(poll, 10);
          else resolve(vals);
        };
        poll();
      }),
  );
  const mid = seen.find((v) => v > 100 && v < 115);
  const after = seen.at(-1);
  check(mid !== undefined && Math.abs(after - 115) < 1e-6, `→: 100° → ${mid?.toFixed(1)}° (твін) → ${after}°`);
  await page.keyboard.press('Home');
  const home = await page
    .waitForFunction(() => Math.abs(window.viewer.getAngle()) < 1e-6, null, { timeout: 3000 })
    .then(() => true, () => false);
  check(home, `Home → 0° (θ ${(await theta(page)).toFixed(3)}°)`);

  // Повторне відкриття: підказка більше не з'являється (localStorage).
  await open(page);
  check(!(await visible(page, '.sv-hint')), 'після перезавантаження підказка не з’являється');

  await ctx.close();
}


// ---------- інерція і колесо (малий в'юпорт: SwiftShader на 1440×900 рендерить кадр >80 мс,
// і проміжки між подіями руху перевищують вікно швидкості) ----------
{
  const ctx = await browser.newContext({ viewport: { width: 640, height: 420 } });
  const page = await ctx.newPage();
  await open(page, '?renderer=2d'); // логіка вводу та сама, рендер дешевий — події не запізнюються
  // Швидкий drag: після відпускання θ продовжує рух і плавно згасає.
  await drag(page, 160, { steps: 8, stepMs: 8 });
  const atRelease = await theta(page);
  await page.waitForTimeout(80);
  const soon = await theta(page);
  await page.waitForTimeout(1500);
  const settled = await theta(page);
  check(
    soon > atRelease && settled > soon,
    `інерція: θ на відпусканні ${atRelease.toFixed(1)}°, через 80 мс ${soon.toFixed(1)}°, після згасання ${settled.toFixed(1)}°`,
  );

  // Колесо миші не перехоплюється: сторінка прокручується.
  const before = await theta(page);
  await page.mouse.move(320, 210);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(1500);
  const sy = await page.evaluate(() => window.scrollY);
  check(sy > 0 && (await theta(page)) === before, `колесо миші прокручує сторінку (scrollY ${sy}), θ не змінився`);
  await ctx.close();
}

// ---------- prefers-reduced-motion ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page);
  await drag(page, 160, { steps: 8, stepMs: 8 });
  const atRelease = await theta(page);
  await page.waitForTimeout(600);
  const later = await theta(page);
  check(Math.abs(later - atRelease) < 1e-6, `reduced-motion: без інерції (θ ${atRelease.toFixed(1)}° → ${later.toFixed(1)}°)`);
  await page.locator('.sv-stage').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(20);
  check(Math.abs((await theta(page)) - (later + 15)) < 1e-6, 'reduced-motion: крок клавіатури миттєвий');
  await page.evaluate(() => window.viewer.setAngle(8));
  await drag(page, 2 / 0.45 + 4, { steps: 4, stepMs: 20, holdMs: 120 });
  await page.waitForTimeout(30);
  const snapped = await theta(page);
  check(Math.abs(snapped) < 1e-6, `reduced-motion: снеп миттєвий (θ ${snapped}°)`);
  const pulse = await page.evaluate(() => document.querySelector('.sv-zones-pulse') !== null);
  check(!pulse, 'reduced-motion: без пульсації зон');
  await ctx.close();
}

// ---------- тач: вертикальний свайп прокручує сторінку ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await open(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', { x: 60, y: 600, yDistance: -300, gestureSourceType: 'touch', speed: 800 });
  await page.waitForTimeout(400);
  const sy = await page.evaluate(() => window.scrollY);
  check(sy > 100 && Math.abs(await theta(page)) < 1e-6, `тач: вертикальний свайп прокручує сторінку (scrollY ${sy}), θ не змінився`);
  await ctx.close();
}

// ---------- fallback без WebGL ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await open(page, '?renderer=2d');
  const fb = await page.evaluate(() => ({
    fallback: document.querySelector('.sv-stage').classList.contains('sv-fallback'),
    webgl: !!document.querySelector('canvas.sv-bg'),
    strip: !!document.querySelector('.sv-bg-strip'),
  }));
  check(fb.fallback && !fb.webgl && fb.strip, 'fallback: смуга панорами замість WebGL');
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'fallback_0.png') });
  const tx0 = await page.evaluate(() => document.querySelector('.sv-bg-strip').style.transform);
  await page.evaluate(() => window.viewer.setAngle(30));
  await page.waitForTimeout(100);
  const tx30 = await page.evaluate(() => document.querySelector('.sv-bg-strip').style.transform);
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'fallback_30.png') });
  const px = (t) => parseFloat(/translate3d\(([-\d.]+)px/.exec(t)[1]);
  const W = await page.evaluate(() => parseFloat(document.querySelector('.sv-bg-strip').style.backgroundSize));
  const dx = px(tx30) - px(tx0);
  check(Math.abs(dx + (30 / 360) * W) < 0.5, `fallback: +30° → смуга зсунулась на ${dx.toFixed(1)} px (очікувано −${((30 / 360) * W).toFixed(1)})`);
  await page.evaluate(() => window.viewer.setAngle(360));
  await page.waitForTimeout(600);
  const on = await page.evaluate(() => document.querySelector('.sv-stage').classList.contains('sv-zones-on'));
  check(on, 'fallback: зони працюють у фронті');
  await page.close();
}

// ---------- long tasks під час обертання ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await open(page);
  const lt = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const tasks = [];
        const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(e.duration)));
        obs.observe({ type: 'longtask', buffered: false });
        const frames = [];
        let last = performance.now();
        const t0 = last;
        const step = (now) => {
          frames.push(now - last);
          last = now;
          window.viewer.setAngle(((now - t0) / 4000) * 720);
          if (now - t0 < 4000) requestAnimationFrame(step);
          else {
            obs.disconnect();
            frames.sort((a, b) => a - b);
            resolve({ tasks, p50: frames[frames.length >> 1], p95: frames[Math.floor(frames.length * 0.95)] });
          }
        };
        requestAnimationFrame(step);
      }),
  );
  metrics.longtasks = lt;
  console.log(
    `· headless (SwiftShader, програмний WebGL): long tasks ${lt.tasks.length}, макс ${Math.max(0, ...lt.tasks).toFixed(0)} мс; ` +
      `кадр p50 ${lt.p50.toFixed(1)} мс, p95 ${lt.p95.toFixed(1)} мс — не показово для реальних пристроїв`,
  );
  await page.close();
}

// ---------- debug «Copy config» → config.json відтворює сцену ----------
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await open(page, '?debug=1');
  const json = await page.evaluate(() => {
    const st = window.viewer.stage;
    Object.assign(st.cfg.camera, { fovDeg: 58, distance: 3.4, height: 1.55 });
    Object.assign(st.cfg.skybox, { yawDeg: -70, brightness: 1.1, contrast: 0.95, saturation: 0.7 });
    st.cfg.soldier.heightM = 1.8;
    st.cfg.shadow.syntheticOpacity = 0.5;
    st.applyConfig(st.cfg);
    st.bg.setGrid(false);
    st.setAngle(37);
    return JSON.stringify(window.__svConfig(), null, 2);
  });
  let valid = true;
  try {
    JSON.parse(json);
  } catch {
    valid = false;
  }
  const hideUi = '.sv-debug-stats,.sv-debug-cross,.sv-debug-box,.sv-views,.sv-hint{display:none!important}';
  await page.addStyleTag({ content: hideUi });
  await page.waitForTimeout(200);
  const a = await page.locator('.sv-stage').screenshot();
  writeFileSync(join(OUT, 'copied_config.json'), json);
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p2.route('**/config.json', (r) => r.fulfill({ contentType: 'application/json', body: json }));
  await open(p2);
  await p2.addStyleTag({ content: hideUi });
  await p2.evaluate(() => window.viewer.setAngle(37));
  await p2.waitForTimeout(200);
  const b = await p2.locator('.sv-stage').screenshot();
  check(valid && Buffer.compare(a, b) === 0, `«Copy config» дає валідний JSON (${json.length} байт); сцена з ним піксель-в-піксель та сама`);
  await page.close();
  await p2.close();
}

await browser.close();
writeFileSync(join(OUT, 'polish_metrics.json'), JSON.stringify(metrics, null, 2));
process.exit(failed ? 1 : 0);
