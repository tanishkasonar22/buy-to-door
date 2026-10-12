// Plain-language labels for the reason codes and methods the server returns.
export const REASONS = {
  age_confirmed: 'Age confirmed',
  under_age: 'Under the age limit',
  wallet_cancelled: 'Wallet request cancelled',
  verification_failed: 'ID could not be verified',
  authentication_checks_failed: 'ID failed a security check',
  unreadable_response: 'Wallet response could not be read',
  age_claim_missing: 'No age result was returned',
  signature_invalid: 'Ticket code is not genuine',
  ticket_unknown: 'Ticket not found',
  ticket_unclaimed: 'Guest has not claimed this ticket yet',
  ticket_used: 'Ticket already used',
  ticket_revoked: 'Ticket was revoked',
  already_claimed: 'Ticket was already claimed',
  id_expired: 'ID is expired',
  id_not_authentic: 'ID does not look authentic',
  id_unreadable: 'ID could not be read',
  no_mobile_id: 'Guest has no mobile ID',
  wallet_unsupported: 'Wallet not supported',
  device_problem: 'Device problem',
  manager_approved: 'Manager approved',
};

export const METHODS = {
  mobile_id_simulated: 'Mobile ID (simulated)',
  physical_id_staff_recorded: 'Physical ID (staff-recorded)',
  override: 'Manager override',
};

export const label = (key) => REASONS[key] ?? String(key ?? 'unknown').replaceAll('_', ' ');
export const methodLabel = (key) => METHODS[key] ?? String(key).replaceAll('_', ' ');
