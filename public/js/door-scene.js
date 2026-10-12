// The 3D ticket floating in front of the doorway. Loaded lazily by door.js on capable devices only.
// Decorative: the canvas is inside an aria-hidden stage and nothing on the page depends on it.
//
// Performance rules: pixel ratio capped at 2, rendering paused when the tab is hidden or the stage
// is off screen, and a watchdog that hands back to the CSS version if frames are consistently slow.

import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Clock,
  DirectionalLight,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  WebGLRenderer,
} from '/vendor/three/three.module.min.js';

const W = 3.2;            // ticket width in scene units (2:1 like a real stub)
const H = 1.6;
const CORNER = 0.12;
const NOTCH = 0.14;
const TEAR = 0.7;         // tear line at 70% of the width
const DEPTH = 0.03;
const BEVEL = 0.008;

// What each door state does to the scene.
const LOOK = {
  closed: { light: 5, dust: 0.28, flip: 0, lift: 0 },
  ajar: { light: 14, dust: 0.5, flip: 0.35, lift: 0.05 },
  open: { light: 24, dust: 0.75, flip: Math.PI, lift: 0.12 },
  wide: { light: 34, dust: 0.95, flip: Math.PI, lift: 0.18 },
  locked: { light: 1.5, dust: 0.08, flip: 0, lift: -0.04 },
};

