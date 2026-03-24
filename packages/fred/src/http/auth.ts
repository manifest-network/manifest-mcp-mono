import { toBase64 } from '@cosmjs/encoding';

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
