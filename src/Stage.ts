// Сцена — функція одного кута θ: кадр солдата (через angles.json), позиція
// камери на орбіті і стан «фронт». Рендер лише на вимогу; rAF-цикл активний
// тільки під час drag, інерції або твіну.
import { AngleMap, normDeg, type AnglesData } from './angleMap';
import { Background } from './Background';
import { BackgroundFallback } from './BackgroundFallback';
import { exportable, type CameraConfig, type Config } from './config';
import { FrameStore } from './FrameStore';
import { Hotspots, type ZoneContent } from './Hotspots';
import { Input } from './Input';
import { frameUrls, type Manifest } from './manifest';
import { SoldierLayer, type SoldierRect } from './SoldierLayer';
import { UI, type ViewKey } from './UI';

export type ViewerEvent = 'ready' | 'anglechange' | 'front:enter' | 'front:leave' | 'zone:hover' | 'zone:select';

export interface RenderInfo {
  theta: number;
  thetaN: number;
  frame: number;
  frameAngle: number;
  phiDeg: number;
  front: boolean;
  feet: { x: number; y: number };
  rect: SoldierRect;
  fovDeg: number;
}

export class Stage {
  readonly root = document.createElement('div');
  readonly bg: Background | BackgroundFallback;
  readonly soldier: SoldierLayer;
  readonly ui: UI;
  readonly input: Input;
  readonly angles: AngleMap;
  private readonly fade = document.createElement('div');
  private readonly loader = document.createElement('div');
  hotspots: Hotspots | null = null;
  private frames!: FrameStore;
  private shadows!: FrameStore;
  private theta = 0;
  private raf = 0;
  private front = true;
  private feet = { x: 0, y: 0 };
  private fovDeg = 54;
  private size = { w: 0, h: 0 };
  private readonly ro: ResizeObserver;
  private readonly listeners = new Map<ViewerEvent, Set<(p?: unknown) => void>>();
  private lastIndex = 0;
  private lastEmitted = Number.NaN;
  /** debug-хук: викликається після кожного рендера. */
  onRender: ((info: RenderInfo) => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    public cfg: Config,
    readonly manifest: Manifest,
    anglesData: AnglesData,
  ) {
    this.angles = new AngleMap(anglesData);
    const r = this.root;
    r.className = 'sv-stage sv-front';
    r.tabIndex = 0;
    r.setAttribute('role', 'application');
    r.setAttribute('aria-roledescription', '360° переглядач');
    r.setAttribute('aria-label', 'Солдат у спорядженні, 360°. Потягніть або натисніть ← / → щоб обернути, Home — до фронту.');

    this.fade.className = 'sv-fade';
    this.loader.className = 'sv-loader';
    this.loader.innerHTML = '<div class="sv-loader-bar"></div>';
    this.bg = this.createBackground();
    r.classList.toggle('sv-fallback', this.bg instanceof BackgroundFallback);
    this.soldier = new SoldierLayer(cfg, manifest);
    r.append(this.bg.el, this.fade, this.soldier.canvas, this.loader);
    this.ui = new UI(r, (key) => this.goToView(key));
    container.appendChild(r);

    this.input = new Input(r, cfg, {
      getTheta: () => this.theta,
      setTheta: (d) => this.setTheta(d),
      wake: () => this.invalidate(),
      onDragStart: () => {
        this.hotspots?.clear();
        this.ui.dismissHint();
        this.updateFront();
      },
      onTap: (e) => this.hotspots?.tap(e),
    });
    this.applyConfig(cfg);
    this.ro = new ResizeObserver(() => this.layout());
  }

  private createBackground(): Background | BackgroundFallback {
    const onChange = () => this.invalidate();
    const want = this.cfg.renderer;
    if (want !== '2d' && (want === 'webgl' || Background.supported())) {
      try {
        const canvas = document.createElement('canvas');
        canvas.className = 'sv-bg';
        return new Background(canvas, this.cfg, this.manifest, onChange);
      } catch {
        /* контекст не створився — fallback */
      }
    }
    return new BackgroundFallback(this.cfg, this.manifest, onChange);
  }

