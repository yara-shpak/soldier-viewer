// Debug-режим (?debug=1): панель калібрування lil-gui, сітка підлоги 1×1 м,
// перехрестя в P_feet, оверлей стану, «Copy config».
import GUI from 'lil-gui';
import type { RenderInfo, Stage } from './Stage';

export function attachDebug(stage: Stage): () => void {
  const cfg = stage.cfg;
  const root = stage.root;
  const cross = document.createElement('div');
  cross.className = 'sv-debug-cross';
  const box = document.createElement('div');
  box.className = 'sv-debug-box';
  const stats = document.createElement('div');
  stats.className = 'sv-debug-stats';
  const view = { grid: true, box: false, stats: true, angle: 0 };
  root.append(cross, box, stats);

  let last = performance.now();
  let fps = 0;
  const show = (info: RenderInfo) => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (dt > 0 && dt < 200) fps = fps ? fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    cross.style.left = `${info.feet.x}px`;
    cross.style.top = `${info.feet.y}px`;
    const r = info.rect;
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.style.display = view.box ? '' : 'none';
    stats.style.display = view.stats ? '' : 'none';
    stats.textContent =
      `θ        ${info.theta.toFixed(2)}°  (θn ${info.thetaN.toFixed(2)}°)\n` +
      `кадр     ${info.frame}  → ${info.frameAngle.toFixed(2)}°\n` +
      `φ камери ${info.phiDeg.toFixed(2)}°\n` +
      `фронт    ${info.front ? 'так' : 'ні'}\n` +
      `fov      ${info.fovDeg.toFixed(1)}°  scale ${r.scale.toFixed(3)}\n` +
      `FPS      ${fps.toFixed(0)}`;
    view.angle = info.thetaN;
  };
  stage.onRender = show;
  stage.bg.setGrid(view.grid);

  const gui = new GUI({ title: 'Soldier viewer · debug', width: 300 });
  gui.domElement.style.zIndex = '1000';
  const apply = () => stage.applyConfig(cfg);

  const v = gui.addFolder('View');
  v.add(view, 'grid').name('сітка підлоги 1 м').onChange((on: boolean) => {
    stage.bg.setGrid(on);
    stage.render();
  });
  v.add(view, 'box').name('рамка кропу').onChange(() => stage.render());
  v.add(view, 'stats').name('оверлей стану').onChange(() => stage.render());
  v.add(view, 'angle', 0, 360, 0.1).name('θ').listen().onChange((d: number) => stage.setAngle(d));
  const jumps = {
    '0°': () => stage.setAngle(0),
    '45°': () => stage.setAngle(45),
    '90°': () => stage.setAngle(90),
    '180°': () => stage.setAngle(180),
    '270°': () => stage.setAngle(270),
    '+360° (анім.)': () => stage.setAngle(Math.round(stage.getTheta()) + 360, true),
  };
  for (const k of Object.keys(jumps)) v.add(jumps, k as keyof typeof jumps);

  const c = gui.addFolder('Camera');
  c.add(cfg.camera, 'fovDeg', 20, 90, 0.5).onChange(apply);
  c.add(cfg.camera, 'distance', 1.5, 8, 0.05).onChange(apply);
  c.add(cfg.camera, 'height', 0.3, 3, 0.01).onChange(apply);
  c.add(cfg.camera, 'lookAtHeight', 0, 2, 0.01).onChange(apply);
  const cp = c.addFolder('Portrait (aspect < portraitAspect)');
  cp.add(cfg.camera.portrait, 'fovDeg', 20, 90, 0.5).onChange(apply);
  cp.add(cfg.camera.portrait, 'distance', 1.5, 8, 0.05).onChange(apply);
  cp.add(cfg.camera.portrait, 'height', 0.3, 3, 0.01).onChange(apply);
  cp.add(cfg.camera.portrait, 'lookAtHeight', 0, 2, 0.01).onChange(apply);
  cp.add(cfg.camera, 'portraitAspect', 0.4, 1.5, 0.01).onChange(apply);
  cp.close();

  const s = gui.addFolder('Skybox');
  s.add(cfg.skybox, 'panoHeight', 0.3, 4, 0.01).onChange(apply);
  s.add(cfg.skybox, 'radius', 10, 200, 1).onChange(apply);
  s.add(cfg.skybox, 'yawDeg', -180, 180, 0.5).onChange(apply);
  s.add(cfg.skybox, 'brightness', 0.3, 2, 0.01).onChange(apply);
  s.add(cfg.skybox, 'contrast', 0.3, 2, 0.01).onChange(apply);
  s.add(cfg.skybox, 'saturation', 0, 2, 0.01).onChange(apply);
  s.add(cfg.skybox, 'blurPx', [0, 2, 4]).onChange(() => {
    apply();
    stage.bg.reloadFull();
  });
  s.add({ renderer: stage.root.classList.contains('sv-fallback') ? '2d (fallback)' : 'webgl' }, 'renderer')
    .name('рендер')
    .disable();

  const so = gui.addFolder('Soldier');
  so.add(cfg.soldier, 'heightM', 1, 2.5, 0.01).onChange(apply);
  so.add(cfg.soldier.offsetPx, 'x', -100, 100, 0.5).name('offsetPx.x').onChange(apply);
  so.add(cfg.soldier.offsetPx, 'y', -100, 100, 0.5).name('offsetPx.y').onChange(apply);
  const pf = so.addFolder('Тонування (превʼю → config.yaml export.tone)');
  pf.add(cfg.soldier.previewFilter, 'brightness', 0.5, 1.5, 0.01).onChange(apply);
  pf.add(cfg.soldier.previewFilter, 'contrast', 0.5, 1.5, 0.01).onChange(apply);
  pf.add(cfg.soldier.previewFilter, 'saturate', 0, 2, 0.01).onChange(apply);
  pf.add(cfg.soldier.previewFilter, 'sepia', 0, 1, 0.01).name('sepia (тепло)').onChange(apply);
  pf.add(cfg.soldier.previewFilter, 'hueRotate', -30, 30, 0.5).onChange(apply);
  pf.close();

  const sh = gui.addFolder('Shadow');
  sh.add(cfg.shadow, 'enabled').name('витягнута').onChange(apply);
  sh.add(cfg.shadow, 'opacity', 0, 1, 0.01).onChange(apply);
  sh.add(cfg.shadow, 'synthetic').name('синтетична').onChange(apply);
  sh.add(cfg.shadow, 'syntheticOpacity', 0, 1, 0.01).onChange(apply);
  sh.add(cfg.shadow, 'syntheticWidth', 0.2, 2, 0.01).onChange(apply);
  sh.add(cfg.shadow, 'syntheticHeight', 0.05, 0.6, 0.01).onChange(apply);

  const ro = gui.addFolder('Rotation');
  ro.add(cfg.rotation, 'orbitDir', [-1, 1]).onChange(apply);
  ro.add(cfg.rotation, 'dragSign', [-1, 1]).onChange(apply);
  ro.add(cfg.rotation, 'degPerPxMouse', 0.05, 2, 0.01).onChange(apply);
  ro.add(cfg.rotation, 'degPerPxTouch', 0.05, 2, 0.01).onChange(apply);
  ro.add(cfg.rotation, 'decay', 0.5, 15, 0.1).onChange(apply);
  ro.add(cfg.rotation, 'snapRangeDeg', 0, 90, 1).onChange(apply);
  ro.add(cfg.rotation, 'inertia').onChange(apply);
  ro.add(cfg.rotation, 'frameBlend').onChange(apply);
  ro.add(cfg.rotation, 'loop', ['infinite', 'clamped']).onChange(apply);

  const hs = gui.addFolder('Hotspots');
  hs.add(cfg.hotspots, 'debugAlways').name('показувати завжди').onChange(apply);
  hs.add(cfg.hotspots, 'debugOutlines').name('контури всіх зон').onChange(apply);
  hs.add(cfg.hotspots, 'touchMarkers').onChange(apply);
  hs.add(cfg.hotspots, 'hintPulse').onChange(apply);
  hs.add(cfg.hotspots, 'showDelayMs', 0, 1000, 10).onChange(apply);

  const ui = gui.addFolder('UI');
  ui.add(cfg.ui, 'viewButtons').name('кнопки ракурсів').onChange(apply);
  ui.add(cfg.ui.viewAngles, 'left', 0, 360, 1).name('кут «Зліва»').onChange(apply);
  ui.add(cfg.ui.viewAngles, 'right', 0, 360, 1).name('кут «Справа»').onChange(apply);
  ui.add(cfg.ui.viewAngles, 'back', 0, 360, 1).name('кут «Позаду»').onChange(apply);
  ui.close();

  const f = gui.addFolder('Fade');
  f.addColor(cfg.fade, 'color').onChange(apply);
  f.add(cfg.fade, 'top', 0, 0.5, 0.005).onChange(apply);
  f.add(cfg.fade, 'bottomStart', 0.5, 1, 0.005).onChange(apply);
  f.add(cfg.fade, 'bottomEnd', 0.5, 1, 0.005).onChange(apply);
  f.add(cfg.fade, 'overSoldier').onChange(apply);
  f.close();

  const actions = {
    'Copy config': async () => {
      const text = JSON.stringify(stage.exportConfig(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        window.prompt('Скопіюйте JSON у public/config.json', text);
      }
    },
  };
  gui.add(actions, 'Copy config');

  // Для QA-скриптів.
  (window as unknown as { __svConfig: () => unknown }).__svConfig = () => stage.exportConfig();

  return () => {
    gui.destroy();
    stage.onRender = null;
    cross.remove();
    box.remove();
    stats.remove();
  };
}
