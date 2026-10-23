// Фон: еквіректангулярна панорама на GroundedSkybox, камера на орбіті навколо
// солдата. Рендер лише на вимогу (Stage викликає render() при зміні стану).
import * as THREE from 'three';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import type { CameraConfig, Config } from './config';
import type { Manifest } from './manifest';

const TONE_GLSL = /* glsl */ `
#include <colorspace_fragment>
gl_FragColor.rgb *= uBrightness;
gl_FragColor.rgb = (gl_FragColor.rgb - 0.5) * uContrast + 0.5;
float svL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
gl_FragColor.rgb = mix(vec3(svL), gl_FragColor.rgb, uSaturation);
`;

export class Background {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.05, 500);
  private readonly scene = new THREE.Scene();
  private sky: GroundedSkybox | null = null;
  private tex: THREE.Texture | null = null;
  private grid: THREE.GridHelper | null = null;
  private readonly uniforms = {
    uBrightness: { value: 1 },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
  };
  private skyKey = '';
  private cam: CameraConfig;
  private destroyed = false;
  /** Повна текстура панорами завантажена (не preview). */
  fullReady = false;

  /** Чи доступний WebGL (інакше Stage вмикає BackgroundFallback). */
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  get el(): HTMLElement {
    return this.canvas;
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    private cfg: Config,
    private readonly manifest: Manifest,
    private readonly onChange: () => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.background = new THREE.Color(cfg.fade.color);
    this.cam = cfg.camera;
  }

  /** Preview для першого показу; повна текстура — reloadFull() після ready. */
  async load(): Promise<void> {
    const pano = this.manifest.pano;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const url = this.cfg.assetBase + pano.dir + pano.variants.pano_preview.blur['0'];
    const preview = await loader.loadAsync(url).catch(() => {
      throw new Error(`soldier-viewer: панорама не завантажилась (${url}). Для іншого домену потрібен CORS.`);
    });
    if (this.destroyed) return preview.dispose();
    this.setTexture(preview);
  }

  private pickFull(): string {
    const v = this.manifest.pano.variants;
    const mobile = matchMedia('(pointer: coarse)').matches;
    const big = v.pano_8192 && this.renderer.capabilities.maxTextureSize >= 8192 && !mobile ? v.pano_8192 : v.pano_4096;
    const b = String(this.cfg.skybox.blurPx);
    return big.blur[b] ?? big.blur['0'];
  }

  /** Повна текстура (підміна без перезбирання сцени); також при зміні розмиття в debug. */
  reloadFull() {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader
      .loadAsync(this.cfg.assetBase + this.manifest.pano.dir + this.pickFull())
      .then((t) => {
        if (this.destroyed) return t.dispose();
        this.setTexture(t);
        this.fullReady = true;
        this.onChange();
      })
      .catch(() => {});
  }

  private setTexture(t: THREE.Texture) {
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); // підлога під гострим кутом
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    const old = this.tex;
    this.tex = t;
    if (this.sky) {
      (this.sky.material as THREE.MeshBasicMaterial).map = t;
      (this.sky.material as THREE.MeshBasicMaterial).needsUpdate = true;
    } else {
      this.buildSky();
    }
    old?.dispose();
  }

  private buildSky() {
    if (!this.tex) return;
    const s = this.cfg.skybox;
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
    }
    const radius = Math.max(s.radius, this.cam.distance + 5); // R + запас < radius
    const sky = new GroundedSkybox(this.tex, s.panoHeight, radius);
    sky.position.y = s.panoHeight - 0.01; // підлога на y = 0
    const mat = sky.material as THREE.MeshBasicMaterial;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader =
        'uniform float uBrightness;\nuniform float uContrast;\nuniform float uSaturation;\n' +
        shader.fragmentShader.replace('#include <colorspace_fragment>', TONE_GLSL);
    };
    this.sky = sky;
    this.skyKey = `${s.panoHeight}|${radius}`;
    this.scene.add(sky);
    this.applySkybox();
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
    this.scene.background = new THREE.Color(cfg.fade.color);
    const radius = Math.max(cfg.skybox.radius, this.cam.distance + 5);
    if (this.sky && this.skyKey !== `${cfg.skybox.panoHeight}|${radius}`) this.buildSky();
    else this.applySkybox();
  }

  private applySkybox() {
    const s = this.cfg.skybox;
    this.uniforms.uBrightness.value = s.brightness;
    this.uniforms.uContrast.value = s.contrast;
    this.uniforms.uSaturation.value = s.saturation;
    if (this.sky) this.sky.rotation.y = THREE.MathUtils.degToRad(s.yawDeg);
  }

  /** Розмір і параметри камери (desktop / portrait обирає Stage). */
  resize(w: number, h: number, cam: CameraConfig) {
    this.cam = cam;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = cam.fovDeg;
    this.camera.updateProjectionMatrix();
    const radius = Math.max(this.cfg.skybox.radius, cam.distance + 5);
    if (this.sky && this.skyKey !== `${this.cfg.skybox.panoHeight}|${radius}`) this.buildSky();
  }

  /** Камера на орбіті: φ = orbitDir × θn. */
  setAngle(thetaN: number) {
    const phi = THREE.MathUtils.degToRad(this.cfg.rotation.orbitDir * thetaN);
    const R = this.cam.distance;
    this.camera.position.set(Math.sin(phi) * R, this.cam.height, Math.cos(phi) * R);
    this.camera.lookAt(0, this.cam.lookAtHeight, 0);
    this.camera.updateMatrixWorld();
  }

  /** Світова точка → CSS-пікселі в межах canvas. */
  project(x: number, y: number, z: number, w: number, h: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  setGrid(on: boolean) {
    if (on && !this.grid) {
      this.grid = new THREE.GridHelper(20, 20, 0xff1f5a, 0x00b7ff);
      (this.grid.material as THREE.Material).transparent = true;
      (this.grid.material as THREE.Material).opacity = 0.9;
      (this.grid.material as THREE.Material).depthTest = false;
      this.grid.position.y = 0.001;
      this.scene.add(this.grid);
    } else if (!on && this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.destroyed = true;
    this.setGrid(false);
    if (this.sky) {
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
    }
    this.tex?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
