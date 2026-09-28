import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createStudio } from './studio.js';
import { createRenderQuality } from './render-quality.js';
import { createPrintIntro, loadPrintSamples } from './print-intro.js';
import { createFocusNoise, loadFocusSamples } from './focus-noise.js';
import { PARTS } from './parts.js';
import { prepareExplodeLayout, configureExplodeOrbit, applyExplodeLayout, captureAssemblyLayout, applyAssemblyLayout } from './explode-layout.js';
import { RESET_GROW_MS } from './print-effect.js';
import { createRenderBudget } from './render-budget.js';
import { createPartPicker } from './part-picker.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const modelURL = `${import.meta.env.BASE_URL}models/tennis-shoe-preview.glb`;
const state = { ready: false, printing: false, resetting: false, resetProgress: 1, amount: 0, target: 0, transition: null, width: 1, height: 1, selected: null };
// A development-only frozen frame for reviewing the time-based reveal.
const reviewProgress = import.meta.env.DEV && new URLSearchParams(location.search).has('introAt')
  ? THREE.MathUtils.clamp(Number(new URLSearchParams(location.search).get('introAt')) || 0, 0, 0.99) : null;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#07090c');
const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 100);
const originalDirection = new THREE.Vector3(4, 3.4, 6).normalize();
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch {
  showError('当前浏览器无法启用 WebGL。请打开浏览器的图形加速后重试。');
}

function showError(message) {
  $('loading').classList.add('done');
  $('error').hidden = false;
  $('error-detail').textContent = message;
}
$('retry').addEventListener('click', () => location.reload());

if (renderer) init();

