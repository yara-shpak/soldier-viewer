// Публічне API: const viewer = await createSoldierViewer(container, options)
import type { AnglesData } from './angleMap';
import { resolveConfig, type Config, type DeepPartial } from './config';
import type { Manifest } from './manifest';
import { Stage, type ViewerEvent } from './Stage';
import type { ViewKey } from './UI';
import css from './styles.css?inline';

export type { Config, ViewerEvent, ViewKey };

export interface SoldierViewer {
  setAngle(deg: number, opts?: { animate?: boolean }): void;
  goFront(opts?: { animate?: boolean }): void;
  /** Ракурс як у кнопок: 'front' | 'left' | 'right' | 'back' (найкоротшим шляхом, з анімацією). */
  setView(view: ViewKey): void;
  getAngle(): number;
  on(event: ViewerEvent, cb: (payload?: unknown) => void): () => void;
  destroy(): void;
  readonly stage: Stage;
}

export interface ViewerOptions extends DeepPartial<Config> {
  debug?: boolean;
}

function injectStyles() {
  if (document.getElementById('sv-styles')) return;
  const style = document.createElement('style');
  style.id = 'sv-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { mode: 'cors' }).catch(() => {
    throw new Error(`soldier-viewer: не вдалося завантажити ${url} (мережа або немає CORS на хостингу ассетів)`);
  });
  if (!res.ok) throw new Error(`soldier-viewer: ${res.status} ${url}`);
  return res.json();
}

export async function createSoldierViewer(container: HTMLElement, options: ViewerOptions = {}): Promise<SoldierViewer> {
  injectStyles();
  const { debug: debugOpt, ...rest } = options;
  const cfg = await resolveConfig(rest, import.meta.url);
  const manifest = await json<Manifest>(cfg.assetBase + 'manifest.json');
  const angles = await json<AnglesData>(cfg.assetBase + manifest.angles);
  const stage = new Stage(container, cfg, manifest, angles);
  const debug = debugOpt ?? new URLSearchParams(location.search).get('debug') === '1';
  let disposeDebug: (() => void) | null = null;
  try {
    if (debug) {
      // Динамічний імпорт: lil-gui не потрапляє в основний модуль.
      const mod = await import('./debug');
      disposeDebug = mod.attachDebug(stage);
    }
    await stage.init();
  } catch (e) {
    // Напр., панорама з іншого домену без CORS: не лишаємо напівготову сцену.
    disposeDebug?.();
    stage.destroy();
    throw e;
  }

  return {
    stage,
    setAngle: (deg, opts) => stage.setAngle(deg, opts?.animate ?? false),
    goFront: (opts) => stage.goFront(opts?.animate ?? true),
    setView: (view) => stage.goToView(view),
    getAngle: () => stage.getTheta(),
    on: (ev, cb) => stage.on(ev, cb),
    destroy: () => {
      disposeDebug?.();
      stage.destroy();
    },
  };
}
