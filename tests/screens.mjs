// QA-скріншоти і запис оберту (розділ 10). Потрібен запущений dev-сервер:
//   npm run dev   →   node tests/screens.mjs [http://127.0.0.1:5173]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../qa/screens/', import.meta.url));
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const ANGLES = [0, 45, 90, 180, 270];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = [];

async function open(page, vp, debug = true) {
  await page.goto(`${BASE}/${debug ? '?debug=1' : ''}`);
  await page.waitForFunction(
    () => window.viewer && window.viewer.stage.loadProgress >= 1 && window.viewer.stage.bg.fullReady,
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(600); // фейд лоадера
  await page.addStyleTag({ content: '.lil-gui{display:none!important}' });
  await settle(page);
}

const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

async function at(page, deg) {
  await page.evaluate((d) => window.viewer.setAngle(d), deg);
  await settle(page);
}

const stageShot = (page) => page.locator('.sv-stage').screenshot();

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  await open(page, vp);
  for (const a of ANGLES) {
    await at(page, a);
    await page.locator('.sv-stage').screenshot({ path: join(OUT, `${name}_${a}.png`) });
    const info = await page.evaluate(() => document.querySelector('.sv-debug-stats').textContent);
    report.push(`${name} ${a}°:\n${info}`);
  }

  // Drag мишею: 200 px праворуч повільно (без інерції) → θ ≈ 200 × 0.45 = 90°.
  await at(page, 0);
  const box = await page.locator('.sv-stage').boundingBox();
  const y = box.y + box.height * 0.5;
  const x0 = box.x + box.width * 0.3;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(x0 + i * 5, y);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const th = await page.evaluate(() => window.viewer.getAngle());
  report.push(`${name} drag +200px → θ = ${th.toFixed(2)}° (очікувано ≈90°, снеп лише в межах 20° від фронту)`);
  await page.close();
}

// Чисті кадри без debug для 0°.
for (const [name, vp] of Object.entries(VIEWPORTS)) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1 });
  await open(page, vp, false);
  await page.locator('.sv-stage').screenshot({ path: join(OUT, `${name}_clean_0.png`) });
  // Замкненість стосується сцени (кадр + фон + зони); UI-кнопки мають власні fade-переходи.
  await page.addStyleTag({ content: '.sv-views,.sv-hint{display:none!important}' });
  const ref = await stageShot(page);
  // Замкненість: +360, −360, 10 обертів (через проміжні кути) → піксель-в-піксель зі стартом.
  for (const path of [[180, 360], [-180, -360], [...Array(40)].map((_, i) => (i + 1) * 90)]) {
    for (const d of path) await at(page, d);
    const shot = await stageShot(page);
    report.push(`${name} closure θ=${path.at(-1)}: ${Buffer.compare(ref, shot) === 0 ? 'піксель-в-піксель ідентично' : 'ВІДРІЗНЯЄТЬСЯ'}`);
  }
  await at(page, 135);
  await page.locator('.sv-stage').screenshot({ path: join(OUT, `${name}_clean_135.png`) });
  await page.close();
}

// Запис повного оберту з сіткою підлоги (debug).
const vdir = join(OUT, 'video_tmp');
rmSync(vdir, { recursive: true, force: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: vdir, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const tRec = Date.now();
await open(page, VIEWPORTS.desktop);
const skip = ((Date.now() - tRec) / 1000).toFixed(2); // обрізати завантаження
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const dur = 8000;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        window.viewer.setAngle(p * 360);
        if (p < 1) requestAnimationFrame(step);
        else setTimeout(resolve, 500);
      };
      requestAnimationFrame(step);
    }),
);
await ctx.close();
const webm = readdirSync(vdir).find((f) => f.endsWith('.webm') && !f.startsWith('._'));
if (webm) {
  const mp4 = join(OUT, 'rotation_debug.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', skip, '-i', join(vdir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
  } catch {
    renameSync(join(vdir, webm), join(OUT, 'rotation_debug.webm'));
  }
}
rmSync(vdir, { recursive: true, force: true });

await browser.close();
console.log(report.join('\n'));
