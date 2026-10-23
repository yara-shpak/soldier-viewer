// Типи public/assets/manifest.json (генерується pipeline/steps/export.py і pano.py).

interface FrameSet {
  path: string; // шаблон з {index}
  width: number;
  height: number;
}

interface PanoVariant {
  width: number;
  height: number;
  blur: Record<string, string>;
}

export interface Manifest {
  version: number;
  frameCount: number;
  indexPad: number;
  source: { width: number; height: number; fps: number };
  crop: { x: number; y: number; width: number; height: number };
  sets: { full: FrameSet; half: FrameSet };
  shadow: FrameSet;
  anchor: { source: { x: number; y: number }; crop: { x: number; y: number } };
  headTopY: { source: number; crop: number };
  frontWidth: { source: number };
  svgScale: number;
  angles: string;
  zones: { svg: string; content: string };
  pano: {
    dir: string;
    variants: { pano_4096: PanoVariant; pano_preview: PanoVariant; pano_8192?: PanoVariant };
    upscaledSource: boolean;
  };
}

export function frameUrls(base: string, set: FrameSet, count: number, pad: number): string[] {
  return Array.from({ length: count }, (_, i) => base + set.path.replace('{index}', String(i).padStart(pad, '0')));
}
