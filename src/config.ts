import 'dotenv/config';

/** "1" or "true" (any case) switches a flag on; anything else, or unset, is off. */
const flag = (v: string | undefined) => ['1', 'true'].includes((v ?? '').trim().toLowerCase());

export const config = {
  port: Number(process.env.PORT ?? 3000),
  verifierMode: (process.env.VERIFIER_MODE ?? 'mock') as 'mock' | 'hybrid' | 'real',
  cloudBaseUrl: process.env.CLOUDSDK_BASE_URL ?? 'https://credenceid.com/cloudsdk/playground',
  licenseKey: process.env.CLOUDSDK_LICENSE_KEY ?? '',
  profileId: process.env.CLOUDSDK_PROFILE_ID ?? '',
  origin: process.env.CLOUDSDK_ORIGIN ?? '',
  ticketSecret: process.env.TICKET_SIGNING_SECRET ?? '',
  // Unset or blank means age_over_21. The mock verifier and the firewall both read this one value.
  ageClaimKey: process.env.AGE_CLAIM_KEY?.trim() || 'age_over_21',
  inspect: process.env.DEV_INSPECT === '1',
  dbPath: process.env.DB_PATH ?? 'data/buy-to-door.db',
  claimTtlHours: Number(process.env.CLAIM_TTL_HOURS ?? 48),
  readinessToken: process.env.READINESS_TOKEN ?? '',
  // Real mode strips readerAuthAll from the wallet request by default (see src/stripReaderAuth.ts).
  // Set DC_KEEP_READER_AUTH=1 (or true) to send the request exactly as the Cloud SDK returned it.
  keepReaderAuth: flag(process.env.DC_KEEP_READER_AUTH),
  // DEMO WORKAROUND, real mode only: the mDL request is narrowed to age_over_21 by default
  // (see src/narrowRequest.ts). DC_KEEP_REQUESTED_ELEMENTS=1 sends the profile's full element list.
  keepRequestedElements: flag(process.env.DC_KEEP_REQUESTED_ELEMENTS),
  // DEMO ONLY, real mode only, default off: accept a credential whose issuer is not on Credence's
  // trust list when every other check passes. Makes the age check forgeable while it is on.
  demoAcceptUnlistedIssuer: flag(process.env.DEMO_ACCEPT_UNLISTED_ISSUER),
};
