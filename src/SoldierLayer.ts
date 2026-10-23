// Солдат як 2D-шар: камера завжди на тій самій відстані й дивиться в ту саму
// точку, тож проєкція солдата незмінна і 2D-шар еквівалентний білборду.
// Порядок малювання: синтетична тінь → витягнута тінь → солдат.
import type { Config } from './config';
import type { Manifest } from './manifest';

export interface SoldierRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** CSS px на піксель кадру джерела. */
  scale: number;
}

export class SoldierLayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private rect: SoldierRect = { left: 0, top: 0, width: 0, height: 0, scale: 1 };
  private dpr = 1;

  constructor(
    private cfg: Config,
    private readonly manifest: Manifest,
  ) {
    this.canvas.className = 'sv-soldier';
    this.ctx = this.canvas.getContext('2d')!;
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
    const f = cfg.soldier.previewFilter;
    const neutral = f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && !f.sepia && !f.hueRotate;
    // Лише debug-превʼю: фінальне тонування запікається пайплайном (export.tone).
    this.canvas.style.filter = neutral
      ? ''
      : `brightness(${f.brightness}) contrast(${f.contrast}) saturate(${f.saturate}) sepia(${f.sepia}) hue-rotate(${f.hueRotate}deg)`;
  }

  layout(rect: SoldierRect) {
    this.rect = rect;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = this.canvas.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  get box(): SoldierRect {
    return this.rect;
  }

  draw(
    soldier: HTMLImageElement | null,
    shadow: HTMLImageElement | null,
    blend?: { img: HTMLImageElement | null; t: number },
  ) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const k = W / this.manifest.crop.width; // canvas px на піксель кропу
    const sh = this.cfg.shadow;

    if (sh.synthetic && sh.syntheticOpacity > 0) {
      const fw = this.manifest.frontWidth.source * k;
      const rx = (sh.syntheticWidth * fw) / 2;
      const ry = (sh.syntheticHeight * fw) / 2;
      const a = this.manifest.anchor.crop;
      ctx.save();
      ctx.translate(a.x * k, a.y * k);
      ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(0,0,0,${sh.syntheticOpacity})`);
      g.addColorStop(0.55, `rgba(0,0,0,${sh.syntheticOpacity * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (sh.enabled && shadow && sh.opacity > 0) {
      ctx.globalAlpha = Math.min(1, sh.opacity);
      ctx.drawImage(shadow, 0, 0, W, H); // половинна роздільність ×2 зі згладжуванням
      ctx.globalAlpha = 1;
    }
    if (soldier) ctx.drawImage(soldier, 0, 0, W, H);
    if (blend?.img && blend.t > 0) {
      ctx.globalAlpha = blend.t;
      ctx.drawImage(blend.img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
}
