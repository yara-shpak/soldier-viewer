// Зони спорядження (inline SVG поверх солдата). Активні лише у фронтальному
// стані: θ біля 0/360 і немає drag, інерції чи твіну. Hover (миша), тап (тач),
// фокус (клавіатура) підсвічують усю групу і показують лейбл біля bbox зони.
import type { Config } from './config';
import type { SoldierRect } from './SoldierLayer';

export interface ZoneContent {
  key: string;
  title: string;
  description: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class Hotspots {
  readonly svg: SVGSVGElement;
  private readonly label = document.createElement('div');
  private readonly markers = document.createElement('div');
  private readonly groups = new Map<string, SVGGElement>();
  private readonly titles = new Map<string, string>();
  private readonly vb: { x: number; y: number; w: number; h: number };
  private rect: SoldierRect = { left: 0, top: 0, width: 0, height: 0, scale: 1 };
  private active = false;
  private hovered: string | null = null;
  private selected: string | null = null;
  private showTimer = 0;
  private pulsed = false;
  private markerPoints: { key: string; x: number; y: number }[] | null = null;
  private frontState = true;
  private readonly off: (() => void)[] = [];
  private readonly touch = matchMedia('(hover: none), (pointer: coarse)');
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly stageEl: HTMLElement,
    svgText: string,
    content: ZoneContent[],
    private cfg: Config,
    private readonly emit: (ev: 'zone:hover' | 'zone:select', key: string | null) => void,
  ) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement as unknown as SVGSVGElement;
    if (svg.nodeName !== 'svg') throw new Error('soldier-viewer: zones.svg не розібрано');
    this.svg = document.importNode(svg, true) as SVGSVGElement;
    this.svg.setAttribute('class', 'sv-zones');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('tabindex', '-1'); // Chrome інакше ставить сам <svg> у порядок Tab
    const [x, y, w, h] = (this.svg.getAttribute('viewBox') ?? '0 0 1 1').split(/[\s,]+/).map(Number);
    this.vb = { x, y, w, h };
    for (const c of content) this.titles.set(c.key, c.title);
    for (const g of this.svg.querySelectorAll<SVGGElement>('g[data-zone]')) {
      const key = g.dataset.zone!;
      this.groups.set(key, g);
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', this.titles.get(key) ?? key);
      g.removeAttribute('tabindex');
      g.style.color = g.dataset.color ?? '#fff'; // debug-контури: stroke = currentColor
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = this.titles.get(key) ?? key;
      g.prepend(t);
    }
    this.label.className = 'sv-zone-label';
    this.label.setAttribute('aria-hidden', 'true');
    this.markers.className = 'sv-zone-markers';
    stageEl.append(this.svg, this.markers, this.label);
    this.bind();
    this.applyConfig(cfg);
  }

  private bind() {
    const on = <K extends keyof SVGElementEventMap>(type: K, fn: (e: SVGElementEventMap[K]) => void) => {
      this.svg.addEventListener(type, fn as EventListener);
      this.off.push(() => this.svg.removeEventListener(type, fn as EventListener));
    };
    const zoneOf = (e: Event) => (e.target as Element).closest?.('g[data-zone]')?.getAttribute('data-zone') ?? null;
    on('pointerover', (e) => {
      if (e.pointerType === 'mouse' && this.active) this.setHover(zoneOf(e));
    });
    on('pointerout', (e) => {
      if (e.pointerType !== 'mouse') return;
      const to = (e.relatedTarget as Element | null)?.closest?.('g[data-zone]')?.getAttribute('data-zone') ?? null;
      if (to !== this.hovered) this.setHover(to);
    });
    on('focusin', (e) => {
      if (this.active) this.setHover(zoneOf(e));
    });
    on('focusout', () => this.setHover(null));
    on('keydown', (e) => {
      const key = zoneOf(e);
      if (key && this.active && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        this.select(key);
      }
    });
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
    const h = cfg.hotspots;
    this.svg.classList.toggle('sv-zones-outlines', h.debugOutlines);
    this.markers.style.display = h.touchMarkers && this.touch.matches ? '' : 'none';
    if (h.debugAlways) this.setActive(true, true);
    else if (!this.frontState) this.setActive(false, true);
  }

  /** Викликає Stage при вході у фронт / виході з нього (і при старті drag). */
  setFront(front: boolean) {
    this.frontState = front;
    if (this.cfg.hotspots.debugAlways) return;
    this.setActive(front, false);
  }

  private setActive(on: boolean, immediate: boolean) {
    clearTimeout(this.showTimer);
    if (!on) {
      // Миттєве приховування: на початку drag зони не повинні реагувати.
      this.active = false;
      this.stageEl.classList.remove('sv-zones-on');
      this.setHover(null);
      this.selected = null;
      this.paint();
      this.setTabbable(false);
      return;
    }
    const show = () => {
      if (!this.frontState && !this.cfg.hotspots.debugAlways) return;
      this.active = true;
      this.stageEl.classList.add('sv-zones-on');
      this.setTabbable(true);
      this.layoutMarkers();
      this.maybePulse();
    };
    if (immediate || this.reduced.matches) show();
    else this.showTimer = window.setTimeout(show, this.cfg.hotspots.showDelayMs);
  }

  private setTabbable(on: boolean) {
    for (const g of this.groups.values()) {
      if (on) g.setAttribute('tabindex', '0');
      else {
        g.removeAttribute('tabindex');
      g.style.color = g.dataset.color ?? '#fff'; // debug-контури: stroke = currentColor
        if (g.contains(document.activeElement)) this.stageEl.focus({ preventScroll: true });
      }
    }
  }

  private maybePulse() {
    if (this.pulsed || !this.cfg.hotspots.hintPulse || this.touch.matches || this.reduced.matches) return;
    this.pulsed = true;
    this.svg.classList.add('sv-zones-pulse');
    window.setTimeout(() => this.svg.classList.remove('sv-zones-pulse'), 1600);
  }

  /** Тап/клік без drag (від Input через Stage). */
  tap(e: PointerEvent) {
    if (!this.active) return;
    // Зона — за координатами, а не за e.target: Firefox для тач-подій перенаправляє
    // ціль на найближчий «клікабельний» предок (event radius), тобто на саму сцену.
    const hit = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element);
    const key = hit.closest?.('g[data-zone]')?.getAttribute('data-zone') ?? null;
    if (key) this.select(key);
    else if (this.selected) {
      this.selected = null;
      this.paint();
    }
  }

  select(key: string) {
    this.selected = key;
    this.paint();
    this.emit('zone:select', key);
  }

  /** Скасування вибору (тап поза зонами, початок drag). */
  clear() {
    this.selected = null;
    this.setHover(null);
  }

  private setHover(key: string | null) {
    if (key === this.hovered) return;
    this.hovered = key;
    this.paint();
    this.emit('zone:hover', key);
  }

  private paint() {
    const current = this.hovered ?? this.selected;
    for (const [k, g] of this.groups) g.classList.toggle('sv-zone-active', k === current && this.active);
    if (!current || !this.active) {
      this.label.classList.remove('sv-visible');
      return;
    }
    this.label.textContent = this.titles.get(current) ?? current;
    this.placeLabel(current);
    this.label.classList.add('sv-visible');
  }

  /** bbox групи (координати SVG) → CSS-пікселі сцени. */
  private zoneBox(key: string) {
    const b = this.groups.get(key)!.getBBox();
    const sx = this.rect.width / this.vb.w;
    const sy = this.rect.height / this.vb.h;
    return {
      left: this.rect.left + (b.x - this.vb.x) * sx,
      top: this.rect.top + (b.y - this.vb.y) * sy,
      width: b.width * sx,
      height: b.height * sy,
    };
  }

  /** Лейбл прив'язаний до bbox зони: праворуч, а якщо не влазить — ліворуч. */
  private placeLabel(key: string) {
    const z = this.zoneBox(key);
    const W = this.stageEl.clientWidth;
    const H = this.stageEl.clientHeight;
    const gap = 12;
    const lw = this.label.offsetWidth;
    const lh = this.label.offsetHeight;
    let x = z.left + z.width + gap;
    let side = 'right';
    if (x + lw > W - 8) {
      x = z.left - gap - lw;
      side = 'left';
    }
    if (x < 8) {
      // Ні праворуч, ні ліворуч: над зоною по центру.
      x = Math.min(Math.max(8, z.left + z.width / 2 - lw / 2), W - lw - 8);
      side = 'top';
    }
    let y = side === 'top' ? z.top - lh - gap : z.top + z.height / 2 - lh / 2;
    y = Math.min(Math.max(8, y), H - lh - 8);
    this.label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.label.dataset.side = side;
  }

  layout(rect: SoldierRect) {
    this.rect = rect;
    const s = this.svg.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.layoutMarkers();
    this.paint();
  }

  /** Маркери для тач-пристроїв: точка всередині зони, найближча до центру мас її вибірки. */
  private layoutMarkers() {
    if (!this.cfg.hotspots.touchMarkers || !this.touch.matches || !this.rect.width) return;
    if (!this.markerPoints) {
      this.markerPoints = [];
      const pt = this.svg.createSVGPoint();
      const order = [...this.groups.values()];
      for (const [key, g] of this.groups) {
        // Зони, намальовані вище (дрібніші), перекривають цю — маркер не ставимо під ними.
        const above = order.slice(order.indexOf(g) + 1).flatMap((o) => [...o.querySelectorAll('path')]);
        // Один маркер на зону: у найбільшому path групи (для пар — одна з половин).
        const paths = [...g.querySelectorAll('path')];
        const p = paths.reduce((a, q) => {
          const ba = a.getBBox();
          const bq = q.getBBox();
          return bq.width * bq.height > ba.width * ba.height ? q : a;
        });
        const b = p.getBBox();
        const inside: [number, number][] = [];
        for (let i = 0; i < 14; i++)
          for (let j = 0; j < 14; j++) {
            pt.x = b.x + ((i + 0.5) / 14) * b.width;
            pt.y = b.y + ((j + 0.5) / 14) * b.height;
            if (p.isPointInFill(pt) && !above.some((q) => q.isPointInFill(pt))) inside.push([pt.x, pt.y]);
          }
        if (!inside.length) continue;
        const mx = inside.reduce((a, q) => a + q[0], 0) / inside.length;
        const my = inside.reduce((a, q) => a + q[1], 0) / inside.length;
        const best = inside.reduce((a, q) => ((q[0] - mx) ** 2 + (q[1] - my) ** 2 < (a[0] - mx) ** 2 + (a[1] - my) ** 2 ? q : a));
        this.markerPoints.push({ key, x: best[0], y: best[1] });
      }
    }
    const sx = this.rect.width / this.vb.w;
    const sy = this.rect.height / this.vb.h;
    this.markers.replaceChildren(
      ...this.markerPoints.map((m) => {
        const d = document.createElement('span');
        d.className = 'sv-zone-marker';
        d.dataset.zone = m.key;
        d.style.left = `${this.rect.left + (m.x - this.vb.x) * sx}px`;
        d.style.top = `${this.rect.top + (m.y - this.vb.y) * sy}px`;
        return d;
      }),
    );
  }

  destroy() {
    clearTimeout(this.showTimer);
    this.off.forEach((f) => f());
    this.svg.remove();
    this.label.remove();
    this.markers.remove();
  }
}
