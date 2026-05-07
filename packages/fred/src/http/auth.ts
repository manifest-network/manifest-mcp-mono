import { toBase64 } from '@cosmjs/encoding';

/**
 * Produces unix-second timestamps guaranteed unique across calls.
 *
 * ADR-036 signing is deterministic, so tokens sharing the same timestamp
 * produce identical signatures. The provider's replay tracker rejects
 * duplicate signatures on protected endpoints (connection, restart, update).
 * We wait for the wall clock to advance rather than drifting into the future
 * (the provider enforces a 30 s max token age and 10 s max-future-skew).
 * A promise queue serializes concurrent callers.
 */
export class AuthTimestampTracker {
  private last = 0;
  private queue: Promise<number> = Promise.resolve(0);

  next(): Promise<number> {
    const result = this.queue.then(async () => {
      let now = Math.floor(Date.now() / 1000);
      while (now <= this.last) {
        // Cap sleep at 1 s so forward clock jumps (e.g. NTP) are
        // picked up quickly instead of waiting the full precomputed delay.
        const sleepMs = Math.min((this.last - now + 1) * 1000, 1000);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        now = Math.floor(Date.now() / 1000);
      }
      this.last = now;
      return now;
    });
    this.queue = result.catch(() => this.last);
    return result;
  }
}

/**
 * Build the ADR-036 sign message for a generic provider/Fred call.
 *
 * NOTE (security): the message currently scopes a token to a tenant + lease +
 * timestamp, but not to a specific HTTP operation. If the provider's replay
 * tracker is per-endpoint rather than global, a token issued for a read
 * endpoint (e.g. status) could be replayed against a mutating endpoint
 * (e.g. restart, update) within the 30 s replay window. Tightening this
 * requires a coordinated server change to also validate an operation scope —
 * do not change this format unilaterally without updating the provider/Fred
 * verifier in lockstep, or every auth call will fail.
 */
export function createSignMessage(
  tenant: string,
  leaseUuid: string,
  timestamp: number,
): string {
  return `${tenant}:${leaseUuid}:${timestamp}`;
}

export function createLeaseDataSignMessage(
  leaseUuid: string,
  metaHashHex: string,
  timestamp: number,
): string {
  return `manifest lease data ${leaseUuid} ${metaHashHex} ${timestamp}`;
}

export interface AuthTokenPayload {
  readonly tenant: string;
  readonly lease_uuid: string;
  readonly timestamp: number;
  readonly pub_key: string;
  readonly signature: string;
  readonly meta_hash?: string;
}

export function createAuthToken(
  tenant: string,
  leaseUuid: string,
  timestamp: number,
  pubKey: string,
  signature: string,
  metaHashHex?: string,
): string {
  const payload: AuthTokenPayload = {
    tenant,
    lease_uuid: leaseUuid,
    timestamp,
    pub_key: pubKey,
    signature,
    ...(metaHashHex !== undefined && { meta_hash: metaHashHex }),
  };
  return toBase64(new TextEncoder().encode(JSON.stringify(payload)));
}
