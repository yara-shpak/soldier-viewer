// M4: вирівнювання зон (±2 px, в'юпорти × DPR) і взаємодія (hover, тап, drag, клавіатура).
//   npm run dev   →   node tests/zones.mjs [http://127.0.0.1:5173]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../qa/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
let failed = 0;
const check = (ok, msg) => {
  results.push(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failed++;
};

async function open(page, query = '') {
  await page.goto(`${BASE}/${query}`);
  await page.waitForFunction(
    () => window.viewer && window.viewer.stage.loadProgress >= 1 && window.viewer.stage.bg.fullReady,
    null,
    { timeout: 120000 },
  );
  await page.addStyleTag({ content: '.lil-gui{display:none!important}' });
  await page.waitForTimeout(700);
}

/** Вирівнювання в пристроєвих пікселях: межі зон проти контуру α>0.5 кадру 0. */
const ALIGN = async () => {
  const st = window.viewer.stage;
  const svgEl = document.querySelector('.sv-zones');
  const cv = document.querySelector('.sv-soldier');
  const rs = svgEl.getBoundingClientRect();
  const rc = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const W = Math.round(rc.width * dpr);
  const H = Math.round(rc.height * dpr);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const a = mk();
  a.drawImage(st.frames.get(0), 0, 0, W, H);
  const clone = svgEl.cloneNode(true);
  clone.removeAttribute('style');
  clone.removeAttribute('class');
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  clone.querySelectorAll('title').forEach((t) => t.remove());
  clone.querySelectorAll('path').forEach((p) => {
    p.setAttribute('fill', '#000');
    p.setAttribute('fill-opacity', '1');
  });
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  await img.decode();
  const z = mk();
  z.drawImage(img, 0, 0, W, H);
  const A = a.getImageData(0, 0, W, H).data;
  const Z = z.getImageData(0, 0, W, H).data;
  const ma = new Uint8Array(W * H);
  const mz = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    ma[i] = A[i * 4 + 3] > 127 ? 1 : 0;
    mz[i] = Z[i * 4 + 3] > 127 ? 1 : 0;
  }
  const edge = (m) => {
    const e = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (m[i] && (!m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W])) e[i] = 1;
      }
    return e;
  };
  const ea = edge(ma);
  const ez = edge(mz);
  // Відстань до контуру солдата (двопрохідний chamfer 3-4).
  const INF = 1e9;
  const d = new Float32Array(W * H).fill(INF);
  for (let i = 0; i < W * H; i++) if (ea[i]) d[i] = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - W] + 1);
        if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + 1.4142);
        if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + 1.4142);
      }
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < H - 1) {
        d[i] = Math.min(d[i], d[i + W] + 1);
        if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + 1.4142);
        if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + 1.4142);
      }
    }
  // Лише зовнішні межі зон (поблизу контуру), внутрішні межі зона-зона не рахуються.
  const near = 6 * dpr;
  let n = 0;
  let ok = 0;
  let max = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ez[i] || d[i] > near) continue;
    n++;
    if (d[i] <= 2 * dpr) ok++;
    max = Math.max(max, d[i] / dpr);
  }
  return {
    dpr,
    rectDelta: Math.max(
      Math.abs(rs.left - rc.left),
      Math.abs(rs.top - rc.top),
      Math.abs(rs.width - rc.width),
      Math.abs(rs.height - rc.height),
    ),
    within2: ok / n,
    n,
    maxNear: max,
  };
};

for (const [name, vp] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  for (const dpr of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: dpr });
    await open(page);
    const r = await page.evaluate(ALIGN);
    check(
      r.rectDelta < 0.01 && r.within2 >= 0.97,
      `${name} DPR ${dpr}: SVG і canvas збігаються (Δ ${r.rectDelta.toFixed(3)} px); ` +
        `зовнішні межі зон у межах ±2 px: ${(r.within2 * 100).toFixed(1)}% з ${r.n} точок`,
    );
    await page.close();
  }
}

