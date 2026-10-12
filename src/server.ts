import { config } from './config.js';
import { createApp } from './app.js';
import { CloudSdkClient } from './cloudsdk.js';
import { openDb } from './db.js';
import { CredenceVerifier, HybridVerifier, MockVerifier, type IdentityVerifier } from './identity.js';

function fail(message: string): never {
  console.error(`\nConfiguration problem: ${message}\n`);
  process.exit(1);
}

if (config.ticketSecret.length < 16) {
  fail('TICKET_SIGNING_SECRET must be set to a random string of at least 16 characters (see .env.example).');
}

let verifier: IdentityVerifier;
let client: CloudSdkClient | undefined;
if (config.verifierMode === 'real' || config.verifierMode === 'hybrid') {
  if (!config.licenseKey || !config.profileId) {
    fail(`VERIFIER_MODE=${config.verifierMode} needs CLOUDSDK_LICENSE_KEY and CLOUDSDK_PROFILE_ID.`);
  }
  if (!config.origin) {
    fail(`VERIFIER_MODE=${config.verifierMode} needs CLOUDSDK_ORIGIN, the HTTPS address registered with your license. The setup call is refused without it.`);
  }
  client = new CloudSdkClient({
    baseUrl: config.cloudBaseUrl,
    licenseKey: config.licenseKey,
    profileId: config.profileId,
    origin: config.origin,
    // Real mode: log which Origin header each Cloud SDK call carries (scheme + host only),
    // and send Origin on getDocRequest and verifyDocRequest too. Hybrid keeps the old behaviour.
    log: config.verifierMode === 'real' ? (line) => console.log(line) : undefined,
    originOnAllCalls: config.verifierMode === 'real',
  });
  verifier = config.verifierMode === 'hybrid' ? new HybridVerifier(client, config.ageClaimKey) : new CredenceVerifier(client);
} else {
  verifier = new MockVerifier(config.ageClaimKey);
}

const app = createApp({
  verifier,
  db: openDb(config.dbPath),
  mode: config.verifierMode,
  ticketSecret: config.ticketSecret,
  ageClaimKey: config.ageClaimKey,
  inspect: config.inspect,
  claimTtlHours: config.claimTtlHours,
  readinessToken: config.readinessToken,
  stripReaderAuth: !config.keepReaderAuth,
  narrowRequest: !config.keepRequestedElements,
  demoAcceptUnlistedIssuer: config.demoAcceptUnlistedIssuer,
  cloud: { licenseKey: config.licenseKey, profileId: config.profileId, origin: config.origin, baseUrl: config.cloudBaseUrl, client },
  log: (...a) => console.log(...a),
});

if (config.verifierMode === 'real' && config.demoAcceptUnlistedIssuer) {
  console.log('[firewall] WARNING demo override enabled: credentials from issuers not on the trust list are accepted when all other checks pass. Do not use outside a demo.');
}

app.listen(config.port, () => {
  console.log(`Buy to Door running at http://localhost:${config.port} (verifier: ${config.verifierMode})`);
});
