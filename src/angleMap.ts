// Таблиця «кадр → кут» (angles.json): кут θn ∈ [0, 360) → індекс кадру.

export interface AnglesData {
  frameCount: number;
  anglesDeg: number[];
  keyframes: Record<string, number>;
  seamJumpDeg: number;
  indexIncreases: string;
}

export interface FramePick {
  /** Найближчий кадр. */
  index: number;
  /** Пара сусідніх кадрів і вага другого — для rotation.frameBlend. */
  a: number;
  b: number;
  t: number;
}

export const normDeg = (deg: number) => ((deg % 360) + 360) % 360;

export class AngleMap {
  readonly count: number;
  private readonly angles: number[];

  constructor(data: AnglesData) {
    this.count = data.frameCount;
    // Кут 360 = кадр 0: замикаємо таблицю для бінарного пошуку.
    this.angles = [...data.anglesDeg.slice(0, this.count), 360];
  }

  angleOf(index: number): number {
    return this.angles[index];
  }

  pick(thetaN: number): FramePick {
    const a = this.angles;
    let lo = 0;
    let hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= thetaN) lo = mid;
      else hi = mid;
    }
    const t = (thetaN - a[lo]) / (a[hi] - a[lo] || 1);
    const wrap = (i: number) => (i >= this.count ? 0 : i);
    return { index: wrap(t < 0.5 ? lo : hi), a: wrap(lo), b: wrap(hi), t };
  }
}
