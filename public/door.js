// "The Door": the doorway backdrop and its states. Decorative only (aria-hidden); every message
// it shows is also given in the page's own status line.
//
// States: closed (before verification), ajar (age answer accepted), open (ticket issued),
// wide (admitted at the gate), locked (refused). The CSS reads data-door on <html>.
// On pages that ask for it, a three.js scene is loaded lazily on capable devices only.

const CAPTIONS = {
  closed: 'Your door opens when your age is confirmed',
  ajar: 'Age confirmed. Your door is opening.',
  open: 'Ticket issued. See you at the door.',
  wide: 'Welcome in',
  locked: 'Locked: age not confirmed',
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let caption = null;
let scene = null;
let stageEl = null;
let state = 'closed';
let starting = false;

export function setDoor(next, text) {
  state = next;
  document.documentElement.dataset.door = next;
  if (caption) caption.textContent = text ?? CAPTIONS[next] ?? '';
  scene?.setDoor(next);
}

/** Opens in two beats (accepted, then issued) unless reduced motion is on. Never blocks input. */
export function openInSteps(final = 'open', text) {
  if (reducedMotion.matches) return setDoor(final, text);
  setDoor('ajar');
  setTimeout(() => { if (state === 'ajar') setDoor(final, text); }, 360);
}

const DOORWAY = `
  <div class="doorway">
    <div class="doorway-haze"></div>
    <div class="doorway-arch"><div class="door-leaf"><span class="door-knob"></span></div></div>
    <div class="doorway-floor"></div>
    <div class="door-lock"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg></div>
  </div>
  <div class="stage-ticket">
    <div class="stage-ticket-inner">
      <div class="stage-ticket-face stage-ticket-front">
        <span class="st-kicker">Admit one · 21+</span>
        <span class="st-name"></span>
        <span class="st-meta"></span>
        <span class="st-stub">Buy to Door</span>
      </div>
      <div class="stage-ticket-face stage-ticket-back"><span class="st-qr"></span><span class="st-stub">Show at the door</span></div>
    </div>
  </div>
  <p class="door-caption"></p>`;

/**
 * Fills a .stage element with the doorway. `threeD: true` lazy-loads the 3D ticket when the
 * device can handle it; otherwise the pure-CSS ticket and doorway stay.
 */
export function mountStage(stage, { event, threeD = false } = {}) {
  stageEl = stage;
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = DOORWAY;
  caption = stage.querySelector('.door-caption');
  if (event) {
    stage.querySelector('.st-name').textContent = event.name;
    stage.querySelector('.st-meta').textContent = `${event.date} · ${event.venue}`;
  }
  setDoor(document.documentElement.dataset.door || 'closed');
  if (threeD) {
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 500));
    idle(() => start3D(event), { timeout: 2500 });
    reducedMotion.addEventListener?.('change', () => (reducedMotion.matches ? stop3D() : start3D(event)));
  }
}

/** WebGL2 without a major performance caveat (software rendering counts as one), on a non-tiny device. */
function canRun3D() {
  if (reducedMotion.matches) return false;
  if (navigator.connection?.saveData) return false;
  if ((navigator.hardwareConcurrency || 4) < 4) return false;
  if (navigator.deviceMemory && navigator.deviceMemory < 2) return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function start3D(event) {
  if (scene || starting || !stageEl || !canRun3D()) return;
  starting = true;
  try {
    const { mountDoorScene } = await import('/js/door-scene.js');
    if (reducedMotion.matches) return;
    scene = await mountDoorScene(stageEl, { event, door: state, onFail: stop3D });
    stageEl.classList.add('is-3d');
  } catch {
    stop3D(); // any failure leaves the CSS doorway in place
  } finally {
    starting = false;
  }
}

function stop3D() {
  scene?.destroy();
  scene = null;
  stageEl?.classList.remove('is-3d');
}