async function init() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1, Math.sqrt(1200000 / (stage.clientWidth * stage.clientHeight))));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  $('canvas-wrap').appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '网球鞋模型。回车展开；展开后点击零件查看特写；左右方向键旋转；加减键缩放；复位按钮合拢。');
  const controls = new OrbitControls(camera, canvas);
  // Follow input immediately. Inertia is applied only after releasing a drag.
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.65;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI - 0.15;
  controls.minDistance = 0.35;
  controls.maxDistance = 60;
  controls.target.set(-0.3, 0.2, 0);
  camera.position.copy(originalDirection).multiplyScalar(8).add(controls.target);
  controls.update();

  createStudio(scene, renderer);

  const renderBudget = createRenderBudget(renderer, devicePixelRatio);
  const meshes = [];
  const callouts = [];
  const raycaster = new THREE.Raycaster();
  let partPicker = null;
  const ndc = new THREE.Vector2();
  let rotationTween = null;
  let fitTween = null;
  let pointer = null;
  let gestureUsedMultiplePointers = false;
  const downPointers = new Set();
  let disposed = false;
  let renderDirty = true;
  let lastRafTime = 0;
  let lastFocusFrame = 0;
  let frameBudget = 0;
  let lastCalloutTime = 0;
  let lastDiagnosticsTime = 0;
  let highDetailPromise = null;
  let highDetail = null;
  let renderCount = 0;
  let quality = null;
  let focusNoise = null;
  let constellationTime = 0;
  let lastMotionTime = -Infinity;
  let coast = null;
  const dragSphere = new THREE.Spherical();
  const dragOffset = new THREE.Vector3();
  let dragSample = null;
  const dragVelocity = new THREE.Vector2();
  let rotationProbe = null;
  let focusProbe = null;
  const profileRotation = import.meta.env.DEV && new URLSearchParams(location.search).has('motionProfile');
  if (profileRotation) {
    const testButton = document.createElement('button');
    testButton.id = 'motion-benchmark'; testButton.textContent = '测试旋转（4 秒）';
    testButton.style.cssText = 'position:absolute;right:20px;bottom:20px;z-index:10;padding:10px;background:#17212b;border:1px solid #586775;color:white';
    testButton.addEventListener('click', () => {
      if (!state.ready || state.printing || state.transition) return;
      coast = null; fitTween = null;
      const sphere = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      const start = performance.now();
      rotationProbe = { start, last: null, frames: [], cpu: 0 };
      rotationTween = { start, from: sphere.theta, to: sphere.theta + Math.PI * 0.8, phi: sphere.phi, radius: sphere.radius, duration: 4000, linear: true };
      document.body.dataset.rotationTest = 'running';
    });
    stage.appendChild(testButton);
  }
  let printIntro = null;
  let introCompiling = false;
  let lastIntroFrame = 0;
  let printPercent = -1;
  let introBenchmark = null;
  const measureIntro = import.meta.env.DEV;
  const benchGL = measureIntro && new URLSearchParams(location.search).has('perf') ? renderer.getContext() : null;
  const gpuTimer = benchGL?.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpuQueries = [];
  const rendererDebug = benchGL?.getExtension('WEBGL_debug_renderer_info');
  if (rendererDebug) document.body.dataset.gpu = benchGL.getParameter(rendererDebug.UNMASKED_RENDERER_WEBGL);
  const samplesPromise = reduceMotion ? Promise.resolve(null) : loadPrintSamples(stage.clientWidth <= 600).catch(() => null);
  const focusSamplesPromise = loadFocusSamples(stage.clientWidth <= 600).catch(error => { console.warn(error); return null; });
  let introFrameTotal = 0, introFrameCount = 0;
  function restingPixelRatio() { return Math.min(devicePixelRatio, 1, Math.sqrt(1200000 / (state.width * state.height))); }
  function initialIntroPixelRatio() { return Math.min(restingPixelRatio(), state.width <= 600 ? 1 : 0.9, Math.sqrt(900000 / (state.width * state.height))); }
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  draco.setWorkerLimit(2);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const introGeometryPromise = loader.loadAsync(`${import.meta.env.BASE_URL}models/tennis-shoe-intro.glb`).then(gltf => {
    const geometries = new Map();
    gltf.scene.traverse(object => {
      if (object.isMesh) { geometries.set(object.userData.part_id, object.geometry); object.material.dispose(); }
    });
    return geometries;
  }).catch(() => null);

  function fitDistance(amount) {
    const aspect = state.width / state.height;
    const mobile = state.width <= 600;
    const width = mobile ? THREE.MathUtils.lerp(4.6, 10.8, amount) : THREE.MathUtils.lerp(5.35, 11.4, amount);
    const height = THREE.MathUtils.lerp(mobile ? 4.2 : 3.1, mobile ? 10.6 : 10.5, amount);
    return Math.max(height, width / aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }
  function preferredTarget(amount) {
    const mobile = state.width <= 600;
    return new THREE.Vector3(mobile ? 0 : THREE.MathUtils.lerp(-0.12, -0.5, amount), mobile ? THREE.MathUtils.lerp(0.4, 1.05, amount) : THREE.MathUtils.lerp(-0.28, 0.6, amount), 0);
  }
  function fitView(animated = false) {
    coast = null;
    if (state.resetting) {
      if (fitTween?.rebuild) {
        const from = state.transition?.from ?? 0;
        fitTween.fromTarget.copy(preferredTarget(from));
        fitTween.fromPos.copy(originalDirection).multiplyScalar(fitDistance(from)).add(fitTween.fromTarget);
        fitTween.toTarget.copy(preferredTarget(0));
        fitTween.toPos.copy(originalDirection).multiplyScalar(fitDistance(0)).add(fitTween.toTarget);
      }
      return;
    }
    if (state.selected) { focusPart(state.selected, animated); return; }
    const newTarget = preferredTarget(state.target);
    const direction = camera.position.clone().sub(controls.target).normalize();
    const newPosition = direction.multiplyScalar(fitDistance(state.target)).add(newTarget);
    if (animated && !reduceMotion) {
      fitTween = { start: performance.now(), fromPos: camera.position.clone(), toPos: newPosition, fromTarget: controls.target.clone(), toTarget: newTarget };
    } else {
      fitTween = null; controls.target.copy(newTarget); camera.position.copy(newPosition); controls.update();
    }
  }
  function resize() {
    state.width = stage.clientWidth; state.height = stage.clientHeight;
    renderBudget.resize(state.width, state.height);
    camera.aspect = state.width / state.height; camera.updateProjectionMatrix();
    if (!state.printing) renderer.setPixelRatio(restingPixelRatio());
    renderer.setSize(state.width, state.height);
    renderDirty = true;
    fitView(false);
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  function updateUI() {
    const p = Math.round(state.amount * 100);
    const view = state.amount === 0 ? 'assembled' : state.amount === 1 ? 'exploded' : 'transitioning';
    if (document.body.dataset.view !== view) document.body.dataset.view = view;
    if (document.body.dataset.explode !== String(p)) document.body.dataset.explode = String(p);
    const hideReplay = state.amount > 0 || state.target > 0 || state.resetting;
    if ($('replay-intro').hidden !== hideReplay) $('replay-intro').hidden = hideReplay;
  }
  function setAmount(amount) {
    state.amount = THREE.MathUtils.clamp(amount, 0, 1);
    for (const mesh of meshes) {
      applyExplodeLayout(mesh, state.amount, constellationTime);
    }
    renderDirty = true;
    renderer.shadowMap.needsUpdate = true;
    updateUI();
    if (state.amount === 0) constellationTime = 0;
  }
  function moveTo(target, immediate = false) {
    if (!state.ready || state.printing || state.resetting) return;
    state.target = THREE.MathUtils.clamp(target, 0, 1);
    $('part-label').style.display = 'none';
    if (immediate || reduceMotion) { state.transition = null; setAmount(state.target); }
    else state.transition = { start: performance.now(), from: state.amount, to: state.target, duration: 2400 * Math.max(0.35, Math.abs(state.amount - state.target)) };
    fitView(!immediate);
    updateUI();
    if (!immediate) $('announcement').textContent = state.target === 0 ? '鞋子正在合拢。' : '鞋子正在展开，左右拖动查看零件。';
  }
  function expand() { if (!state.printing && state.target === 0 && !state.transition) moveTo(1); }

  function finishPrintIntro() {
    if (introBenchmark) {
      const b = introBenchmark, sorted = [...b.frames].sort((a,b) => a-b);
      const percentile = p => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0) * 10) / 10;
      document.body.dataset.introBenchmark = JSON.stringify({
        prepareMs: b.prepareMs, compileMs: b.compileMs, frames: b.frames.length,
        pixelRatio: renderer.getPixelRatio(),
        medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
        over50ms: b.frames.filter(ms => ms > 50).length,
        firstFrames: b.frames.slice(0, 12).map(ms => Math.round(ms * 10) / 10),
        renderCpuMs: Math.round(b.renderMs / Math.max(1, b.frames.length) * 100) / 100,
        gpuMedianMs: b.gpuMs.length ? Math.round(b.gpuMs.sort((a,b)=>a-b)[Math.floor(b.gpuMs.length/2)] * 10) / 10 : null,
      });
      introBenchmark = null;
    }
    while (gpuQueries.length) benchGL.deleteQuery(gpuQueries.shift());
    printIntro?.dispose(); printIntro = null;
    renderer.setPixelRatio(restingPixelRatio());
    state.printing = false;
    $('print-status').hidden = true;
    $('reset').disabled = false;
    $('replay-intro').disabled = false;
    document.querySelector('.intro p').textContent = '点击鞋身展开，探索零件之间的关系。';
    document.body.dataset.printing = 'false';
    document.body.dataset.introProgress = '100';
    $('announcement').textContent = '鞋子已成型，点击鞋身展开结构。';
    $('loading').classList.add('done');
    $('loading').setAttribute('aria-hidden', 'true');
    renderDirty = true;
  }
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function warmScene(present = false) {
    // compileAsync prepares programs, but does not upload geometry or issue a draw.
    // A small offscreen draw plus an asynchronous GPU fence pays that cost before playback.
    await renderer.compileAsync(scene, camera);
    const target = new THREE.WebGLRenderTarget(32, 32);
    const gl = renderer.getContext();
    let fence;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      // The intro is still invisible here. Allocate/present the real drawing buffer too.
      if (present) renderer.render(scene, camera);
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      for (let i = 0; fence && i < 120; i++) {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status !== gl.TIMEOUT_EXPIRED) break;
        await nextFrame();
      }
    } finally {
      if (fence) gl.deleteSync(fence);
      renderer.setRenderTarget(null); target.dispose();
    }
  }
  async function startPrintIntro() {
    if (!state.ready || state.printing || state.amount > 0 || state.target > 0) return;
    if (reduceMotion) { finishPrintIntro(); return; }
    coast = null; rotationTween = null; fitTween = null;
    quality?.setMoving(false, state.selected, highDetail);
    state.printing = true;
    introCompiling = true;
    $('reset').disabled = true;
    $('replay-intro').disabled = true;
    $('skip-intro').disabled = true;
    $('print-status').hidden = false;
    $('print-progress').textContent = '0%';
    document.body.dataset.printing = 'true';
    document.body.dataset.introProgress = '0';
    document.querySelector('.intro p').textContent = '粒子逐层汇聚，正在构建鞋体。';
    $('announcement').textContent = '正在从鞋底向上逐层成型。';
    $('loading').classList.remove('done');
    $('loading').setAttribute('aria-hidden', 'false');
    $('loading-text').textContent = '正在准备生成动画';
    printPercent = -1;
    try {
      const [samples, introGeometries] = await Promise.all([
        samplesPromise.then(samples => samples || loadPrintSamples(state.width <= 600)), introGeometryPromise,
      ]);
      await nextFrame();
      renderer.setPixelRatio(initialIntroPixelRatio());
      await warmScene();
      const prepareStart = performance.now();
      printIntro = createPrintIntro(scene, meshes, { mobile: state.width <= 600, samples, introGeometries });
      const prepareEnd = performance.now();
      await warmScene(true);
      if (measureIntro) introBenchmark = { prepareMs: Math.round(prepareEnd - prepareStart), compileMs: Math.round(performance.now() - prepareEnd), frames: [], renderMs: 0, gpuMs: [], last: null };
      lastIntroFrame = performance.now();
      introFrameTotal = 0; introFrameCount = 0;
      $('loading').classList.add('done');
      $('loading').setAttribute('aria-hidden', 'true');
      $('skip-intro').disabled = false;
    } catch (error) {
      console.warn('Particle intro unavailable; displaying the completed shoe.', error);
      finishPrintIntro();
    } finally { introCompiling = false; renderDirty = true; }
  }
  $('skip-intro').addEventListener('click', finishPrintIntro);
  $('replay-intro').addEventListener('click', startPrintIntro);
  function materialsForFocus(selected) {
    focusNoise?.setFocus(selected);
    quality?.refresh(selected, highDetail);
    renderDirty = true;
    renderer.shadowMap.needsUpdate = true;
  }
  function focusPart(mesh, animated = true) {
    if (!state.ready || state.amount < 0.999 || state.transition) return;
    state.selected = mesh;
    coast = null;
    loadHighDetail();
    rotationTween = null;
    materialsForFocus(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const direction = camera.position.clone().sub(controls.target).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    let halfW = 0, halfH = 0, halfDepth = 0;
    for (let x of [box.min.x, box.max.x]) for (let y of [box.min.y, box.max.y]) for (let z of [box.min.z, box.max.z]) {
      const corner = new THREE.Vector3(x,y,z).sub(center);
      halfW = Math.max(halfW, Math.abs(corner.dot(right)));
      halfH = Math.max(halfH, Math.abs(corner.dot(up)));
      halfDepth = Math.max(halfDepth, Math.abs(corner.dot(direction)));
    }
    const distance = Math.max(0.8, Math.max(halfH * 1.65, halfW * 1.3 / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) + halfDepth);
    // Offset the framing slightly so the material and its name have separate space.
    const newTarget = center.clone().addScaledVector(up, state.width <= 600 ? size.length() * 0.16 : 0);
    const newPosition = direction.multiplyScalar(distance).add(newTarget);
    if (animated && !reduceMotion) fitTween = { start: performance.now(), fromPos: camera.position.clone(), toPos: newPosition, fromTarget: controls.target.clone(), toTarget: newTarget, duration: 900 };
    else { fitTween = null; controls.target.copy(newTarget); camera.position.copy(newPosition); controls.update(); }
    $('inspection').hidden = false;
    $('part-label').style.display = 'none';
    document.body.dataset.selected = mesh.userData.part_id;
    updateCallouts();
    $('announcement').textContent = focusNoise?.forming
      ? `正在由下向上生成${mesh.userData.label}，以开场动画的两倍速度成型。`
      : `正在查看${mesh.userData.label}，其他零件以生长噪波粒子呈现。`;
    renderDirty = true;
  }
  function loadHighDetail() {
    if (highDetailPromise) return;
    highDetailPromise = loader.loadAsync(`${import.meta.env.BASE_URL}models/tennis-shoe.glb`).then(gltf => {
      highDetail = new Map();
      gltf.scene.traverse(object => {
        if (object.isMesh) { highDetail.set(object.userData.part_id, object.geometry); object.material.dispose(); }
      });
      if (state.selected) {
        quality?.refresh(state.selected, highDetail);
        renderDirty = true;
      }
      draco.dispose();
      document.body.dataset.detailReady = 'true';
    }).catch(error => {
      console.warn('High detail model could not load; retaining the preview.', error);
      highDetailPromise = null;
    });
  }
  function clearFocus() {
    state.selected = null; materialsForFocus(null);
    $('inspection').hidden = true;
    delete document.body.dataset.selected;
    updateCallouts();
  }
  function createCallout(mesh, index) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const group = document.createElementNS(svgNS, 'g');
    const line = document.createElementNS(svgNS, 'path');
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('r', '2.5');
    group.append(line, dot); $('callout-lines').appendChild(group);
    const button = document.createElement('button');
    button.className = 'callout-label';
    button.textContent = mesh.userData.label;
    button.setAttribute('aria-label', `查看${mesh.userData.label}细节`);
    button.dataset.part = mesh.userData.part_id;
    button.addEventListener('click', () => focusPart(mesh));
    $('callout-labels').appendChild(button);
    const geometry = mesh.geometry;
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const positions = geometry.attributes.position;
    const anchor = new THREE.Vector3(), candidate = new THREE.Vector3();
    let nearest = Infinity;
    for (let i = 0; i < positions.count; i += Math.max(1, Math.floor(positions.count / 1600))) {
      candidate.fromBufferAttribute(positions, i);
      const distance = candidate.distanceToSquared(center);
      if (distance < nearest) { nearest = distance; anchor.copy(candidate); }
    }
    callouts.push({ mesh, group, line, dot, button, anchor, side: ['part_03','part_04','part_05','part_06','part_11'].includes(mesh.userData.part_id) ? 'left' : 'right', index });
  }
  const calloutPoint = new THREE.Vector3();
  let labeledMesh = null;
  function updateCallouts() {
    const selected = !state.resetting && state.amount > .999 ? state.selected : null;
    $('callouts').hidden = !selected;
    if (labeledMesh !== selected) {
      for (const item of callouts) {
        item.button.hidden = item.mesh !== selected;
        item.group.style.display = item.mesh === selected ? '' : 'none';
      }
      labeledMesh = selected;
    }
    if (!selected) return;
    const item = callouts.find(item => item.mesh === selected);
    const mobile = state.width <= 600;
    const width = mobile ? 109 : 150;
    selected.updateWorldMatrix(true, false);
    calloutPoint.copy(item.anchor).applyMatrix4(selected.matrixWorld).project(camera);
    const onScreen = calloutPoint.z > -1 && calloutPoint.z < 1 && Math.abs(calloutPoint.x) < 1.3 && Math.abs(calloutPoint.y) < 1.3;
    item.group.style.display = onScreen ? '' : 'none';
    item.button.hidden = !onScreen;
    if (!onScreen) return;
    const px = (calloutPoint.x * .5 + .5) * state.width;
    const py = (-calloutPoint.y * .5 + .5) * state.height;
    const labelY = THREE.MathUtils.clamp(py, 100, state.height - 26);
    const left = item.side === 'left';
    const x = left ? (mobile ? 12 : 48) : state.width - width - (mobile ? 12 : 48);
    const end = left ? x + width : x;
    const elbow = end + (left ? 22 : -22);
    $('callout-lines').setAttribute('viewBox', `0 0 ${state.width} ${state.height}`);
    item.button.disabled = false;
    item.button.classList.add('selected');
    item.button.style.width = `${width}px`;
    item.button.style.transform = `translate(${x}px,${labelY - 15}px)`;
    item.line.setAttribute('d', `M${px.toFixed(1)},${py.toFixed(1)} L${elbow},${labelY.toFixed(1)} L${end},${labelY.toFixed(1)}`);
    item.dot.setAttribute('cx', px.toFixed(1)); item.dot.setAttribute('cy', py.toFixed(1));
  }
  function rotate(angle) {
    coast = null;
    fitTween = null;
    const sphere = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    rotationTween = { start: performance.now(), from: sphere.theta, to: sphere.theta + angle, phi: sphere.phi, radius: sphere.radius };
  }
  $('back-overview').addEventListener('click', () => { clearFocus(); fitView(true); $('announcement').textContent = '已返回爆炸图，鞋子保持展开。'; });
  $('reset').addEventListener('click', () => {
    if (!state.ready || state.printing || state.resetting) return;
    const poses = captureAssemblyLayout(meshes);
    clearFocus();
    coast = null; rotationTween = null;
    state.target = 0;
    const newTarget = preferredTarget(0);
    const newPosition = originalDirection.clone().multiplyScalar(fitDistance(0)).add(newTarget);
    if (reduceMotion) {
      state.transition = null; fitTween = null; setAmount(0);
      controls.target.copy(newTarget); camera.position.copy(newPosition); controls.update();
      $('announcement').textContent = '鞋子已完整合拢。';
      return;
    }
    state.resetting = true; state.resetProgress = 0;
    state.transition = { rebuild: true, poses, elapsed: 0, from: state.amount, to: 0, duration: RESET_GROW_MS };
    focusNoise.beginAssembly();
    fitTween = { rebuild: true, fromPos: camera.position.clone(), toPos: newPosition, fromTarget: controls.target.clone(), toTarget: newTarget };
    $('reset').disabled = true;
    document.body.dataset.reassembling = 'true';
    document.body.dataset.resetProgress = '0';
    document.querySelector('.intro p').textContent = '所有零件正在同步成型，并汇聚成完整鞋体。';
    $('announcement').textContent = '所有零件正在同步噪波成型并归位。';
    updateUI(); renderDirty = true;
  });

  function hitTest(x, y) {
    const rect = canvas.getBoundingClientRect();
    ndc.set((x - rect.left) / rect.width * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const start = import.meta.env.DEV ? performance.now() : 0;
    const hit = partPicker?.pick(raycaster);
    if (import.meta.env.DEV) document.body.dataset.pickMs = (performance.now() - start).toFixed(3);
    return hit;
  }
  controls.addEventListener('start', () => {
    fitTween = null; rotationTween = null; coast = null;
    dragVelocity.set(0, 0);
    dragSphere.setFromVector3(dragOffset.copy(camera.position).sub(controls.target));
    dragSample = { theta: dragSphere.theta, phi: dragSphere.phi, time: performance.now() };
    lastMotionTime = performance.now();
  });
  controls.addEventListener('change', () => {
    renderDirty = true;
    const now = performance.now();
    lastMotionTime = now;
    if (downPointers.size && dragSample) {
      dragSphere.setFromVector3(dragOffset.copy(camera.position).sub(controls.target));
      const theta = Math.atan2(Math.sin(dragSphere.theta - dragSample.theta), Math.cos(dragSphere.theta - dragSample.theta));
      const phi = dragSphere.phi - dragSample.phi;
      const dt = Math.max(8, now - dragSample.time) / 1000;
      dragVelocity.x = THREE.MathUtils.lerp(dragVelocity.x, THREE.MathUtils.clamp(theta / dt, -3, 3), 0.7);
      dragVelocity.y = THREE.MathUtils.lerp(dragVelocity.y, THREE.MathUtils.clamp(phi / dt, -3, 3), 0.7);
      dragSample = { theta: dragSphere.theta, phi: dragSphere.phi, time: now };
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    downPointers.add(e.pointerId);
    if (downPointers.size > 1) gestureUsedMultiplePointers = true;
    if (e.isPrimary && e.button === 0) {
      pointer = { x: e.clientX, y: e.clientY, travel: 0, time: performance.now(), id: e.pointerId };
      canvas.classList.add('dragging');
    }
    $('part-label').style.display = 'none';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointer) {
      pointer.travel = Math.max(pointer.travel, Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y));
      return;
    }
    // Raycast only on a deliberate click, never on every hover/mouse movement.
  });
  canvas.addEventListener('pointerup', (e) => {
    if (pointer && e.pointerId === pointer.id) {
      const clicked = pointer.travel < 7 && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 7 && performance.now() - pointer.time < 650 && !gestureUsedMultiplePointers;
      if (!clicked && pointer.travel >= 7 && downPointers.size === 1 && !gestureUsedMultiplePointers && !reduceMotion && dragSample && performance.now() - dragSample.time < 90) {
        coast = dragVelocity.clone().multiplyScalar(0.45);
      }
      pointer = null; canvas.classList.remove('dragging');
      if (clicked && state.ready && !state.printing && !state.resetting && !state.transition) {
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) { if (state.amount === 0) expand(); else focusPart(hit.object); }
      }
    }
    downPointers.delete(e.pointerId);
    if (!downPointers.size) gestureUsedMultiplePointers = false;
  });
  function cancelPointer(e) {
    // Normal pointerup releases capture too; do not cancel its short release inertia.
    if (!downPointers.has(e.pointerId)) return;
    downPointers.delete(e.pointerId); pointer = null; coast = null;
    canvas.classList.remove('dragging');
    if (!downPointers.size) gestureUsedMultiplePointers = false;
  }
  canvas.addEventListener('pointercancel', cancelPointer);
  canvas.addEventListener('lostpointercapture', cancelPointer);
  canvas.addEventListener('pointerleave', () => { $('part-label').style.display = 'none'; });
  canvas.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'ArrowLeft', 'ArrowRight', '+', '-', '='].includes(e.key)) e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') expand();
    if (e.key === 'ArrowLeft') rotate(-Math.PI / 8);
    if (e.key === 'ArrowRight') rotate(Math.PI / 8);
    if (['+', '=', '-'].includes(e.key)) {
      fitTween = null; rotationTween = null; coast = null;
      const offset = camera.position.clone().sub(controls.target);
      offset.setLength(THREE.MathUtils.clamp(offset.length() * (e.key === '-' ? 1.12 : 0.89), controls.minDistance, controls.maxDistance));
      camera.position.copy(controls.target).add(offset);
    }
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); showError('图形上下文已中断，请重新加载模型。'); });

  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function frame(now) {
    if (disposed) return;
    requestAnimationFrame(frame);
    const rafDelta = lastRafTime ? now - lastRafTime : 1000 / 60;
    lastRafTime = now;
    if (document.hidden || introCompiling) { lastIntroFrame = now; lastFocusFrame = now; frameBudget = 0; return; }
    // Carry fractional frame time forward; a strict 16.667 ms gate drops 60 Hz frames.
    frameBudget = Math.min(frameBudget + rafDelta, 1000 / 30);
    // Keep only the newest input for the next frame. Uncapped 120/144 Hz drags
    // otherwise enqueue extra GPU work and make the camera feel behind the hand.
    if (frameBudget < 1000 / 60 - 0.75) return;
    frameBudget = Math.max(0, frameBudget - 1000 / 60);
    const frameDelta = lastFocusFrame ? now - lastFocusFrame : rafDelta;
    if (printIntro) {
      while (gpuQueries.length && benchGL.getQueryParameter(gpuQueries[0], benchGL.QUERY_RESULT_AVAILABLE)) {
        const query = gpuQueries.shift();
        if (introBenchmark && !benchGL.getParameter(gpuTimer.GPU_DISJOINT_EXT)) introBenchmark.gpuMs.push(benchGL.getQueryParameter(query, benchGL.QUERY_RESULT) / 1e6);
        benchGL.deleteQuery(query);
      }
      if (introBenchmark) {
        if (introBenchmark.last !== null) introBenchmark.frames.push(now - introBenchmark.last);
        introBenchmark.last = now;
      }
      const delta = now - lastIntroFrame;
      const progress = printIntro.update(Math.min(64, delta), state.height, renderer.getPixelRatio(), reviewProgress);
      lastIntroFrame = now;
      // Only the temporary intro buffer adapts. Restore normal detail for inspection.
      introFrameTotal += delta; introFrameCount++;
      if (introFrameCount >= 30) {
        if (introFrameTotal / introFrameCount > 28 && renderer.getPixelRatio() > 0.65) {
          renderer.setPixelRatio(Math.max(0.65, renderer.getPixelRatio() - 0.12));
        }
        introFrameTotal = 0; introFrameCount = 0;
      }
      renderDirty = true;
      const percent = Math.round(progress * 100);
      if (percent !== printPercent) {
        printPercent = percent;
        $('print-progress').textContent = `${percent}%`;
        document.body.dataset.introProgress = String(percent);
      }
      if (progress >= 1) finishPrintIntro();
    }
    if (state.transition) {
      const t = state.transition;
      if (t.rebuild) {
        t.elapsed += Math.min(64, lastFocusFrame ? now - lastFocusFrame : rafDelta);
        const p = Math.min(1, t.elapsed / t.duration);
        state.resetProgress = p;
        applyAssemblyLayout(t.poses, p);
        state.amount = t.from * (1 - THREE.MathUtils.smoothstep(p, 0, 1));
        focusNoise.setAssemblyProgress(p);
        const resetPercent = String(Math.round(p * 100));
        const resetStage = p < .3 ? 'start' : p < .8 ? 'middle' : 'end';
        if (document.body.dataset.resetProgress !== resetPercent) document.body.dataset.resetProgress = resetPercent;
        if (document.body.dataset.resetStage !== resetStage) document.body.dataset.resetStage = resetStage;
        updateUI(); renderDirty = true;
        if (p === 1) {
          state.transition = null; state.resetting = false; setAmount(0);
          $('reset').disabled = false;
          document.body.dataset.reassembling = 'false';
          document.body.dataset.resetStage = 'complete';
          document.querySelector('.intro p').textContent = '点击鞋身展开，探索零件之间的关系。';
          $('announcement').textContent = '所有零件已成型并归位，鞋子已完整合拢。';
        }
      } else {
        const p = Math.min(1, (now - t.start) / t.duration);
        setAmount(THREE.MathUtils.lerp(t.from, t.to, p));
        if (p === 1) { state.transition = null; setAmount(state.target); $('announcement').textContent = state.target === 0 ? '鞋子已完整合拢。' : '结构已展开，可左右拖动查看。'; }
      }
    }
    if (fitTween) {
      const t = fitTween, p = t.rebuild ? state.resetProgress : Math.min(1, (now - t.start) / (t.duration || 1600));
      camera.position.lerpVectors(t.fromPos, t.toPos, ease(p));
      controls.target.lerpVectors(t.fromTarget, t.toTarget, ease(p));
      renderDirty = true;
      if (p === 1) fitTween = null;
    }
    if (rotationTween) {
      const t = rotationTween, p = reduceMotion ? 1 : Math.min(1, (now - t.start) / (t.duration || 500));
      camera.position.setFromSpherical(new THREE.Spherical(t.radius, t.phi, THREE.MathUtils.lerp(t.from, t.to, t.linear ? p : ease(p)))).add(controls.target);
      renderDirty = true;
      if (p === 1) rotationTween = null;
    }
    if (coast) {
      const dt = Math.min(0.05, frameDelta / 1000);
      dragSphere.setFromVector3(dragOffset.copy(camera.position).sub(controls.target));
      dragSphere.theta += coast.x * dt;
      dragSphere.phi = THREE.MathUtils.clamp(dragSphere.phi + coast.y * dt, controls.minPolarAngle, controls.maxPolarAngle);
      camera.position.setFromSpherical(dragSphere).add(controls.target);
      coast.multiplyScalar(Math.exp(-14 * dt));
      if (coast.lengthSq() < 0.0004) coast = null;
      renderDirty = true;
    }
    // Inspection freezes this pose for reliable close-ups; returning resumes it.
    const orbiting = state.ready && !reduceMotion && !state.printing && !state.selected && !state.transition && state.amount === 1;
    if (orbiting) {
      constellationTime += Math.min(64, lastFocusFrame ? now - lastFocusFrame : rafDelta) / 1000;
      for (const mesh of meshes) applyExplodeLayout(mesh, 1, constellationTime);
      renderDirty = true;
    }
    const moving = !!(downPointers.size || coast || state.transition || fitTween || rotationTween || orbiting);
    if (moving) lastMotionTime = now;
    if (!state.printing && renderBudget.update(now, lastFocusFrame ? now - lastFocusFrame : rafDelta,
        moving || !!focusNoise?.forming, moving || (!!state.selected && !reduceMotion) || !!focusNoise?.forming)) renderDirty = true;
    if (!state.printing && quality?.setMoving(moving || now - lastMotionTime < 160 || !!focusNoise?.forming, state.selected, highDetail)) renderDirty = true;
    controls.update();
    const annotationsDirty = renderDirty;
    const wasForming = focusNoise?.forming;
    // RAF may run at 120/144 Hz while we draw at 60. Include skipped RAF time
    // so the 5.4-second print never becomes slower on a high-refresh display.
    const focusDelta = frameDelta;
    lastFocusFrame = now;
    if (focusNoise?.update(focusDelta, state.height, renderer.getPixelRatio())) renderDirty = true;
    if (wasForming && !focusNoise.forming && state.selected) $('announcement').textContent = `${state.selected.userData.label}已成型，可以拖动查看细节。`;
    if (renderDirty) {
      // Particle motion alone never triggers label layout or DOM writes.
      if (!state.printing && annotationsDirty && (now - lastCalloutTime > 1000 / 30 || !moving)) { updateCallouts(); lastCalloutTime = now; }
      const renderStart = measureIntro ? performance.now() : 0;
      const query = introBenchmark && gpuTimer && gpuQueries.length < 8 ? benchGL.createQuery() : null;
      if (query) benchGL.beginQuery(gpuTimer.TIME_ELAPSED_EXT, query);
      renderer.render(scene, camera); renderDirty = false; renderCount++;
      if (query) { benchGL.endQuery(gpuTimer.TIME_ELAPSED_EXT); gpuQueries.push(query); }
      if (introBenchmark) introBenchmark.renderMs += performance.now() - renderStart;
      if (rotationProbe) {
        const b = rotationProbe;
        if (b.last !== null) b.frames.push(now - b.last);
        b.last = now; b.cpu += performance.now() - renderStart;
        if (now - b.start >= 4000) {
          const sorted = [...b.frames].sort((a,b)=>a-b);
          document.body.dataset.rotationProfile = JSON.stringify({frames:b.frames.length, medianMs:sorted[Math.floor(sorted.length * .5)], p95Ms:sorted[Math.floor(sorted.length * .95)], cpuMs:b.cpu/Math.max(1,b.frames.length), triangles:renderer.info.render.triangles,pixelRatio:renderer.getPixelRatio(),width:state.width,height:state.height});
          document.body.dataset.rotationTest = 'complete'; rotationProbe = null;
        }
      }
      if (profileRotation) {
        // Measure the detail material too: an idle camera still draws the living noise.
        if (!state.selected || moving || quality?.moving) focusProbe = null;
        else {
          const id = state.selected.userData.part_id;
          if (!focusProbe || focusProbe.id !== id) focusProbe = { id, last: now, frames: [], cpu: 0, done: false };
          const b = focusProbe;
          if (!b.done && now !== b.last) {
            b.frames.push(now - b.last); b.last = now; b.cpu += performance.now() - renderStart;
            if (b.frames.length === 120) {
              const sorted = [...b.frames].sort((a,b) => a-b);
              document.body.dataset.focusNoiseProfile = JSON.stringify({ part: id, frames: 120, medianMs: sorted[60], p95Ms: sorted[114], cpuMs: b.cpu / 120, triangles: renderer.info.render.triangles, points: focusNoise.count });
              b.done = true;
            }
          }
        }
      }
      if (import.meta.env.DEV && now - lastDiagnosticsTime > 120) {
        lastDiagnosticsTime = now;
        document.body.dataset.pixelRatio = String(renderer.getPixelRatio());
        document.body.dataset.budgetTier = String(renderBudget.tier);
        document.body.dataset.drawnPoints = String(renderer.info.render.points);
        document.body.dataset.renderCount = String(renderCount);
        document.body.dataset.triangles = String(renderer.info.render.triangles);
        document.body.dataset.renderQuality = quality?.moving ? 'motion' : 'detail';
        document.body.dataset.cameraTheta = String(controls.getAzimuthalAngle());
        document.body.dataset.coasting = String(!!coast);
        document.body.dataset.focusNoisePoints = String(focusNoise?.count || 0);
        document.body.dataset.focusNoiseTime = (focusNoise?.time || 0).toFixed(3);
        document.body.dataset.orbitTime = constellationTime.toFixed(3);
        document.body.dataset.orbiting = String(orbiting);
        document.body.dataset.focusFormation = String(Math.round((focusNoise?.progress ?? 1) * 100));
        document.body.dataset.focusFormationDuration = String(focusNoise?.durationMs || 0);
        document.body.dataset.focusFormationStage = !focusNoise?.forming ? 'complete' : focusNoise.progress < 0.3 ? 'start' : focusNoise.progress < 0.8 ? 'middle' : 'end';
        document.body.dataset.focusDissolving = String(focusNoise?.dissolvingCount || 0);
        document.body.dataset.focusDissolveDuration = String(focusNoise?.dissolveDurationMs || 0);
        document.body.dataset.focusDissolveStage = !focusNoise?.dissolvingCount ? 'complete' : focusNoise.dissolveProgress < 0.35 ? 'start' : focusNoise.dissolveProgress < 0.8 ? 'middle' : 'end';
        document.body.dataset.solidParts = String(meshes.filter(mesh => mesh.visible).length);
        if (state.selected) document.body.dataset.selectedTriangles = String(state.selected.geometry.index.count / 3);
      }
    }
  }
  requestAnimationFrame(frame);

  try {
    const gltf = await loader.loadAsync(modelURL, e => {
      const ratio = e.total ? e.loaded / e.total : 0.5;
      $('load-progress').style.width = `${Math.round(ratio * 90)}%`;
      $('loading-text').textContent = ratio >= 1 ? '正在展开模型数据' : `正在加载模型 ${Math.round(ratio * 100)}%`;
    });
    scene.add(gltf.scene);
    gltf.scene.traverse(object => {
      if (!object.isMesh) return;
      const part = PARTS[object.userData.part_id];
      if (!part) throw new Error(`Unknown part: ${object.name}`);
      object.updateMatrix();
      prepareExplodeLayout(object, part);
      object.userData.label = part.label;
      object.material = object.material.clone();
      object.userData.originalOpacity = object.material.opacity;
      object.userData.originalTransparent = object.material.transparent;
      object.userData.originalTransmission = object.material.transmission || 0;
      // Low transmission would otherwise trigger a second full-scene render.
      if (object.material.transmission) object.material.transmission = 0;
      object.userData.previewGeometry = object.geometry;
      object.castShadow = true; object.receiveShadow = true;
      object.material.envMapIntensity = 0.65;
      object.material.side = THREE.DoubleSide;
      object.material.forceSinglePass = true;
      // Preserve Blender colors and material values; soften only lighting through the studio environment.
      meshes.push(object);
    });
    if (meshes.length !== 10) throw new Error('The source assembly must contain ten parts.');
    configureExplodeOrbit(meshes);
    meshes.forEach(createCallout);
    introCompiling = true;
    quality = createRenderQuality(scene, meshes, await introGeometryPromise);
    partPicker = await createPartPicker(meshes);
    const focusSamples = await focusSamplesPromise;
    if (!focusSamples) throw new Error('Focus particle data could not load.');
    focusNoise = createFocusNoise(scene, meshes, focusSamples, { mobile: state.width <= 600, reduceMotion, materialsFor: quality.materialsFor });
    setAmount(0); fitView(false);
    focusNoise.prepare();
    quality.setMoving(true, null, null);
    await warmScene();
    quality.setMoving(false, null, null);
    await warmScene();
    focusNoise.setFocus(null);
    introCompiling = false;
    state.ready = true;
    setAmount(0); fitView(false);
    $('load-progress').style.width = '100%';
    $('loading').classList.add('done');
    $('loading').setAttribute('aria-hidden', 'true');
    document.body.dataset.ready = 'true';
    renderDirty = true;
    await startPrintIntro();
  } catch (error) {
    introCompiling = false;
    console.error('Model loading failed:', error);
    showError('加载失败，请检查网络连接并重新加载。也可以使用交付文件夹里的启动脚本打开网站。');
  }
  if (import.meta.hot) import.meta.hot.dispose(() => { disposed = true; partPicker?.dispose(); printIntro?.dispose(); focusNoise?.dispose(); quality?.dispose(); controls.dispose(); renderer.dispose(); });
}
