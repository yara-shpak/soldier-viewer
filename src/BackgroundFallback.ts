// 7.11 Fallback без WebGL: фон — смуга панорами як CSS-фон, що зсувається
// на orbitDir × θ / 360 × ширина смуги (циклічно). Камера — та сама
// PerspectiveCamera (лише математика, без WebGL), тож солдат і зони стоять так само.
import * as THREE from 'three';
import type { CameraConfig, Config } from './config';
import type { Manifest } from './manifest';

export class BackgroundFallback {
  readonly el = document.createElement('div');
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.05, 500);
  private readonly strip = document.createElement('div');
  private cam: CameraConfig;
  private size = { w: 1, h: 1 };
  private stripW = 1;
  private thetaN = 0;
  fullReady = false;

  constructor(
    private cfg: Config,
    private readonly manifest: Manifest,
    private readonly onChange: () => void,
  ) {
    this.el.className = 'sv-bg sv-bg-fallback';
    this.strip.className = 'sv-bg-strip';
    this.el.appendChild(this.strip);
    this.cam = cfg.camera;
    this.applyConfig(cfg);
  }

  private url(file: string) {
    return this.cfg.assetBase + this.manifest.pano.dir + file;
  }

  private load1(file: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.strip.style.backgroundImage = `url("${img.src}")`;
        resolve();
      };
      img.onerror = () => resolve();
      img.src = this.url(file);
    });
  }

  async load(): Promise<void> {
    const v = this.manifest.pano.variants;
    await this.load1(v.pano_preview.blur['0']);
  }

  reloadFull() {
    const v = this.manifest.pano.variants.pano_4096;
    this.load1(v.blur[String(this.cfg.skybox.blurPx)] ?? v.blur['0']).then(() => {
      this.fullReady = true;
      this.onChange();
    });
  }

  applyConfig(cfg: Config) {
    this.cfg = cfg;
    const s = cfg.skybox;
    this.el.style.backgroundColor = cfg.fade.color;
    // Статичний фільтр на композитному шарі; змінюється лише transform.
    this.strip.style.filter = `brightness(${s.brightness}) contrast(${s.contrast}) saturate(${s.saturation})`;
    this.layoutStrip();
  }

  resize(w: number, h: number, cam: CameraConfig) {
    this.cam = cam;
    this.size = { w, h };
    this.camera.aspect = w / h;
    this.camera.fov = cam.fovDeg;
    this.camera.updateProjectionMatrix();
    this.layoutStrip();
  }

  /** Розмір і вертикальне положення смуги: горизонт панорами на горизонті камери. */
  private layoutStrip() {
    const { w, h } = this.size;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.cam.fovDeg / 2));
    const hfov = 2 * Math.atan(tanV * (w / h));
    const pxPerRad = w / hfov;
    this.stripW = 2 * Math.PI * pxPerRad;
    const stripH = this.stripW / 2;
    const pitch = Math.atan((this.cam.height - this.cam.lookAtHeight) / this.cam.distance);
    const horizonY = h / 2 - (Math.tan(pitch) / tanV) * (h / 2);
    const s = this.strip.style;
    s.width = `${this.stripW * 2 + w}px`;
    s.height = `${stripH}px`;
    s.top = `${horizonY - stripH / 2}px`;
    s.backgroundSize = `${this.stripW}px ${stripH}px`;
    this.place();
  }

  setAngle(thetaN: number) {
    this.thetaN = thetaN;
    const phi = THREE.MathUtils.degToRad(this.cfg.rotation.orbitDir * thetaN);
    const R = this.cam.distance;
    this.camera.position.set(Math.sin(phi) * R, this.cam.height, Math.cos(phi) * R);
    this.camera.lookAt(0, this.cam.lookAtHeight, 0);
    this.camera.updateMatrixWorld();
  }

  private place() {
    // Центр кадру при θ = 0 — той самий напрям панорами, що й у WebGL-режимі (з урахуванням yaw).
    const W = this.stripW;
    const u0 = 0.25 - this.cfg.skybox.yawDeg / 360;
    const x = this.size.w / 2 - u0 * W + (this.cfg.rotation.orbitDir * this.thetaN * W) / 360;
    const wrapped = (((x % W) + W) % W) - W;
    this.strip.style.transform = `translate3d(${wrapped}px,0,0)`;
  }

  project(x: number, y: number, z: number, w: number, h: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  setGrid(_on: boolean) {
    /* сітки немає без WebGL */
  }

  render() {
    this.place();
  }

  destroy() {
    this.el.remove();
  }
}