/** Точка всередині зони, яку справді отримає хіт-тест (дрібна зона може бути зверху). */
const ZONE_POINT = (key) => {
  const g = document.querySelector(`g[data-zone="${key}"]`);
  const svg = g.ownerSVGElement;
  const pt = svg.createSVGPoint();
  const cands = [];
  for (const p of g.querySelectorAll('path')) {
    const b = p.getBBox();
    const m = p.getScreenCTM();
    for (let i = 1; i < 20; i++)
      for (let j = 1; j < 20; j++) {
        pt.x = b.x + (i / 20) * b.width;
        pt.y = b.y + (j / 20) * b.height;
        if (!p.isPointInFill(pt)) continue;
        const s = pt.matrixTransform(m);
        const top = document.elementFromPoint(s.x, s.y)?.closest?.('g[data-zone]');
        if (top === g) cands.push([s.x, s.y]);
      }
  }
  if (!cands.length) return null;
  const mx = cands.reduce((a, c) => a + c[0], 0) / cands.length;
  const my = cands.reduce((a, c) => a + c[1], 0) / cands.length;
  return cands.reduce((a, c) => ((c[0] - mx) ** 2 + (c[1] - my) ** 2 < (a[0] - mx) ** 2 + (a[1] - my) ** 2 ? c : a));
};

const state = (page) =>
  page.evaluate(() => ({
    on: document.querySelector('.sv-stage').classList.contains('sv-zones-on'),
    active: [...document.querySelectorAll('.sv-zone-active')].map((g) => g.dataset.zone),
    label: document.querySelector('.sv-zone-label.sv-visible')?.textContent ?? null,
    theta: window.viewer.getAngle(),
  }));

// ---------- десктоп: hover, drag, клавіатура ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await open(page);
  await page.evaluate(() => {
    window.__ev = [];
    for (const e of ['front:enter', 'front:leave', 'zone:hover', 'zone:select'])
      window.viewer.on(e, (p) => window.__ev.push([e, p ?? null]));
  });
  check((await state(page)).on, 'зони активні у фронті після завантаження');

  for (const key of ['helmet', 'gloves', 'knee_pads', 'goggles']) {
    const p = await page.evaluate(ZONE_POINT, key);
    await page.mouse.move(p[0], p[1]);
    await page.waitForTimeout(250);
    const s = await state(page);
    check(s.active.length === 1 && s.active[0] === key && s.label, `hover ${key}: підсвічено «${s.label}»`);
    if (key === 'gloves') {
      const gl = await page.evaluate(() => document.querySelectorAll('g.sv-zone-active path').length);
      check(gl === 2, `hover однієї рукавиці підсвічує обидві (path у групі: ${gl})`);
    }
    if (key === 'helmet' || key === 'gloves')
      await page.locator('.sv-stage').screenshot({ path: join(OUT, `zones_hover_${key}.png`) });
  }

  // Клік без drag → zone:select
  const kp = await page.evaluate(ZONE_POINT, 'plate_carrier');
  await page.mouse.move(kp[0], kp[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(100);
  check(
    (await page.evaluate(() => window.__ev.some(([e, p]) => e === 'zone:select' && p === 'plate_carrier'))),
    'клік по зоні → zone:select(plate_carrier)',
  );

  // Drag, що починається на зоні: зони зникають одразу, вибору немає.
  await page.evaluate(() => (window.__ev = []));
  await page.mouse.move(kp[0], kp[1]);
  await page.mouse.down();
  await page.mouse.move(kp[0] + 6, kp[1]);
  const mid = await state(page);
  check(!mid.on && mid.active.length === 0, 'на початку drag зони приховано миттєво');
  for (let i = 1; i <= 20; i++) await page.mouse.move(kp[0] + 6 + i * 8, kp[1]);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const ev = await page.evaluate(() => window.__ev);
  check(!ev.some(([e]) => e === 'zone:select'), 'після drag вибору зони немає');
  check(ev.some(([e]) => e === 'front:leave'), 'drag → front:leave');
  const away = await state(page);
  check(!away.on && Math.abs(away.theta) > 20, `поза фронтом (θ ${away.theta.toFixed(1)}°) зони неактивні`);

  // Повернення до фронту клавішею Home: показ через ~200 мс.
  await page.locator('.sv-stage').focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(450);
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('.sv-stage').classList.contains('sv-zones-on'), null, { timeout: 2000 });
  check(true, `Home → фронт, зони знову активні (через ${Date.now() - t0 + 450} мс після натискання)`);

  // Клавіатура: Tab → зона у фокусі (лейбл), Enter → zone:select.
  await page.evaluate(() => (window.__ev = []));
  // Порядок Tab: спершу кнопки ракурсів, потім зони.
  let fk = null;
  for (let i = 0; i < 8 && !fk; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    fk = await page.evaluate(() => document.activeElement?.getAttribute?.('data-zone'));
  }
  const s2 = await state(page);
  await page.keyboard.press('Enter');
  const sel = await page.evaluate(() => window.__ev.filter(([e]) => e === 'zone:select').map(([, p]) => p));
  check(fk && s2.label && sel[0] === fk, `Tab → фокус на «${s2.label}», Enter → zone:select(${sel[0]})`);
  const roles = await page.evaluate(() =>
    [...document.querySelectorAll('g[data-zone]')].every((g) => g.getAttribute('role') === 'button' && g.getAttribute('aria-label')),
  );
  check(roles, 'кожна g[data-zone]: role="button" + aria-label');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  const tabb = await page.evaluate(() => document.querySelectorAll('g[data-zone][tabindex]').length);
  check(tabb === 0, 'поза фронтом зони не в порядку Tab');
  await page.close();
}

