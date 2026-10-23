// M6: вбудовування з іншого домену (як Webflow Code Embed), CORS, кілька екземплярів, destroy().
// Тест сам піднімає три локальні «домени»: ассети з CORS, ассети без CORS і сторінку-хост.
//   npm run build   →   node tests/embed.mjs
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const OUT = fileURLToPath(new URL('../qa/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(DIST, 'soldier-viewer.js'))) throw new Error('Спершу npm run build');

const TYPES = {
  '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html; charset=utf-8',
};

function serveDir(dir, port, { cors }) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
      const headers = { 'Cache-Control': 'no-cache' };
      if (cors) headers['Access-Control-Allow-Origin'] = '*';
      if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, headers).end('not found');
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function servePages(port, pages) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const body = pages[new URL(req.url, 'http://x').pathname];
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    });
    srv.listen(port, 'localhost', () => resolve(srv));
  });
}

const CDN = 'http://127.0.0.1:4401'; // хостинг ассетів з CORS (як _headers на CF Pages / Netlify)
const NOCORS = 'http://127.0.0.1:4403'; // той самий dist без CORS
const SITE = 'http://localhost:4402'; // сторінка-хост (Webflow)

// Агресивні глобальні стилі, як у Webflow normalize + типовий сайт.
const HOSTILE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html { font-size: 62.5%; }
  body { margin: 0; font: 1.6rem/2 Georgia, serif; color: #111; }
  img, canvas, svg, video { max-width: 100%; height: auto; display: inline-block; vertical-align: middle; }
  div { position: relative; }
  button { all: unset; font: inherit; text-transform: uppercase; letter-spacing: .3em; }
  svg path { fill: currentColor; }
  .w-embed:before, .w-embed:after { content: " "; display: table; }
`;

const page = (body, extraHead = '') => `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${HOSTILE_CSS}</style>${extraHead}</head>
<body><header style="padding:40px">Шапка сайту</header>${body}<footer style="padding:40px;height:600px">Підвал</footer></body></html>`;

const PAGES = {
  '/webflow.html': page(`<div class="w-embed">
<div id="soldier-viewer" style="height:100svh"></div>
<script type="module">
  import { createSoldierViewer } from '${CDN}/soldier-viewer.js';
  createSoldierViewer(document.getElementById('soldier-viewer'))
    .then((v) => { window.viewer = v; })
    .catch((e) => { window.__error = String(e && e.message || e); });
</script></div>`),
  '/two.html': page(`<div style="display:flex;gap:12px;padding:0 12px">
<div id="a" style="flex:1;height:600px"></div><div id="b" style="flex:1;height:600px"></div></div>
<script type="module">
  import { createSoldierViewer } from '${CDN}/soldier-viewer.js';
  window.create = createSoldierViewer;
  Promise.all([createSoldierViewer(document.getElementById('a')), createSoldierViewer(document.getElementById('b'))])
    .then(([a, b]) => { window.va = a; window.vb = b; })
    .catch((e) => { window.__error = String(e && e.message || e); });
</script>`),
  '/nocors.html': page(`<div id="soldier-viewer" style="height:600px"></div>
<script type="module">
  import { createSoldierViewer } from '${CDN}/soldier-viewer.js';
  createSoldierViewer(document.getElementById('soldier-viewer'), { assetBase: '${NOCORS}/assets/' })
    .then((v) => { window.viewer = v; })
    .catch((e) => { window.__error = String(e && e.message || e); });
</script>`),
};

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failed++;
};

const servers = await Promise.all([
  serveDir(DIST, 4401, { cors: true }),
  serveDir(DIST, 4403, { cors: false }),
  servePages(4402, PAGES),
]);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ready = (p, expr = 'window.viewer') =>
  p.waitForFunction(
    (e) => window.__error || (eval(e) && eval(e).stage.loadProgress >= 1 && eval(e).stage.bg.fullReady),
    expr,
    { timeout: 120000 },
  );

// ---------- Webflow-подібна сторінка з іншого домену ----------
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${SITE}/webflow.html`);
  await ready(p);
  const err = await p.evaluate(() => window.__error);
  check(!err, `модуль і ассети з іншого домену (${CDN}) завантажились на ${SITE}${err ? ': ' + err : ''}`);
  await p.locator('#soldier-viewer').scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  const info = await p.evaluate(() => {
    const sv = document.querySelector('.sv-zones').getBoundingClientRect();
    const cv = document.querySelector('.sv-soldier').getBoundingClientRect();
    const bg = document.querySelector('canvas.sv-bg').getBoundingClientRect();
    const st = document.querySelector('.sv-stage').getBoundingClientRect();
    return {
      delta: Math.max(Math.abs(sv.x - cv.x), Math.abs(sv.y - cv.y), Math.abs(sv.width - cv.width), Math.abs(sv.height - cv.height)),
      bgFill: Math.abs(bg.width - st.width) < 1 && Math.abs(bg.height - st.height) < 1,
      assetBase: window.viewer.stage.cfg.assetBase,
      webgl: !document.querySelector('.sv-stage').classList.contains('sv-fallback'),
    };
  });
  check(info.assetBase === `${CDN}/assets/`, `assetBase визначено від адреси модуля: ${info.assetBase}`);
  check(info.webgl && info.bgFill && info.delta < 0.01, `глобальні стилі сайту не ламають сцену: WebGL, фон на всю сцену, зони на солдаті (Δ ${info.delta.toFixed(3)} px)`);
  // hover шолома
  const pt = await p.evaluate(() => {
    const g = document.querySelector('g[data-zone="helmet"]');
    const r = g.querySelector('path').getBoundingClientRect();
    for (let j = 5; j < 15; j++)
      for (let i = 5; i < 15; i++) {
        const x = Math.round(r.x + (r.width * i) / 20);
        const y = Math.round(r.y + (r.height * j) / 20);
        if (document.elementFromPoint(x, y)?.closest?.('g[data-zone]') === g) return [x, y];
      }
  });
  await p.mouse.move(pt[0], pt[1]);
  await p.waitForTimeout(300);
  const label = await p.evaluate(() => document.querySelector('.sv-zone-label.sv-visible')?.textContent);
  check(label === 'Шолом', `hover шолома на сторінці-хості → «${label}»`);
  await p.locator('#soldier-viewer').screenshot({ path: join(OUT, 'embed_webflow.png') });
  check(errors.length === 0, `помилок у консолі: ${errors.length}${errors.length ? ' — ' + errors.slice(0, 2).join('; ') : ''}`);
  await p.goto(`${SITE}/webflow.html?debug=1`);
  await ready(p);
  const gui = await p.evaluate(() => !!document.querySelector('.lil-gui'));
  check(gui, 'debug-чанк (lil-gui) підвантажився з хостингу ассетів');
  await p.close();
}

