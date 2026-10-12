import { CloudSdkError } from './cloudsdk.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped' | 'info';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ReadinessClient {
  ensureToken(): Promise<void>;
  getDocRequest(): Promise<{ sessionId: string; dcRequest: unknown }>;
}

export interface ReadinessInput {
  mode: 'mock' | 'hybrid' | 'real';
  ticketSecret: string;
  licenseKey: string;
  profileId: string;
  origin: string;
  baseUrl?: string;
  client?: ReadinessClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rules from the Cloud SDK key page: public HTTPS only, no localhost, no IP, scheme+host+port. */
export function checkOrigin(origin: string): { ok: boolean; detail: string; fix?: string } {
  if (!origin) {
    return {
      ok: false,
      detail: 'No origin is set.',
      fix: 'Set CLOUDSDK_ORIGIN to the HTTPS address you registered, for example https://your-tunnel.example.',
    };
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, detail: 'The origin is not a valid URL.', fix: 'Use the form https://host with no path.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, detail: 'The origin is not HTTPS.', fix: 'Only public HTTPS domains can be registered.' };
  }
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, detail: 'localhost is rejected by the license.', fix: 'Use an HTTPS tunnel and register that address.' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return { ok: false, detail: 'IP-based origins are rejected by the license.', fix: 'Use a domain name, such as an HTTPS tunnel address.' };
  }
  if (url.origin !== origin.replace(/\/$/, '')) {
    return {
      ok: false,
      detail: 'The origin has a path or other extras.',
      fix: `Use exactly ${url.origin}. Scheme, host and port must match the registered entry.`,
    };
  }
  return { ok: true, detail: `Origin looks valid (${url.origin}).` };
}

export function explainSdkError(e: unknown): { detail: string; fix: string } {
  if (e instanceof CloudSdkError) {
    if (e.code === 'DOMAIN_MISMATCH' || (e.status === 403 && !e.code)) {
      return {
        detail: `The service refused the request (HTTP ${e.status}${e.code ? ', ' + e.code : ''}).`,
        fix: 'The Origin must exactly match an entry in your license allowed-origins list. Subdomains and ports count as separate origins.',
      };
    }
    const known: Record<string, { detail: string; fix: string }> = {
      INVALID_LICENSE_KEY: { detail: 'The license key was not recognised.', fix: 'Copy the key again from the portal. It starts with CS-.' },
      LICENSE_EXPIRED_OR_REVOKED: { detail: 'The license has expired or was revoked.', fix: 'Create a new Evaluation key in the portal.' },
      PROFILE_NOT_FOUND: { detail: 'The profile ID does not exist for this license.', fix: 'Copy the Profile ID again from the Cloud tab.' },
      PROFILE_NOT_SUPPORTED: { detail: 'This profile type is not supported for Apple Wallet requests (HTTP 422).', fix: 'Use a single-document profile.' },
      PLAN_LIMIT_EXCEEDED: { detail: 'Your plan limit was reached.', fix: 'Check usage in the portal.' },
      READER_AUTH_UNAVAILABLE: { detail: 'The service could not load its reader certificate (HTTP 503).', fix: 'Try again shortly, then contact Credence ID.' },
      UPSTREAM_ERROR: { detail: 'The service had an upstream error (HTTP 502).', fix: 'Try again shortly.' },
    };
    if (e.code && known[e.code]) return known[e.code];
    if (e.status === 401) {
      return { detail: 'The license key or profile was not accepted (HTTP 401).', fix: 'Check the license key and Profile ID in the portal Cloud tab.' };
    }
    if (e.status === 404) {
      return { detail: 'The endpoint was not found (HTTP 404).', fix: 'Check CLOUDSDK_BASE_URL. The docs show more than one base path.' };
    }
    if (e.status === 429) {
      return { detail: 'Rate limited (HTTP 429).', fix: 'Wait a moment and run the checks again.' };
    }
    return { detail: `The service returned HTTP ${e.status}.`, fix: 'Check the portal and the API reference, or ask Credence ID support.' };
  }
  return { detail: 'The request did not reach the service.', fix: 'Check your network and CLOUDSDK_BASE_URL.' };
}

