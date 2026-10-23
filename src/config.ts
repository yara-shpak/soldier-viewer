// Конфіг: дефолти в коді ← public/config.json (рантайм) ← options.
// Значення з позначкою [калібрування] підбираються в debug-режимі (?debug=1).

export interface CameraConfig {
  fovDeg: number; // вертикальний
  distance: number; // R, м
  height: number; // висота камери, м
  lookAtHeight: number; // м
}

export interface Config {
  /** Базовий URL ассетів; 'auto' — тека assets/ поруч із soldier-viewer.js. */
  assetBase: string;
  /** URL config.json; 'auto' — config.json поруч із текою assets/, null — не завантажувати. */
  configUrl: string | null;
  /** 'auto' — WebGL, якщо доступний; '2d' — fallback-смуга панорами (7.11). */
  renderer: 'auto' | 'webgl' | '2d';
  camera: CameraConfig & { portrait: CameraConfig; portraitAspect: number; maxWidthFraction: number };
  skybox: {
    panoHeight: number;
    radius: number;
    yawDeg: number;
    brightness: number;
    contrast: number;
    saturation: number;
    blurPx: 0 | 2 | 4;
  };
  soldier: {
    heightM: number;
    offsetPx: { x: number; y: number };
    set: 'auto' | 'full' | 'half';
    /** Тільки превʼю для підбору тонування; фінал запікається пайплайном. */
    previewFilter: { brightness: number; contrast: number; saturate: number; sepia: number; hueRotate: number };
  };
  shadow: {
    enabled: boolean;
    opacity: number;
    synthetic: boolean;
    syntheticOpacity: number;
    syntheticWidth: number; // частка ширини солдата у фронті
    syntheticHeight: number;
  };
  rotation: {
    orbitDir: 1 | -1;
    dragSign: 1 | -1;
    degPerPxMouse: number;
    degPerPxTouch: number;
    decay: number; // 1/с
    stopSpeed: number; // °/с
    snapRangeDeg: number;
    snapMs: number;
    keyStepDeg: number;
    keyMs: number;
    frontEps: number;
    frameBlend: boolean;
    loop: 'infinite' | 'clamped';
    inertia: boolean;
  };
  fade: { color: string; top: number; bottomStart: number; bottomEnd: number; overSoldier: boolean };
  ui: {
    /** Кнопки ракурсів під солдатом. */
    viewButtons: boolean;
    /** θ для кожного ракурсу. «Справа» = бачимо праве плече (обличчя до правого краю екрана). */
    viewAngles: { front: number; left: number; right: number; back: number };
  };
  hotspots: {
    enabled: boolean;
    showDelayMs: number;
    touchMarkers: boolean;
    hintPulse: boolean;
    /** debug: зони активні за будь-якого кута. */
    debugAlways: boolean;
    /** debug: контури всіх зон їхніми кольорами. */
    debugOutlines: boolean;
  };
}

const camera: CameraConfig = { fovDeg: 54, distance: 3.0, height: 1.6, lookAtHeight: 0.95 };

export const DEFAULTS: Config = {
  assetBase: 'auto',
  configUrl: 'auto',
  renderer: 'auto',
  camera: { ...camera, portrait: { ...camera }, portraitAspect: 0.8, maxWidthFraction: 0.9 },
  skybox: {
    panoHeight: 1.6,
    radius: 40,
    yawDeg: 0, // [калібрування]
    brightness: 1.25, // [калібрування]
    contrast: 0.9, // [калібрування]
    saturation: 0.8, // [калібрування]
    blurPx: 0,
  },
  soldier: {
    heightM: 1.85, // [калібрування] висота від підошви до верху шолома
    offsetPx: { x: 0, y: 0 },
    set: 'auto',
    previewFilter: { brightness: 1, contrast: 1, saturate: 1, sepia: 0, hueRotate: 0 },
  },
  shadow: {
    enabled: true,
    opacity: 1, // [калібрування]
    synthetic: true,
    syntheticOpacity: 0.35, // [калібрування]
    syntheticWidth: 0.9,
    syntheticHeight: 0.22,
  },
  rotation: {
    orbitDir: -1,
    dragSign: 1,
    degPerPxMouse: 0.45, // [калібрування]
    degPerPxTouch: 0.6, // [калібрування]
    decay: 4,
    stopSpeed: 5,
    snapRangeDeg: 20,
    snapMs: 350,
    keyStepDeg: 15,
    keyMs: 250,
    frontEps: 0.5,
    frameBlend: false,
    loop: 'infinite',
    inertia: true,
  },
  fade: { color: '#DFDFD5', top: 0.15, bottomStart: 0.8, bottomEnd: 0.86, overSoldier: false },
  ui: {
    viewButtons: true,
    viewAngles: { front: 0, left: 270, right: 90, back: 180 },
  },
  hotspots: {
    enabled: true,
    showDelayMs: 200,
    touchMarkers: true,
    hintPulse: true,
    debugAlways: false,
    debugOutlines: false,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function merge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Відносні шляхи в options рахуються від сторінки; 'auto' — від адреси модуля,
 * тож при вбудовуванні (Webflow) досить імпорту з хостингу ассетів.
 */
export async function resolveConfig(options: DeepPartial<Config> = {}, moduleUrl: string): Promise<Config> {
  const page = document.baseURI;
  const rawBase = options.assetBase ?? DEFAULTS.assetBase;
  const assetBase = new URL(rawBase === 'auto' ? './assets/' : rawBase, rawBase === 'auto' ? moduleUrl : page).href.replace(
    /\/?$/,
    '/',
  );
  const rawCfg = options.configUrl === undefined ? DEFAULTS.configUrl : options.configUrl;
  const configUrl = rawCfg === null ? null : new URL(rawCfg === 'auto' ? '../config.json' : rawCfg, rawCfg === 'auto' ? assetBase : page).href;
  let cfg = merge(clone(DEFAULTS), options);
  if (configUrl) {
    try {
      const res = await fetch(configUrl, { cache: 'no-cache', mode: 'cors' });
      if (res.ok) cfg = merge(merge(clone(DEFAULTS), await res.json()), options);
    } catch {
      /* config.json необов'язковий */
    }
  }
  cfg.assetBase = assetBase;
  cfg.configUrl = configUrl;
  return cfg;
}

/** Поля, які йдуть у config.json (без службових). */
export function exportable(cfg: Config) {
  const { assetBase: _a, configUrl: _c, renderer: _r, ...rest } = cfg;
  return rest;
}
