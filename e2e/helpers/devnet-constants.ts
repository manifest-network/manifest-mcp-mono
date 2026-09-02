/**
 * Genesis values mirrored from e2e/.env and e2e/scripts/init_chain.sh.
 * Keep chain-derived e2e fixtures pointed at this single synchronization
 * point when the local devnet genesis changes.
 */
export const POA_ADMIN_ADDRESS =
  'manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj';

/** PWR tokenfactory denom created and owned by the POA admin in genesis. */
export const PWR_DENOM = `factory/${POA_ADMIN_ADDRESS}/upwr`;