/** Ticket outline with half-circle notches where the stub tears off. */
function ticketShape(tearX) {
  const x0 = -W / 2, x1 = W / 2, y0 = -H / 2, y1 = H / 2;
  const s = new Shape();
  s.moveTo(x0 + CORNER, y0);
  s.lineTo(tearX - NOTCH, y0);
  s.absarc(tearX, y0, NOTCH, Math.PI, 0, true);
  s.lineTo(x1 - CORNER, y0);
  s.absarc(x1 - CORNER, y0 + CORNER, CORNER, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - CORNER);
  s.absarc(x1 - CORNER, y1 - CORNER, CORNER, 0, Math.PI / 2, false);
  s.lineTo(tearX + NOTCH, y1);
  s.absarc(tearX, y1, NOTCH, 0, Math.PI, true);
  s.lineTo(x0 + CORNER, y1);
  s.absarc(x0 + CORNER, y1 - CORNER, CORNER, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + CORNER);
  s.absarc(x0 + CORNER, y0 + CORNER, CORNER, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Small deterministic random, so the pattern is the same on every visit. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grain(ctx, w, h, alpha) {
  const r = rng(7);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = r() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(60,35,0,${alpha})`;
    ctx.fillRect(r() * w, r() * h, 1.5, 1.5);
  }
}

function tearLine(ctx, x, h, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 12]);
  ctx.beginPath();
  ctx.moveTo(x, 70);
  ctx.lineTo(x, h - 70);
  ctx.stroke();
  ctx.restore();
}

function frontTexture(event) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1024, 512);
  g.addColorStop(0, '#ffd889');
  g.addColorStop(0.55, '#f5b544');
  g.addColorStop(1, '#e3922a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  grain(ctx, 1024, 512, 0.08);
  const display = '"Bricolage Grotesque", system-ui, sans-serif';
  ctx.fillStyle = '#24180a';
  ctx.font = `800 26px ${display}`;
  ctx.fillText('ADMIT ONE  ·  21+', 64, 96);
  ctx.font = `800 88px ${display}`;
  const name = (event?.name ?? 'Harbor Nights').toUpperCase();
  ctx.fillText(name, 60, 250, 610);
  ctx.font = `600 30px ${display}`;
  ctx.fillText(event?.date ?? '', 64, 330, 610);
  ctx.fillText(event?.venue ?? '', 64, 374, 610);
  ctx.font = `700 22px ${display}`;
  ctx.globalAlpha = 0.75;
  ctx.fillText('Demo ticket. No payment taken.', 64, 452);
  ctx.globalAlpha = 1;
  tearLine(ctx, 1024 * TEAR, 512, 'rgba(36,24,10,0.45)');
  ctx.save();
  ctx.translate(1024 * TEAR + 150, 256);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = `800 34px ${display}`;
  ctx.fillText('BUY TO DOOR', 0, 12);
  ctx.restore();
  return finish(c);
}

function backTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff4dc';
  ctx.fillRect(0, 0, 1024, 512);
  grain(ctx, 1024, 512, 0.05);
  // A QR-like pattern. Decorative only: it encodes nothing. The real code is on the page.
  const n = 25, size = 330, cell = size / n, ox = 1024 - 1024 * TEAR + 70, oy = (512 - size) / 2;
  const r = rng(42);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox - 18, oy - 18, size + 36, size + 36);
  ctx.fillStyle = '#1a1206';
  const finder = (fx, fy) => {
    ctx.fillRect(ox + fx * cell, oy + fy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox + (fx + 1) * cell, oy + (fy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(ox + (fx + 2) * cell, oy + (fy + 2) * cell, 3 * cell, 3 * cell);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
      if (!inFinder && r() > 0.52) ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.5, cell + 0.5);
    }
  }
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  // On the back the stub is on the left, so the tear line mirrors.
  tearLine(ctx, 1024 * (1 - TEAR), 512, 'rgba(36,24,10,0.35)');
  ctx.save();
  ctx.translate(1024 * (1 - TEAR) - 150, 256);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#24180a';
  ctx.font = '800 30px "Bricolage Grotesque", system-ui, sans-serif';
  ctx.fillText('SHOW AT THE DOOR', 0, 10);
  ctx.restore();
  return finish(c);
}

function finish(canvas) {
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  // Shape UVs are the raw x/y coordinates, so map the ticket's extent onto 0..1.
  t.repeat.set(1 / W, 1 / H);
  t.offset.set(0.5, 0.5);
  return t;
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,240,210,1)');
  g.addColorStop(0.4, 'rgba(255,212,138,0.55)');
  g.addColorStop(1, 'rgba(255,212,138,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export async function mountDoorScene(stage, { event, door = 'closed', onFail = () => {} } = {}) {
  try { await document.fonts?.ready; } catch { /* draw with the fallback font */ }

  const canvas = document.createElement('canvas');
  canvas.className = 'door-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.prepend(canvas);

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.set(0, 0.2, 6.4);

  scene.add(new AmbientLight(0xffffff, 0.75));
  const key = new DirectionalLight(0xfff3e0, 1.6);
  key.position.set(2.5, 3, 5);
  scene.add(key);
  const doorLight = new PointLight(0xffc870, LOOK[door]?.light ?? 5, 12, 1.6);
  doorLight.position.set(0, 0.9, -2.2);
  scene.add(doorLight);

  // The ticket: a thin extruded body plus a printed face on each side.
  const tearX = -W / 2 + W * TEAR;
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const body = keep(new ExtrudeGeometry(ticketShape(tearX), { depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 2, curveSegments: 18 }));
  body.translate(0, 0, -DEPTH / 2);
  const bodyMat = keep(new MeshStandardMaterial({ color: 0xf2d9a8, roughness: 0.75, metalness: 0 }));
  const frontGeo = keep(new ShapeGeometry(ticketShape(tearX), 18));
  const backGeo = keep(new ShapeGeometry(ticketShape(-tearX), 18));
  const frontMap = keep(frontTexture(event));
  const backMap = keep(backTexture());
  const frontMat = keep(new MeshStandardMaterial({ map: frontMap, roughness: 0.55, metalness: 0.04 }));
  const backMat = keep(new MeshStandardMaterial({ map: backMap, roughness: 0.6, metalness: 0 }));
  const front = new Mesh(frontGeo, frontMat);
  front.position.z = DEPTH / 2 + BEVEL + 0.002;
  const back = new Mesh(backGeo, backMat);
  back.rotation.y = Math.PI;
  back.position.z = -(DEPTH / 2 + BEVEL + 0.002);
  const ticket = new Group();
  ticket.add(new Mesh(body, bodyMat), front, back);
  const rig = new Group();
  rig.add(ticket);
  rig.position.set(0, -0.62, 0.4);
  scene.add(rig);

  // Dust in the door light.
  const COUNT = 220;
  const pos = new Float32Array(COUNT * 3);
  const speed = new Float32Array(COUNT);
  const r = rng(3);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (r() - 0.5) * 5.5;
    pos[i * 3 + 1] = (r() - 0.5) * 4.6;
    pos[i * 3 + 2] = -2.4 + r() * 3.4;
    speed[i] = 0.04 + r() * 0.12;
  }
  const dustGeo = keep(new BufferGeometry());
  dustGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const dustMap = keep(dotTexture());
  const dustMat = keep(new PointsMaterial({ map: dustMap, size: 0.09, sizeAttenuation: true, transparent: true, opacity: LOOK[door]?.dust ?? 0.3, depthWrite: false, blending: AdditiveBlending }));
  scene.add(new Points(dustGeo, dustMat));

  // State, eased every frame toward its target.
  let look = LOOK[door] ?? LOOK.closed;
  const now = { light: look.light, dust: look.dust, flip: look.flip, lift: look.lift, tx: 0, ty: 0 };
  const pointer = { x: 0, y: 0 };
  const onPointer = (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  const onTilt = (e) => {
    if (e.gamma == null) return;
    pointer.x = MathUtils.clamp(e.gamma / 30, -1, 1);
    pointer.y = MathUtils.clamp((e.beta - 45) / 30, -1, 1);
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('deviceorientation', onTilt, { passive: true });

  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Keep the whole ticket in view on narrow screens.
    rig.scale.setScalar(MathUtils.clamp(camera.aspect / 1.15, 0.58, 1));
    // On narrow stages, lift the ticket clear of the caption at the bottom.
    rig.position.y = camera.aspect < 1.2 ? -0.42 : -0.62;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  const clock = new Clock();
  let t = 0;
  let frames = [];
  let watching = true;
  let failed = false;
  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    t += dt;
    if (watching && t > 1) {
      frames.push(dt);
      if (frames.length >= 90) {
        const sorted = frames.sort((a, b) => a - b);
        watching = false;
        // Median under ~28 fps on this device: hand back to the CSS version.
        if (sorted[45] > 1 / 28) return fail();
      }
    }
    const k = 1 - Math.exp(-dt * 5);
    now.light += (look.light - now.light) * k;
    now.dust += (look.dust - now.dust) * k;
    now.flip += (look.flip - now.flip) * k;
    now.lift += (look.lift - now.lift) * k;
    now.tx += (pointer.x - now.tx) * k;
    now.ty += (pointer.y - now.ty) * k;

    doorLight.intensity = now.light;
    dustMat.opacity = now.dust;
    ticket.rotation.y = now.flip + now.tx * 0.32 + Math.sin(t * 0.6) * 0.05;
    ticket.rotation.x = -0.12 + now.ty * 0.16 + Math.sin(t * 0.8) * 0.03;
    ticket.rotation.z = -0.05 + Math.sin(t * 0.5) * 0.015;
    ticket.position.y = now.lift + Math.sin(t * 0.9) * 0.06;

    const p = dustGeo.attributes.position.array;
    for (let i = 0; i < COUNT; i++) {
      p[i * 3 + 1] += speed[i] * dt * (0.4 + now.dust);
      p[i * 3] += Math.sin(t * 0.3 + i) * 0.0015;
      if (p[i * 3 + 1] > 2.4) p[i * 3 + 1] = -2.3;
    }
    dustGeo.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
  };

  // Render only while the stage is on screen and the tab is visible.
  let onScreen = true;
  const sync = () => {
    const run = onScreen && !document.hidden && !failed;
    if (run) clock.getDelta();
    renderer.setAnimationLoop(run ? tick : null);
  };
  const io = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; sync(); });
  io.observe(stage);
  document.addEventListener('visibilitychange', sync);
  const onLost = (e) => { e.preventDefault(); fail(); };
  canvas.addEventListener('webglcontextlost', onLost);
  sync();

  function destroy() {
    renderer.setAnimationLoop(null);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('deviceorientation', onTilt);
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const d of disposables) d.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  function fail() {
    if (failed) return;
    failed = true;
    onFail();
  }

  return {
    setDoor(state) { look = LOOK[state] ?? LOOK.closed; },
    destroy,
  };
}
