// Works out which Credence ID Cloud SDK wallet flows a visitor's browser can use.
// Rules come from the Cloud SDK Integration Guide:
//   Flows A and B (Digital Credentials API) need Chrome 141+ (Android 9+ or desktop) or
//   Safari 17.4+ on iOS 17.4+. Chrome 128-140 works only with a flag. They do not work in
//   Firefox or in-app webviews.
//   Flows C (Samsung Wallet, QR or deep link) and D (CA DMV mDL app, OpenID4VP) work in any browser.
// This is a plain ES module with no DOM access, so tests can import it directly.

const num = (v) => (v === undefined ? null : Number(v));

export function parseBrowser(ua = '') {
  const iosMatch = ua.match(/\b(?:iPhone|iPad|iPod)\b.*?OS (\d+)[_.](\d+)/);
  const androidMatch = ua.match(/Android (\d+)/);
  const chromeMatch = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
  const safariMatch = ua.match(/Version\/(\d+)\.(\d+)/);
  const isIOS = /\b(?:iPhone|iPad|iPod)\b/.test(ua);
  const isAndroid = !!androidMatch;
  const firefox = /Firefox\/|FxiOS\//.test(ua);
  const edge = /Edg(?:e|A|iOS)?\//.test(ua);
  const iosChrome = /CriOS\//.test(ua);
  const inApp =
    /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\/|Snapchat|TikTok|; wv\)/.test(ua) ||
    (isIOS && !/Safari\//.test(ua));
  const safari =
    /Safari\//.test(ua) && !!safariMatch && !chromeMatch && !iosChrome && !firefox && !edge;

  return {
    ua,
    isIOS,
    isAndroid,
    iosVersion: iosMatch ? [num(iosMatch[1]), num(iosMatch[2])] : null,
    androidVersion: androidMatch ? num(androidMatch[1]) : null,
    chromeVersion: chromeMatch && !iosChrome ? num(chromeMatch[1]) : null,
    safariVersion: safari && safariMatch ? [num(safariMatch[1]), num(safariMatch[2])] : null,
    firefox,
    edge,
    iosChrome,
    inApp,
    safari,
  };
}

const atLeast = (version, major, minor) => !!version && (version[0] > major || (version[0] === major && version[1] >= minor));

/** The browser-level rule shared by flows A and B. */
function dcApiSupport(b) {
  if (b.inApp) return { status: 'unsupported', reason: 'In-app browsers cannot use the Digital Credentials API. Open the page in Safari or Chrome.' };
  if (b.firefox) return { status: 'unsupported', reason: 'Firefox does not support the Digital Credentials API.' };
  if (b.iosChrome) return { status: 'unsupported', reason: 'Chrome on iPhone uses Apple\'s engine. Use Safari 17.4 or later.' };
  if (b.safari) {
    return b.isIOS && atLeast(b.iosVersion, 17, 4) && atLeast(b.safariVersion, 17, 4)
      ? { status: 'supported', reason: 'Safari 17.4 or later on iOS 17.4 or later.' }
      : { status: 'unsupported', reason: 'Safari needs to be version 17.4 or later on iOS 17.4 or later.' };
  }
  if (b.chromeVersion !== null) {
    if (b.chromeVersion >= 141) return { status: 'supported', reason: `Chrome ${b.chromeVersion} is new enough.` };
    if (b.chromeVersion >= 128) return { status: 'needs_flag', reason: `Chrome ${b.chromeVersion} works only after the Digital Credentials flag is enabled.` };
    return { status: 'unsupported', reason: `Chrome ${b.chromeVersion} is too old. Chrome 141 or later is needed.` };
  }
  return { status: 'unsupported', reason: 'This browser is not on the supported list.' };
}

export function detectFlows(ua) {
  const b = parseBrowser(ua);
  const dc = dcApiSupport(b);

  // The browser only makes the wallet prompt possible. Which wallet appears depends on the device.
  const flowA = { id: 'A', name: 'Apple Wallet', protocol: 'Digital Credentials API, ISO mdoc', ...dc };
  const flowB = { id: 'B', name: 'Google Wallet', protocol: 'Digital Credentials API, OpenID4VP', ...dc };
  if (dc.status === 'supported') {
    flowA.reason = b.isIOS ? dc.reason : `${dc.reason} Apple Wallet itself is on iPhone, so use an iPhone for this flow.`;
    flowB.reason = b.isAndroid ? dc.reason : `${dc.reason} Google Wallet IDs live on Android, so use an Android phone for this flow.`;
    if (!b.isIOS) flowA.status = 'check_device';
    if (!b.isAndroid) flowB.status = 'check_device';
  }

  const flows = [
    flowA,
    flowB,
    { id: 'C', name: 'Samsung Wallet', protocol: 'OpenID4VP Annex B, QR or deep link', status: 'supported', reason: 'Works in any browser and on any device.' },
    { id: 'D', name: 'CA DMV mDL app', protocol: 'OpenID4VP with W3C credentials', status: 'supported', reason: 'Works in any browser and on any device.' },
  ];

  const rank = { supported: 0, check_device: 1, needs_flag: 2, unsupported: 3 };
  const best = [...flows].sort((x, y) => rank[x.status] - rank[y.status])[0];
  const recommended = best.status === 'supported' || best.status === 'check_device' ? best.id : 'C';
  return { browser: b, flows, recommended };
}
