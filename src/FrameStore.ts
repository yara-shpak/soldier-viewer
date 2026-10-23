// Секвенція кадрів як HTMLImageElement (не ImageBitmap: 145 декодованих кадрів
// ≈ 270 МБ, на iOS це падіння вкладки). Порядок завантаження: 0, кожен 8-й,
// 4-й, 2-й, решта. Поки потрібного кадру немає — найближчий завантажений.

export class FrameStore {
  readonly count: number;
  private readonly imgs: (HTMLImageElement | null)[];
  private readonly urls: string[];
  private loadedCount = 0;
  private aborted = false;
  private decodeCenter = -1;
  private queue: number[] = [];

  constructor(
    urls: string[],
    private readonly onLoad: (index: number) => void,
    private readonly concurrency = 6,
  ) {
    this.urls = urls;
    this.count = urls.length;
    this.imgs = new Array(this.count).fill(null);
  }

  static order(count: number): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const step of [count, 8, 4, 2, 1]) {
      for (let i = 0; i < count; i += step) {
        if (!seen.has(i)) {
          seen.add(i);
          out.push(i);
        }
      }
    }
    return out;
  }

  get progress(): number {
    return this.loadedCount / this.count;
  }

  /** Завантажує лише кадр 0 (до першого показу). */
  async start(): Promise<void> {
    this.queue = FrameStore.order(this.count);
    await this.load(this.queue.shift()!);
  }

  /** Решта кадрів у фоні — після першого показу, щоб не конкурувати за мережу. */
  loadRest() {
    const worker = async () => {
      while (this.queue.length && !this.aborted) await this.load(this.queue.shift()!).catch(() => {});
    };
    for (let k = 0; k < this.concurrency; k++) void worker();
  }

  private load(i: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (this.aborted) return resolve();
        this.imgs[i] = img;
        this.loadedCount++;
        this.onLoad(i);
        resolve();
      };
      img.onerror = () => reject(new Error(`frame ${i}: ${this.urls[i]}`));
      img.src = this.urls[i];
    });
  }

  has(i: number): boolean {
    return this.imgs[i] !== null;
  }

  /** Кадр i або найближчий завантажений (циклічно). */
  get(i: number): HTMLImageElement | null {
    if (this.imgs[i]) return this.imgs[i];
    for (let d = 1; d <= this.count >> 1; d++) {
      const a = this.imgs[(i + d) % this.count];
      if (a) return a;
      const b = this.imgs[(i - d + this.count) % this.count];
      if (b) return b;
    }
    return null;
  }

  /** Ковзне вікно попереднього декодування ±radius у напрямку руху. */
  prefetch(center: number, dir: number, radius = 12) {
    if (center === this.decodeCenter) return;
    this.decodeCenter = center;
    const s = dir >= 0 ? 1 : -1;
    for (let d = 1; d <= radius; d++) {
      const img = this.imgs[(((center + s * d) % this.count) + this.count) % this.count];
      if (img) img.decode().catch(() => {});
    }
  }

  destroy() {
    this.aborted = true;
    for (const img of this.imgs) if (img) img.src = '';
    this.imgs.fill(null);
  }
}