// ---------- кілька екземплярів і destroy() ----------
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const warnings = [];
  p.on('console', (m) => /too many active webgl contexts|context lost/i.test(m.text()) && warnings.push(m.text()));
  await p.goto(`${SITE}/two.html`);
  await ready(p, 'window.va');
  await ready(p, 'window.vb');
  const r1 = await p.evaluate(async () => {
    window.va.setAngle(90);
    await new Promise((r) => setTimeout(r, 300));
    return [window.va.getAngle(), window.vb.getAngle(), document.querySelectorAll('.sv-stage').length];
  });
  check(r1[0] === 90 && r1[1] === 0 && r1[2] === 2, `два екземпляри незалежні: A ${r1[0]}°, B ${r1[1]}°`);
  await p.screenshot({ path: join(OUT, 'embed_two_instances.png') });

  const r2 = await p.evaluate(async () => {
    const gl = document.querySelector('#a canvas.sv-bg').getContext('webgl2') || document.querySelector('#a canvas.sv-bg').getContext('webgl');
    window.va.destroy();
    await new Promise((r) => setTimeout(r, 100));
    window.vb.setAngle(45);
    await new Promise((r) => setTimeout(r, 200));
    return {
      lost: gl ? gl.isContextLost() : null,
      emptyA: document.getElementById('a').children.length === 0,
      b: window.vb.getAngle(),
      styles: document.querySelectorAll('#sv-styles').length,
    };
  });
  check(r2.lost === true && r2.emptyA && r2.b === 45, `destroy(A): WebGL-контекст звільнено (${r2.lost}), контейнер порожній, B працює (${r2.b}°)`);

  // 20 циклів create/destroy: контексти не накопичуються.
  const r3 = await p.evaluate(async () => {
    const el = document.getElementById('a');
    for (let i = 0; i < 20; i++) {
      const v = await window.create(el);
      v.setAngle(i * 18);
      v.destroy();
    }
    const v = await window.create(el);
    await new Promise((r) => setTimeout(r, 300));
    const ok = !!document.querySelector('#a canvas.sv-bg') && document.querySelectorAll('.sv-stage').length === 2;
    v.setAngle(30);
    await new Promise((r) => setTimeout(r, 200));
    return { ok, angle: v.getAngle(), styles: document.querySelectorAll('#sv-styles').length };
  });
  check(
    r3.ok && r3.angle === 30 && warnings.length === 0 && r3.styles === 1,
    `20 циклів create/destroy: попереджень про WebGL-контексти ${warnings.length}, стилі вставлено ${r3.styles} раз, новий екземпляр працює`,
  );
  await p.close();
}

// ---------- ассети без CORS: зрозуміла помилка, без сміття в DOM ----------
{
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await p.goto(`${SITE}/nocors.html`);
  await p.waitForFunction(() => window.__error || window.viewer, null, { timeout: 60000 });
  const r = await p.evaluate(() => ({ error: window.__error, children: document.getElementById('soldier-viewer').children.length }));
  check(!!r.error && /CORS/.test(r.error) && r.children === 0, `без CORS: помилка «${r.error}», контейнер порожній`);
  await p.close();
}

await browser.close();
servers.forEach((s) => s.close());
process.exit(failed ? 1 : 0);
