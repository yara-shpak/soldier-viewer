# Soldier 360 Viewer

Інтерактивний 360-переглядач солдата на тлі ангару: drag обертає солдата і камеру на орбіті всередині панорами,
у фронтальній позі активні зони спорядження. Етапи **M1–M6** готові; чекліст приймання — [`qa/acceptance.md`](qa/acceptance.md),
звіт пайплайна — [`qa/report.md`](qa/report.md).

```
source/      вхідні файли (не деплоїти)          pipeline/   Python: відео → кадри, тіні, кути, зони, панорама
public/      config.json + assets/ (генерується)  src/        рантайм: Vite + TypeScript + three.js
site/        демо і приклад вбудовування для dist  tests/      Playwright-перевірки (розділ 10 ТЗ)
qa/          звіти, скріншоти, відео              dist/       готовий до хостингу результат (npm run build)
```

## 1. Швидкий старт

Вимоги: Python 3.11+, ffmpeg, Node.js 20+.

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
npm install
.venv/bin/python pipeline/build.py   # ассети в public/assets (перший запуск ~80 хв через rembg)
npm run dev                          # демо: http://127.0.0.1:5173  (debug: ?debug=1)
npm run build                        # dist/ для хостингу
```

## 2. Пайплайн

- Вхідні файли — у `source/`: `soldier.mp4`, `zones.svg`, `hangar_360.png` (опційно `hangar_360_upscaled.png`).
  Файли можна замінити (напр., відео 1920×1920) — усі піксельні параметри масштабуються від розміру кадру, числа
  (ключові кадри, кінець петлі, точка опори, кроп) вимірюються заново.
- Параметри — `pipeline/config.yaml` (значення з позначкою «калібрування» — стартові).
- Кроки: `extract → aimask → plate → matte → angles → shadow → export → svg → pano → qa`.
  Один крок — `--step matte` (можна кілька), з кроку до кінця — `--from angles`.
- `aimask` (rembg `birefnet-general`) — найдовший крок (~25 с/кадр на CPU), кешується в `build_tmp/alpha_ai`;
  перерахунок — `--step aimask --force`.
- Проміжні файли — `build_tmp/`, QA — `qa/` (contact sheet, `matte_check.mp4`, краї ×2, графік кутів, накладання зон, `report.md`).

| Результат | Зміст |
|---|---|
| `public/assets/soldier/full/NNN.webp`, `half/` | кадри солдата RGBA (деконтаміновані краї), кроп і 50% |
| `public/assets/shadow/NNN.webp` | шар тіні (чорний + альфа), 50% |
| `public/assets/angles.json` | таблиця «кадр → кут» (нерівномірне обертання) |
| `public/assets/manifest.json` | кроп, розміри наборів, точка опори, headTopY, svgScale, варіанти панорами |
| `public/assets/zones.svg`, `zones.json` | зони, згруповані за кольором, і їхні назви (редагуйте `title` / `description`) |
| `public/assets/pano/*.jpg` | панорама 2:1: `pano_preview` 1024, основна, розмиті `_b2` / `_b4`, `pano_8192` з апскейлу |

Назви зон і відповідність кольорів — `pipeline/config.yaml → zones`. Невідомий колір у SVG — помилка з переліком.

## 3. Калібрування

1. `npm run dev`, відкрийте `http://127.0.0.1:5173/?debug=1`.
2. Панель lil-gui: **Camera** (fov, distance, height, lookAtHeight; окремо portrait), **Skybox** (yaw, яскравість, контраст,
   насиченість, розмиття), **Soldier** (heightM, зсув, превʼю тонування), **Shadow**, **Rotation**, **Hotspots**, **Fade**.
   Оверлеї: сітка підлоги 1×1 м, перехрестя в точці опори, θ / кадр / φ камери / FPS.
3. **Copy config** → вставте JSON у `public/config.json` (у `dist/` — `config.json`). Перезбирати не треба: файл читається в рантаймі.
4. Тонування солдата запікається в кадри: перенесіть значення превʼю в `pipeline/config.yaml → export.tone`
   і запустіть `--from export`.

Поточне калібрування: `public/config.json` повертає панораму так, що у фронті за солдатом стоїть Humvee.

## 4. Збірка і вбудовування

`npm run build` → `dist/`:

```
dist/soldier-viewer.js      один ES-модуль (three.js усередині), ~146 КБ gzip
dist/chunks/debug-*.js      lil-gui — лише для ?debug=1
dist/assets/                кадри, тіні, панорама, зони, manifest, angles
dist/config.json            калібрування
dist/index.html             демо;  dist/embed-example.html — приклад вбудовування
dist/_headers               CORS і кешування для Cloudflare Pages / Netlify
```

### Розгорнуто: GitHub Pages

**https://yara-shpak.github.io/soldier-viewer/** — демо (`?debug=1` — калібрування), приклад вбудовування —
`embed-example.html`. Кожен push у `main` збирає і публікує `dist/` (`.github/workflows/pages.yml`).
GitHub Pages віддає `Access-Control-Allow-Origin: *`, тож модуль можна імпортувати на будь-якому сайті:

```html
<div id="soldier-viewer" style="height:100svh"></div>
<script type="module">
  import { createSoldierViewer } from 'https://yara-shpak.github.io/soldier-viewer/soldier-viewer.js';
  createSoldierViewer(document.getElementById('soldier-viewer'));
</script>
```

Калібрування на живому сайті: змініть `public/config.json`, закомітьте — за ~30 с зміни на Pages.
Оновлення кадрів: перезапустіть пайплайн локально (вхідні файли в репозиторій не входять) і закомітьте `public/assets`.

### Інший хостинг

Ассети хостяться окремо від сайту (Webflow Assets не зберігає структуру папок та імена файлів). Підійде будь-який
статичний хостинг — достатньо залити вміст `dist/`:

- **Cloudflare Pages / Netlify** — `dist/_headers` уже містить CORS.
- **Vercel** — імпортуйте репозиторій як **один проєкт** (застосунок Vite у корені, «Імпорт одного проекту»).
  Python-пайплайн — офлайн-інструмент, його не деплоять; пропозицію «багатосервісного проєкту» ігноруйте.
  `vercel.json` у корені задає збірку (`npm run build` → `dist`) і CORS.
- **Cloudflare R2 / S3** — увімкніть CORS на бакеті:
  ```json
  [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 }]
  ```

**CORS обов'язковий**: модуль імпортується з іншого домену, JSON читається через `fetch`, а панорама стає WebGL-текстурою —
без заголовка `Access-Control-Allow-Origin` нічого з цього не завантажиться (`createSoldierViewer` відхилиться з поясненням).
Замість `*` можна вказати домен сайту.

### Webflow (Code Embed)

```html
<div id="soldier-viewer" style="height:100svh"></div>
<script type="module">
  import { createSoldierViewer } from 'https://<host>/soldier-viewer.js';
  createSoldierViewer(document.getElementById('soldier-viewer'));
</script>
```

`assetBase` за замовчуванням — тека `assets/` поруч із `soldier-viewer.js`, `config.json` — поруч з `assets/`.
Якщо ассети лежать деінде — `createSoldierViewer(el, { assetBase: 'https://cdn.example.com/soldier/assets/' })`.
Висоту задає контейнер (сцена займає 100% його розміру). Стилі вставляються один раз і захищені від глобальних стилів сайту.

## 5. API

```ts
const viewer = await createSoldierViewer(container, options?);
viewer.setAngle(deg, { animate?: boolean });   // кут у градусах, без меж (0 = фронт)
viewer.goFront({ animate?: boolean });          // до найближчого фронту
viewer.setView('front' | 'left' | 'right' | 'back'); // ракурс, як кнопки під солдатом
viewer.getAngle();
const off = viewer.on(event, (payload) => {});  // повертає функцію відписки
viewer.destroy();                               // звільняє WebGL-контекст, слухачі, DOM
```

| Подія | Payload |
|---|---|
| `ready` | — |
| `anglechange` | θ (градуси) |
| `front:enter` / `front:leave` | — |
| `zone:hover` | key \| null (миша, фокус) |
| `zone:select` | key (клік, тап, Enter / Space) |

`options` — будь-яке підмножина конфігу (`src/config.ts`), напр. `{ rotation: { loop: 'clamped' }, shadow: { opacity: 0.8 } }`.
Порядок: дефолти ← `config.json` ← `options`. Службові опції: `assetBase`, `configUrl` (`'auto'` / URL / `null`),
`renderer` (`'auto'` / `'webgl'` / `'2d'`), `debug` (або `?debug=1` в адресі).

Кілька екземплярів на сторінці працюють незалежно (без глобального стану).

## 6. Поведінка

- Drag мишею, пальцем, пером з інерцією; у межах 20° від фронту — снеп. Горизонтальний свайп обертає, вертикальний прокручує
  сторінку; колесо миші не перехоплюється. Клавіатура (сцена у фокусі): ← / → — ±15°, Home / Esc — до фронту.
- Зони активні лише у фронті (у фронті завжди показується кадр 0, з яким вони вирівняні): hover / тап / Tab підсвічують
  групу і показують назву. На тачі — маркери, на десктопі — одноразова пульсація.
- Підказка «Потягніть, щоб обернути» до першого drag.
- Кнопки ракурсів під солдатом — «Фронтально», «Зліва», «Справа», «Позаду»: поворот найкоротшим шляхом з анімацією,
  кнопка поточного ракурсу підсвічена. Іконка — вид згори (куди дивиться солдат). «Справа» — бачимо праве плече солдата
  (θ = 90°); кути змінюються в `config.json → ui.viewAngles`, вимкнути — `ui.viewButtons: false`.
- Перший показ ≈ 0,3 МБ (JS, `pano_preview`, кадр 0, зони); повна панорама і решта кадрів — після, з лінією прогресу.
  Екрани з короткою стороною < 500 px і Save-Data — набір `half`.
- `prefers-reduced-motion`: без інерції, миттєві снеп і кроки, без пульсацій. Без WebGL — смуга панорами (`renderer: '2d'`).
- Стилі зон і лейблів — CSS-змінні на `.sv-stage`: `--sv-zone-fill`, `--sv-zone-fill-opacity`, `--sv-zone-stroke`,
  `--sv-zone-stroke-width`, `--sv-zone-glow`, `--sv-label-bg`, `--sv-label-color`, `--sv-bg`.

## 7. Тести

Браузери: `npx playwright install chromium webkit firefox`. Рендер у headless програмний (SwiftShader) — FPS там не показовий.

| Команда | Що перевіряє | Сервер |
|---|---|---|
| `node tests/screens.mjs` | скріншоти 0/45/90/180/270°, замкненість ±360° і 10 обертів, drag, запис оберту | `npm run dev` |
| `node tests/zones.mjs` | вирівнювання зон ±2 px (2 в'юпорти × DPR 1/2/3), hover, тап, drag, клавіатура | `npm run dev` |
| `node tests/polish.mjs` | інерція, снеп, підказка, кнопки ракурсів, reduced-motion, скрол, fallback, «Copy config» | `npm run dev` |
| `node tests/browsers.mjs` | Chromium, WebKit, Firefox: завантаження, замкненість, hover, drag, тап | `npm run dev` |
| `node tests/weight.mjs` | вага до першого показу (gzip) | `npm run build && npm run preview` |
| `node tests/embed.mjs` | вбудовування з іншого домену на сторінку з агресивними стилями, CORS, два екземпляри, 20× destroy | `npm run build` (сервери піднімає сам) |

## 8. Нотатки

- **exFAT.** macOS створює службові `._*`; пайплайн і збірка їх прибирають. Якщо Python-пакети падають з `UnicodeDecodeError`:
  `find .venv -name '._*' -delete`.
- **Обмеження джерел** (детально — `qa/report.md`): обертання у відео з ривками до ~8°/кадр (є `rotation.frameBlend`);
  GroundedSkybox — не справжнє 3D, предмети фону трохи «лягають» (калібрується `camera.distance` / `skybox.panoHeight`);
  солдат ≈760 px заввишки — для різкості на retina рендерте джерело 1920×1920, пайплайн підхопить без змін.