  async init(): Promise<void> {
    const m = this.manifest;
    const base = this.cfg.assetBase;
    this.layoutSize();
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const set =
      this.cfg.soldier.set !== 'auto'
        ? this.cfg.soldier.set
        : Math.min(this.size.w, this.size.h) < 500 || conn?.saveData
          ? 'half'
          : 'full';
    const n = this.angles.count;
    const onLoad = (i: number) => {
      this.updateLoader();
      if (i === this.lastIndex || !this.frames?.has(this.lastIndex)) this.invalidate();
    };
    this.frames = new FrameStore(frameUrls(base, m.sets[set], n, m.indexPad), onLoad);
    this.shadows = new FrameStore(frameUrls(base, m.shadow, n, m.indexPad), onLoad, 2);
    this.root.dataset.set = set;
    const zones = this.cfg.hotspots.enabled ? this.loadZones() : Promise.resolve();
    await Promise.all([this.bg.load(), this.frames.start(), this.shadows.start(), zones]);
    this.layout();
    this.ro.observe(this.container);
    this.ui.showHint();
    this.emit('ready');
    // Після першого показу: повна панорама і решта кадрів.
    this.bg.reloadFull();
    this.frames.loadRest();
    this.shadows.loadRest();
  }

  private async loadZones() {
    const base = this.cfg.assetBase;
    const [svg, content] = await Promise.all([
      fetch(base + this.manifest.zones.svg, { mode: 'cors' }).then((r) => r.text()),
      fetch(base + this.manifest.zones.content, { mode: 'cors' }).then((r) => r.json() as Promise<ZoneContent[]>),
    ]);
    this.hotspots = new Hotspots(this.root, svg, content, this.cfg, (ev, key) => this.emit(ev, key));
    this.hotspots.setFront(this.front);
  }

