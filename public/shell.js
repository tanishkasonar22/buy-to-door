// Shared page header, the journey rail, the theme toggle, and a banner that says plainly when
// verification is simulated.

const SVG = 'http://www.w3.org/2000/svg';

function svg(markup, cls, viewBox) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = markup;
  return s;
}

/** The small door mark used in the brand and on the gate. */
export function doorIcon(cls = 'brand-door') {
  return svg(
    '<rect class="frame" x="2" y="2" width="18" height="24" rx="9" ry="9"/>' +
      '<rect class="light" x="5" y="5" width="12" height="19" rx="6" ry="6"/>' +
      '<path class="leaf" d="M5 11a6 6 0 0 1 6-6v19H5z"/>',
    cls,
    '0 0 22 28',
  );
}

const CHECK = '<path class="icon-check" d="M2.5 6.5l2.2 2.2L9.5 3.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const LOCK = '<g class="icon-lock" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="currentColor"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></g>';

const STEPS = [
  ['buy', 'Buy'],
  ['verify', 'Verify'],
  ['ticket', 'Ticket'],
  ['door', 'Door'],
];
const SR_STATE = { current: ', current step', done: ', done', later: ', at the door', blocked: ', not passed', todo: '' };
const NOTE = { later: 'at the door', blocked: 'not passed' };

let rail = null;

/**
 * Updates the journey rail: Buy → Verify → Ticket → Door. Decorative progress only;
 * it never changes routes. States: todo, current, done, later, blocked.
 */
export function setJourney(states = {}) {
  if (!rail) return;
  for (const [id] of STEPS) {
    const li = rail.querySelector(`[data-step="${id}"]`);
    const state = states[id] ?? 'todo';
    li.dataset.state = state;
    li.querySelector('.visually-hidden').textContent = SR_STATE[state] ?? '';
    li.querySelector('.journey-note').textContent = NOTE[state] ?? '';
    if (state === 'current') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function buildRail() {
  const ol = document.createElement('ol');
  ol.className = 'journey';
  ol.setAttribute('aria-label', 'Ticket journey');
  for (const [id, text] of STEPS) {
    const li = document.createElement('li');
    li.dataset.step = id;
    li.dataset.state = 'todo';
    const dot = document.createElement('span');
    dot.className = 'journey-dot';
    dot.append(svg(CHECK + LOCK, '', '0 0 12 12'));
    const name = document.createElement('span');
    name.className = 'journey-label';
    name.textContent = text;
    const note = document.createElement('span');
    note.className = 'journey-note';
    note.setAttribute('aria-hidden', 'true');
    const sr = document.createElement('span');
    sr.className = 'visually-hidden';
    li.append(dot, name, note, sr);
    ol.append(li);
  }
  return ol;
}

const effectiveTheme = () => {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

function buildThemeToggle() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  const sun = svg('<circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>', '', '0 0 24 24');
  const moon = svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor"/>', '', '0 0 24 24');
  const sync = () => {
    const dark = effectiveTheme() === 'dark';
    btn.replaceChildren(dark ? sun : moon);
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  };
  btn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('b2d-theme', next); } catch { /* not remembered, still applied */ }
    sync();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', sync);
  sync();
  return btn;
}

/**
 * Builds the header. `options.journey` sets the starting rail state for this page.
 * `options.minimal` (the phone wallet page) shows only the brand, theme toggle and rail,
 * and skips the config request. Returns the server config, or null.
 */
export async function initShell(current, options = {}) {
  const header = document.createElement('header');
  header.className = 'topnav';
  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/';
  brand.append(doorIcon(), document.createTextNode('Buy to Door'));
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  for (const [href, text] of [['/', 'Shop'], ['/gate.html', 'Gate'], ['/dashboard.html', 'Dashboard'], ['/readiness.html', 'Readiness']]) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    if (href === current) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  rail = buildRail();
  header.append(brand, ...(options.minimal ? [] : [nav]), buildThemeToggle(), rail);
  document.body.prepend(header);
  setJourney(options.journey ?? {});
  if (options.minimal) return null;

  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    if (config.mode !== 'real') {
      const banner = document.createElement('div');
      banner.className = 'sim-banner';
      banner.setAttribute('role', 'note');
      banner.textContent = config.mode === 'hybrid'
        ? 'Hybrid mode: requests go to the real Credence ID Cloud SDK. The wallet answer is simulated with a test credential. This is not a real ID check.'
        : 'Simulated mode: wallet checks use a test credential. This is not a real ID check.';
      header.after(banner);
    }
    return config;
  } catch {
    return null;
  }
}