export async function runReadiness(input: ReadinessInput): Promise<Check[]> {
  const checks: Check[] = [];
  const real = input.mode !== 'mock';

  checks.push({
    id: 'mode',
    label: 'Verifier mode',
    status: 'info',
    detail: real
      ? input.mode === 'hybrid'
        ? 'Hybrid mode: the server calls the Credence ID Cloud SDK for real. Only the wallet answer is simulated.'
        : 'Real mode: the server calls the Credence ID Cloud SDK.'
      : 'Mock mode: no real ID check happens. Live Cloud SDK checks are skipped.',
  });

  checks.push(
    input.ticketSecret.length >= 16
      ? { id: 'secret', label: 'Ticket signing secret', status: 'pass', detail: 'Set and long enough.' }
      : { id: 'secret', label: 'Ticket signing secret', status: 'fail', detail: 'Missing or shorter than 16 characters.', fix: 'Set TICKET_SIGNING_SECRET to a long random string.' },
  );

  if (!real) {
    for (const [id, label] of [
      ['key', 'License key'],
      ['profile', 'Profile ID'],
      ['origin', 'Registered origin'],
      ['setup', 'Live token setup call'],
      ['request', 'Live wallet request creation'],
    ] as const) {
      checks.push({ id, label, status: 'skipped', detail: 'Mock mode.', fix: 'Set VERIFIER_MODE=hybrid (or real) in .env to run this check.' });
    }
    return checks;
  }

  if (input.baseUrl) {
    checks.push({
      id: 'baseurl',
      label: 'Cloud SDK base URL',
      status: 'info',
      detail: input.baseUrl,
      fix: 'If setup returns 404, try the other base URL in .env.example.',
    });
  }

  // Never echo the key or profile value. Report only whether it looks right.
  const keyOk = /^CS[-_][A-Za-z0-9_-]{8,}$/.test(input.licenseKey);
  checks.push(
    !input.licenseKey
      ? { id: 'key', label: 'License key', status: 'fail', detail: 'No key is set.', fix: 'Set CLOUDSDK_LICENSE_KEY from the portal.' }
      : keyOk
        ? { id: 'key', label: 'License key', status: 'pass', detail: 'Present and in the expected CS- format.' }
        : { id: 'key', label: 'License key', status: 'warn', detail: 'Present, but not in the usual CS- format.', fix: 'Compare it with the key on the portal Cloud tab.' },
  );

  if (!input.profileId) {
    checks.push({ id: 'profile', label: 'Profile ID', status: 'fail', detail: 'No profile is set.', fix: 'Copy the Profile ID from the portal Cloud tab.' });
  } else if (UUID.test(input.profileId)) {
    checks.push({ id: 'profile', label: 'Profile ID', status: 'pass', detail: 'Present and a valid UUID.' });
  } else if (input.profileId.length > 36) {
    checks.push({ id: 'profile', label: 'Profile ID', status: 'fail', detail: 'Looks like several profiles pasted together.', fix: 'The portal copy button returns all profiles joined. Keep only one UUID.' });
  } else {
    checks.push({ id: 'profile', label: 'Profile ID', status: 'fail', detail: 'Not a valid UUID.', fix: 'Copy it again from the portal Cloud tab.' });
  }

  const o = checkOrigin(input.origin);
  checks.push({ id: 'origin', label: 'Registered origin', status: o.ok ? 'pass' : input.origin ? 'warn' : 'fail', detail: o.detail, fix: o.fix });

  const configFailed = checks.some((c) => c.status === 'fail');
  if (configFailed || !input.client) {
    for (const [id, label] of [
      ['setup', 'Live token setup call'],
      ['request', 'Live wallet request creation'],
    ] as const) {
      checks.push({ id, label, status: 'skipped', detail: 'Fix the configuration checks above first.' });
    }
    return checks;
  }

  try {
    await input.client.ensureToken();
    checks.push({ id: 'setup', label: 'Live token setup call', status: 'pass', detail: 'The license key and profile were accepted and a token was issued.' });
  } catch (e) {
    const x = explainSdkError(e);
    checks.push({ id: 'setup', label: 'Live token setup call', status: 'fail', ...x });
    checks.push({ id: 'request', label: 'Live wallet request creation', status: 'skipped', detail: 'The token setup failed.' });
    return checks;
  }

  try {
    const r = await input.client.getDocRequest();
    const dc = r?.dcRequest as { deviceRequest?: unknown } | null | undefined;
    const ok = typeof r?.sessionId === 'string' && r.sessionId.length > 0 && !!dc && !!dc.deviceRequest;
    checks.push(
      ok
        ? { id: 'request', label: 'Live wallet request creation', status: 'pass', detail: 'The service created a wallet request. No ID is needed for this step.' }
        : { id: 'request', label: 'Live wallet request creation', status: 'fail', detail: 'The response did not contain a session and a deviceRequest.', fix: 'Flow A needs dcRequest.deviceRequest. Check that your profile is supported, or contact Credence ID.' },
    );
  } catch (e) {
    checks.push({ id: 'request', label: 'Live wallet request creation', status: 'fail', ...explainSdkError(e) });
  }
  return checks;
}
