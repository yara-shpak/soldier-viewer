// UI-шар: підказка жесту (7.8) і кнопки ракурсів (фронт / зліва / справа / позаду).
// Кнопки стоять рядком під ступнями, підказка — між ступнями і кнопками.

const HINT_KEY = 'soldier-viewer:hint-dismissed';

const ARROWS = `<svg viewBox="0 0 48 24" width="40" height="20" aria-hidden="true" focusable="false">
<path d="M3 12h42M3 12l7-7M3 12l7 7M45 12l-7-7M45 12l-7 7" fill="none" stroke="currentColor" stroke-width="2.5"
stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export type ViewKey = 'front' | 'left' | 'right' | 'back';

/**
 * Іконка — вид згори: коло — солдат, «ніс» — куди він дивиться, глядач унизу.
 * Фронт — ніс до глядача; справа (бачимо праве плече) — солдат дивиться вправо екрана.
 */
const FACING: Record<ViewKey, number> = { front: 90, right: 0, back: -90, left: 180 };

function viewIcon(key: ViewKey): string {
  const a = (FACING[key] * Math.PI) / 180;
  const cx = 12;
  const cy = 11;
  const tip = [cx + Math.cos(a) * 9.5, cy + Math.sin(a) * 9.5];
  const l = [cx + Math.cos(a + 0.55) * 5.6, cy + Math.sin(a + 0.55) * 5.6];
  const r = [cx + Math.cos(a - 0.55) * 5.6, cy + Math.sin(a - 0.55) * 5.6];
  const f = (p: number[]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
<path d="M${f(l)}L${f(tip)}L${f(r)}Z" fill="currentColor"/>
<circle cx="${cx}" cy="${cy}" r="5.2" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M5 22h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".45"/></svg>`;
}

const LABELS: Record<ViewKey, string> = { front: 'Фронтально', left: 'Зліва', right: 'Справа', back: 'Позаду' };
const ARIA: Record<ViewKey, string> = {
  front: 'Повернути солдата фронтом',
  left: 'Показати солдата зліва',
  right: 'Показати солдата справа',
  back: 'Показати солдата позаду',
};
const ORDER: ViewKey[] = ['front', 'left', 'right', 'back'];

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class UI {
  readonly hint = document.createElement('div');
  readonly views = document.createElement('div');
  private readonly buttons = new Map<ViewKey, HTMLButtonElement>();
  private hintDismissed: boolean;
  private ready = false;

  constructor(
    root: HTMLElement,
    private readonly onView: (key: ViewKey) => void,
  ) {
    this.hint.className = 'sv-hint';
    this.hint.setAttribute('aria-hidden', 'true');
    this.hint.innerHTML = `${ARROWS}<span>Потягніть, щоб обернути</span>`;

    this.views.className = 'sv-views';
    this.views.setAttribute('role', 'group');
    this.views.setAttribute('aria-label', 'Ракурс');
    // Кнопки не повинні запускати drag сцени чи вибір зони.
    this.views.addEventListener('pointerdown', (e) => e.stopPropagation());
    for (const key of ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sv-view-btn';
      b.dataset.view = key;
      b.setAttribute('aria-label', ARIA[key]);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `${viewIcon(key)}<span>${LABELS[key]}</span>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onView(key);
      });
      this.buttons.set(key, b);
      this.views.appendChild(b);
    }

    let dismissed = false;
    try {
      dismissed = storage()?.getItem(HINT_KEY) === '1';
    } catch {
      /* приватний режим */
    }
    this.hintDismissed = dismissed;
    root.append(this.hint, this.views);
  }

  /** Після ready: показати підказку (якщо її ще не закривали) і кнопки. */
  showHint() {
    this.ready = true;
    this.views.classList.add('sv-visible');
    if (!this.hintDismissed) this.hint.classList.add('sv-visible');
  }

  /** Перший drag: сховати підказку назавжди. */
  dismissHint() {
    if (this.hintDismissed) return;
    this.hintDismissed = true;
    this.hint.classList.remove('sv-visible');
    try {
      storage()?.setItem(HINT_KEY, '1');
    } catch {
      /* приватний режим */
    }
  }

  /** active — ракурс, на якому солдат стоїть (або до якого їде твін); null — проміжний кут. */
  update(state: { front: boolean; active: ViewKey | null }) {
    for (const [key, b] of this.buttons) {
      const on = key === state.active;
      b.classList.toggle('sv-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.hint.classList.toggle('sv-visible', this.ready && !this.hintDismissed && state.front);
  }

  /** Кнопки — рядком під ступнями; підказка — між ступнями і кнопками. */
  layout(feet: { x: number; y: number }, stageW: number, stageH: number) {
    const vh = this.views.offsetHeight || 52;
    const vw = this.views.offsetWidth || 320;
    const rowTop = Math.max(feet.y + 24, Math.min(feet.y + 88, stageH - vh - 14));
    const x = Math.min(Math.max(feet.x, vw / 2 + 8), stageW - vw / 2 - 8);
    this.views.style.left = `${x}px`;
    this.views.style.top = `${rowTop}px`;
    const hh = this.hint.offsetHeight || 40;
    this.hint.style.left = `${feet.x}px`;
    this.hint.style.top = `${Math.max(feet.y + 6, rowTop - hh - 6)}px`;
  }

  destroy() {
    this.hint.remove();
    this.views.remove();
  }
}
