// Ввід: drag (Pointer Events), інерція, снеп до фронту, клавіатура.
// Нічого не анімується окремо: усе змінює лише θ через host.setTheta().
import type { Config } from './config';

export interface InputHost {
  getTheta(): number;
  setTheta(deg: number): void;
  /** Попросити Stage крутити rAF-цикл (tick) до завершення анімації. */
  wake(): void;
  onDragStart(): void;
  onTap(e: PointerEvent): void;
}

type Mode = 'idle' | 'pending' | 'drag' | 'inertia' | 'tween';

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export class Input {
  private mode: Mode = 'idle';
  private pointerId = -1;
  private pointerType = 'mouse';
  private sx = 0;
  private sy = 0;
  private lastX = 0;
  private samples: { t: number; theta: number }[] = [];
  private v = 0; // °/с
  private lastTick = 0;
  private tween = { from: 0, to: 0, t0: 0, ms: 0 };
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly el: HTMLElement,
    private cfg: Config,
    private readonly host: InputHost,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.off.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e, false));
    on('pointercancel', (e) => this.up(e, true));
    on('lostpointercapture', (e) => {
      // На тачі path під пальцем має неявне захоплення; коли ми переносимо його
      // на сцену, path отримує lostpointercapture, яка спливає сюди. Це не кінець drag.
      if (e.target === el && e.pointerId === this.pointerId && this.mode === 'drag') this.up(e, true);
    });
    on('keydown', (e) => this.key(e));
    const blur = () => {
      if (this.mode === 'pending') this.mode = 'idle';
      if (this.mode !== 'drag') return;
      this.el.classList.remove('sv-grabbing');
      this.pointerId = -1;
      this.v = 0;
      this.settle();
      this.host.wake();
    };
    window.addEventListener('blur', blur);
    this.off.push(() => window.removeEventListener('blur', blur));
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
  }

  /** Є рух (drag, інерція, твін) — зони неактивні. */
  get moving(): boolean {
    return this.mode === 'drag' || this.mode === 'inertia' || this.mode === 'tween';
  }

  get animating(): boolean {
    return this.mode === 'inertia' || this.mode === 'tween';
  }

  /** Ціль поточного твіну (null — твіну немає). */
  get tweenTarget(): number | null {
    return this.mode === 'tween' ? this.tween.to : null;
  }

  get direction(): number {
    return Math.sign(this.v) || 1;
  }

  private get instant() {
    return this.reduced.matches;
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.mode === 'drag' || this.mode === 'pending') return;
    // Хапання зупиняє інерцію і твін.
    this.mode = 'pending';
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.sx = this.lastX = e.clientX;
    this.sy = e.clientY;
    this.v = 0;
  }

  private move(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    // Загублений pointerup (відпускання поза вікном, втрата фокусу): кнопка вже не натиснута.
    if (e.pointerType === 'mouse' && e.buttons === 0) return this.up(e, this.mode === 'pending');
    if (this.mode === 'pending') {
      const dx = e.clientX - this.sx;
      const dy = e.clientY - this.sy;
      const thr = this.pointerType === 'mouse' ? 3 : 6;
      if (Math.abs(dx) < thr || Math.abs(dx) < Math.abs(dy)) return;
      this.mode = 'drag';
      this.lastX = this.sx;
      this.samples = [{ t: e.timeStamp, theta: this.host.getTheta() }];
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer вже неактивний */
      }
      this.el.classList.add('sv-grabbing');
      this.host.onDragStart();
    }
    if (this.mode !== 'drag') return;
    const k = this.pointerType === 'mouse' ? this.cfg.rotation.degPerPxMouse : this.cfg.rotation.degPerPxTouch;
    const theta = this.host.getTheta() + (e.clientX - this.lastX) * k * this.cfg.rotation.dragSign;
    this.lastX = e.clientX;
    this.host.setTheta(theta);
    this.samples.push({ t: e.timeStamp, theta: this.host.getTheta() });
    while (this.samples.length > 2 && e.timeStamp - this.samples[0].t > 80) this.samples.shift();
  }

  private up(e: PointerEvent, cancelled: boolean) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = -1;
    if (this.mode === 'pending') {
      this.mode = 'idle';
      if (!cancelled) this.host.onTap(e);
      return;
    }
    if (this.mode !== 'drag') return;
    this.el.classList.remove('sv-grabbing');
    const s = this.samples;
    const first = s[0];
    const last = s[s.length - 1];
    const dt = (last.t - first.t) / 1000;
    // Якщо палець стояв перед відпусканням — швидкість нульова.
    const stale = e.timeStamp - last.t > 100;
    this.v = dt > 0.008 && !stale ? (last.theta - first.theta) / dt : 0;
    this.mode = 'idle'; // до settle(): tweenTo() ігнорує виклики в режимі drag
    const r = this.cfg.rotation;
    if (r.inertia && !this.instant && Math.abs(this.v) > r.stopSpeed) {
      this.mode = 'inertia';
      this.lastTick = performance.now();
      this.host.wake();
    } else {
      this.settle();
    }
    this.host.wake();
  }

  private key(e: KeyboardEvent) {
    const r = this.cfg.rotation;
    let handled = true;
    if (e.key === 'ArrowLeft') this.tweenTo(this.target() - r.keyStepDeg, r.keyMs);
    else if (e.key === 'ArrowRight') this.tweenTo(this.target() + r.keyStepDeg, r.keyMs);
    else if (e.key === 'Home' || e.key === 'Escape') this.goFront(true);
    else handled = false;
    if (handled) e.preventDefault();
  }

  /** Під час твіну наступний крок клавіатури рахується від цілі, а не від поточного θ. */
  private target() {
    return this.mode === 'tween' ? this.tween.to : this.host.getTheta();
  }

  goFront(animate: boolean) {
    const th = this.target();
    this.tweenTo(Math.round(th / 360) * 360, animate ? this.cfg.rotation.snapMs : 0);
  }

  tweenTo(to: number, ms: number) {
    if (this.mode === 'drag') return;
    if (ms <= 0 || this.instant) {
      this.mode = 'idle';
      this.host.setTheta(to);
      this.host.wake();
      return;
    }
    this.tween = { from: this.host.getTheta(), to, t0: performance.now(), ms };
    this.mode = 'tween';
    this.host.wake();
  }

  stop() {
    if (this.animating) this.mode = 'idle';
    this.host.wake();
  }

  private settle() {
    const th = this.host.getTheta();
    const front = Math.round(th / 360) * 360;
    const d = Math.abs(th - front);
    if (d > 1e-6 && d <= this.cfg.rotation.snapRangeDeg) this.tweenTo(front, this.cfg.rotation.snapMs);
    else this.mode = 'idle';
  }

  /** Крок анімації; true — анімація триває. */
  tick(now: number): boolean {
    if (this.mode === 'inertia') {
      const dt = Math.min(0.05, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.host.setTheta(this.host.getTheta() + this.v * dt);
      this.v *= Math.exp(-this.cfg.rotation.decay * dt); // згасання за часом, не за кадрами
      if (Math.abs(this.v) < this.cfg.rotation.stopSpeed) this.settle();
    } else if (this.mode === 'tween') {
      const { from, to, t0, ms } = this.tween;
      const p = Math.min(1, (now - t0) / ms);
      this.host.setTheta(from + (to - from) * easeOutCubic(p));
      if (p >= 1) {
        this.mode = 'idle';
        this.host.setTheta(to);
      }
    }
    return this.animating;
  }

  destroy() {
    this.off.forEach((f) => f());
  }
}
