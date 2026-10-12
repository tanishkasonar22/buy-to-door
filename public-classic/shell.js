// Shared page header, and a banner that says plainly when verification is simulated.
export async function initShell(current) {
  const header = document.createElement('header');
  header.className = 'topnav';
  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/';
  brand.textContent = 'Buy to Door';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  for (const [href, text] of [['/', 'Shop'], ['/gate.html', 'Gate'], ['/dashboard.html', 'Dashboard'], ['/readiness.html', 'Readiness']]) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    if (href === current) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  header.append(brand, nav);
  document.body.prepend(header);

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
