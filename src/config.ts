import 'dotenv/config';

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
};