// ---------- тач: тап, тап поза зоною, свайп ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await open(page);
  await page.evaluate(() => {
    window.__ev = [];
    window.viewer.on('zone:select', (p) => window.__ev.push(p));
  });
  const mk = await page.evaluate(() =>
    [...document.querySelectorAll('.sv-zone-marker')].map((m) => {
      const r = m.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2 + 0)?.closest?.('g[data-zone]');
      return [m.dataset.zone, hit?.dataset.zone ?? null];
    }),
  );
  check(
    mk.length === 12 && mk.every(([a, b]) => a === b),
    `тач: ${mk.length} маркерів, кожен над своєю зоною (${mk.filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`).join(', ') || 'ok'})`,
  );
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'zones_touch_markers.png') });

  const gp = await page.evaluate(ZONE_POINT, 'gloves');
  await page.touchscreen.tap(gp[0], gp[1]);
  await page.waitForTimeout(250);
  let s = await state(page);
  check(s.active[0] === 'gloves' && (await page.evaluate(() => window.__ev[0])) === 'gloves', `тап по рукавиці → вибір «${s.label}»`);
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'zones_touch_gloves.png') });

  await page.touchscreen.tap(30, 420);
  await page.waitForTimeout(200);
  s = await state(page);
  check(s.active.length === 0 && !s.label, 'тап поза зонами → скасування');

  // Горизонтальний свайп по зоні: обертання, без вибору.
  const cdp = await ctx.newCDPSession(page);
  const hp = await page.evaluate(ZONE_POINT, 'plate_carrier');
  await page.evaluate(() => (window.__ev = []));
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', hp[0], hp[1]);
  for (let i = 1; i <= 15; i++) {
    await touch('touchMove', hp[0] + i * 8, hp[1]);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await touch('touchEnd');
  await page.waitForTimeout(900);
  s = await state(page);
  const sel = await page.evaluate(() => window.__ev.length);
  check(Math.abs(s.theta) > 20 && sel === 0, `свайп 120 px по зоні: θ ${s.theta.toFixed(1)}°, вибору немає`);
  await ctx.close();
}

// ---------- debug: контури всіх зон ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await open(page, '?debug=1');
  await page.evaluate(() => {
    const st = window.viewer.stage;
    st.cfg.hotspots.debugOutlines = true;
    st.applyConfig(st.cfg);
  });
  await page.waitForTimeout(300);
  await page.locator('.sv-stage').screenshot({ path: join(OUT, 'zones_debug_outlines.png') });
  await page.close();
}

await browser.close();
console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