  // ---------- події ----------
  on(ev: ViewerEvent, cb: (p?: unknown) => void): () => void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(cb);
    return () => this.listeners.get(ev)?.delete(cb);
  }

  emit(ev: ViewerEvent, payload?: unknown) {
    this.listeners.get(ev)?.forEach((cb) => cb(payload));
  }

  // ---------- стан ----------
  getTheta() {
    return this.theta;
  }

  setTheta(deg: number) {
    if (this.cfg.rotation.loop === 'clamped') deg = Math.min(360, Math.max(0, deg));
    if (deg === this.theta) return;
    this.theta = deg;
    this.invalidate();
  }

  setAngle(deg: number, animate = false) {
    if (animate) this.input.tweenTo(deg, this.cfg.rotation.snapMs);
    else {
      this.input.stop();
      this.setTheta(deg);
    }
  }

  /** Кнопки ракурсів: поворот найкоротшим шляхом, тривалість — за величиною повороту. */
  goToView(key: ViewKey) {
    const target = this.cfg.ui.viewAngles[key];
    const cur = this.theta;
    let to: number;
    if (this.cfg.rotation.loop === 'clamped') {
      to = key === 'front' ? (cur > 180 ? 360 : 0) : normDeg(target);
    } else {
      let d = normDeg(target - normDeg(cur)); // 0…360
      if (d > 180) d -= 360; // найкоротший шлях; 180° — за годинниковою
      to = cur + d;
    }
    const ms = Math.round(300 + (Math.abs(to - cur) / 180) * 450);
    if (Math.abs(to - cur) < 1e-6) return;
    this.input.tweenTo(to, ms);
  }

  /** Ракурс, на якому стоїть сцена (±1°), або до якого їде твін. */
  private activeView(): ViewKey | null {
    const t = this.input.tweenTarget;
    const at = normDeg(t ?? this.theta);
    if (t === null && this.input.moving) return null;
    const v = this.cfg.ui.viewAngles;
    for (const key of ['front', 'left', 'right', 'back'] as ViewKey[]) {
      const d = Math.abs(normDeg(at - v[key] + 180) - 180);
      if (d <= 1) return key;
    }
    return null;
  }

  /** Поточний конфіг для public/config.json (debug «Copy config»). */
  exportConfig() {
    return exportable(this.cfg);
  }

  goFront(animate = true) {
    this.input.goFront(animate);
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
    this.root.style.setProperty('--sv-bg', cfg.fade.color);
    const f = cfg.fade;
    this.fade.style.background = `linear-gradient(to bottom, ${f.color} 0%, transparent ${f.top * 100}%, transparent ${
      f.bottomStart * 100
    }%, ${f.color} ${f.bottomEnd * 100}%, ${f.color} 100%)`;
    this.fade.style.zIndex = f.overSoldier ? '4' : '2';
    this.ui?.views.classList.toggle('sv-hidden', !cfg.ui.viewButtons);
    this.bg.applyConfig(cfg);
    this.soldier.applyConfig(cfg);
    this.input.applyConfig(cfg);
    this.hotspots?.applyConfig(cfg);
    if (this.size.w) this.layout();
  }

  // ---------- розкладка ----------
  private layoutSize() {
    const w = this.root.clientWidth || this.container.clientWidth;
    const h = this.root.clientHeight || this.container.clientHeight;
    this.size = { w: Math.max(1, w), h: Math.max(1, h) };
  }

  private cameraFor(aspect: number): CameraConfig {
    const c = this.cfg.camera;
    const src = aspect < c.portraitAspect ? c.portrait : c;
    return { fovDeg: src.fovDeg, distance: src.distance, height: src.height, lookAtHeight: src.lookAtHeight };
  }

  /** 6.4: ноги прибиті до підлоги. Перераховується лише при resize/зміні конфігу. */
  layout() {
    this.layoutSize();
    const { w, h } = this.size;
    const cam = this.cameraFor(w / h);
    const m = this.manifest;
    const srcH = m.anchor.source.y - m.headTopY.source;
    let rect: SoldierRect = { left: 0, top: 0, width: 0, height: 0, scale: 1 };
    // Ширина солдата у фронті ≤ maxWidthFraction ширини сцени, інакше ширший FOV.
    for (let iter = 0; iter < 3; iter++) {
      this.bg.resize(w, h, cam);
      this.bg.setAngle(normDeg(this.theta));
      const feet = this.bg.project(0, 0, 0, w, h);
      const head = this.bg.project(0, this.cfg.soldier.heightM, 0, w, h);
      const scale = (feet.y - head.y) / srcH;
      const off = this.cfg.soldier.offsetPx;
      rect = {
        left: feet.x - m.anchor.crop.x * scale + off.x,
        top: feet.y - m.anchor.crop.y * scale + off.y,
        width: m.crop.width * scale,
        height: m.crop.height * scale,
        scale,
      };
      this.feet = { x: feet.x + off.x, y: feet.y + off.y };
      const k = (m.frontWidth.source * scale) / (this.cfg.camera.maxWidthFraction * w);
      if (k <= 1.001) break;
      const t = Math.tan((cam.fovDeg * Math.PI) / 360) * k;
      cam.fovDeg = (Math.atan(t) * 360) / Math.PI;
    }
    this.fovDeg = cam.fovDeg;
    this.soldier.layout(rect);
    this.hotspots?.layout(rect);
    this.ui.layout(this.feet, w, h);
    this.render();
  }

  // ---------- рендер ----------
  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    const animating = this.input.tick(now);
    this.render();
    if (animating) this.invalidate();
  }

  private isFrontAngle(thetaN: number) {
    const e = this.cfg.rotation.frontEps;
    return thetaN <= e || thetaN >= 360 - e;
  }

  private updateFront() {
    const front = !this.input.moving && this.isFrontAngle(normDeg(this.theta));
    this.ui.update({ front, active: this.activeView() });
    if (front === this.front) return;
    this.front = front;
    this.root.classList.toggle('sv-front', front);
    this.hotspots?.setFront(front);
    this.emit(front ? 'front:enter' : 'front:leave');
  }

  render() {
    if (!this.frames) return;
    const thetaN = normDeg(this.theta);
    this.updateFront();
    const pick = this.angles.pick(thetaN);
    // У фронтальному стані завжди кадр 0: саме з ним вирівняні зони.
    const index = this.isFrontAngle(thetaN) ? 0 : pick.index;
    const dir = Math.sign(index - this.lastIndex) || this.input.direction;
    this.lastIndex = index;

    this.bg.setAngle(thetaN);
    this.bg.render();
    let blend: { img: HTMLImageElement | null; t: number } | undefined;
    let base = index;
    if (this.cfg.rotation.frameBlend && index !== 0) {
      base = pick.a;
      blend = { img: this.frames.has(pick.b) ? this.frames.get(pick.b) : null, t: pick.t };
    }
    this.soldier.draw(this.frames.get(base), this.shadows.get(base), blend);
    this.frames.prefetch(index, dir);
    if (this.theta !== this.lastEmitted) {
      this.lastEmitted = this.theta;
      this.emit('anglechange', this.theta);
    }
    this.onRender?.({
      theta: this.theta,
      thetaN,
      frame: index,
      frameAngle: this.angles.angleOf(index),
      phiDeg: this.cfg.rotation.orbitDir * thetaN,
      front: this.front,
      feet: this.feet,
      rect: this.soldier.box,
      fovDeg: this.fovDeg,
    });
  }

  private updateLoader() {
    const p = Math.min(this.frames?.progress ?? 0, this.shadows?.progress ?? 0);
    (this.loader.firstChild as HTMLElement).style.transform = `scaleX(${p})`;
    if (p >= 1) this.loader.classList.add('sv-done');
  }

  get loadProgress() {
    return Math.min(this.frames?.progress ?? 0, this.shadows?.progress ?? 0);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.input.destroy();
    this.hotspots?.destroy();
    this.ui.destroy();
    this.frames?.destroy();
    this.shadows?.destroy();
    this.bg.destroy();
    this.listeners.clear();
    this.root.remove();
  }
}
