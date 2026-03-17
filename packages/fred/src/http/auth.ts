import { toBase64 } from '@cosmjs/encoding';

export function createSignMessage(tenant: string, leaseUuid: string, timestamp: string): string {
  return `${tenant}:${leaseUuid}:${timestamp}`;
}

export function createLeaseDataSignMessage(
  leaseUuid: string,
  metaHashHex: string,
  timestamp: string,
): string {
  return `manifest lease data ${leaseUuid} ${metaHashHex} ${timestamp}`;
}

export interface AuthTokenPayload {
  readonly tenant: string;
  readonly lease_uuid: string;
  readonly timestamp: string;
  readonly pub_key: string;
  readonly signature: string;
  readonly meta_hash_hex?: string;
}

export function createAuthToken(
  tenant: string,
  leaseUuid: string,
  timestamp: string,
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
    ...(metaHashHex !== undefined && { meta_hash_hex: metaHashHex }),
  };
  return toBase64(new TextEncoder().encode(JSON.stringify(payload)));
}
