import { describe, expect, it } from 'vitest';
import { detectFlows, parseBrowser } from '../public/flows.js';

const UA = {
  iphoneSafari175:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneSafari164:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome142:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  androidWebview:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36',
  desktopChrome142:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  desktopChrome135:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  desktopFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
  desktopSafari17:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

const flow = (ua: string, id: string) => detectFlows(ua).flows.find((f: any) => f.id === id)!;

describe('flow router', () => {
  it('supports Apple Wallet on iPhone Safari 17.4 or later', () => {
    expect(flow(UA.iphoneSafari175, 'A').status).toBe('supported');
    expect(detectFlows(UA.iphoneSafari175).recommended).toBe('A');
  });

  it('rejects old iPhone Safari for the Digital Credentials flows', () => {
    expect(flow(UA.iphoneSafari164, 'A').status).toBe('unsupported');
    expect(flow(UA.iphoneSafari164, 'B').status).toBe('unsupported');
  });

  it('rejects in-app browsers and Chrome on iPhone', () => {
    expect(flow(UA.iphoneInstagram, 'A').status).toBe('unsupported');
    expect(flow(UA.iphoneChrome, 'A').status).toBe('unsupported');
    expect(flow(UA.androidWebview, 'B').status).toBe('unsupported');
  });

  it('supports Google Wallet on Android Chrome 141 or later', () => {
    expect(flow(UA.androidChrome142, 'B').status).toBe('supported');
    expect(detectFlows(UA.androidChrome142).recommended).toBe('B');
  });

  it('flags desktop Chrome 141 or later as needing a device check, not as ready', () => {
    expect(flow(UA.desktopChrome142, 'A').status).toBe('check_device');
    expect(flow(UA.desktopChrome142, 'B').status).toBe('check_device');
  });

  it('says Chrome 128 to 140 needs a flag', () => {
    expect(flow(UA.desktopChrome135, 'A').status).toBe('needs_flag');
  });

  it('rejects Firefox for A and B, and falls back to C', () => {
    expect(flow(UA.desktopFirefox, 'A').status).toBe('unsupported');
    expect(detectFlows(UA.desktopFirefox).recommended).toBe('C');
  });

  it('does not treat desktop Safari as iOS Safari', () => {
    expect(flow(UA.desktopSafari17, 'A').status).toBe('unsupported');
  });

  it('always supports flows C and D', () => {
    for (const ua of Object.values(UA)) {
      expect(flow(ua, 'C').status).toBe('supported');
      expect(flow(ua, 'D').status).toBe('supported');
    }
  });

  it('parses versions', () => {
    const b = parseBrowser(UA.iphoneSafari175);
    expect(b.iosVersion).toEqual([17, 5]);
    expect(b.safariVersion).toEqual([17, 5]);
    expect(parseBrowser(UA.androidChrome142).chromeVersion).toBe(142);
  });

  it('handles an empty user agent', () => {
    expect(detectFlows('').recommended).toBe('C');
  });
});
