import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fromBase64 } from '@cosmjs/encoding';
import {
  createAuthToken,
  createSignMessage,
  createLeaseDataSignMessage,
} from '@manifest-network/manifest-mcp-fred';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Edge cases that don't fit any single ENG-* ticket:
 *
 *   1. cosmos_tx with wait_for_confirmation: false — proves the
 *      response shape difference (no `confirmed` / `confirmationHeight`
 *      fields) versus the default true path.
 *   2. deploy_app with the explicit `services` variant — every other
 *      test in the suite uses the high-level image/port/size form.
 *   3. ADR-036 client-side auth-token shape — pins the wire format
 *      consumed by providerd: `meta_hash` (not `meta_hash_hex`),
 *      numeric `timestamp`, all required fields present, base64-of-JSON
 *      envelope.
 *
 * Out of scope: an "expired token rejected by providerd" probe — would
 * require either stubbing Date.now in the spawned MCP server or
 * hand-crafting an HTTPS request to providerd from the test host
 * (cosmjs Secp256k1HdWallet for the signature, providerd's TLS cert
 * already extracted by global-setup.ts). Documented as a follow-up.
 */

describe('cosmos_tx async broadcast (wait_for_confirmation: false)', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
  });

  afterAll(async () => {
    await client.close();
  });

  it('returns code/transactionHash without confirmed/confirmationHeight', async () => {
    const { address } = await client.callTool<{ address: string }>(
      'get_account_info',
    );

    const result = await client.callTool<{
      transactionHash: string;
      code: number;
      gasUsed: string;
      gasWanted: string;
      events: unknown[];
      confirmed?: boolean;
      confirmationHeight?: string;
    }>('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
      wait_for_confirmation: false,
    });

    // signAndBroadcast in cosmjs always waits for inclusion, so code/
    // transactionHash/gasUsed are populated either way. The only
    // observable difference vs. the true path is the absence of the
    // two `confirmed*` fields.
    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
    expect(BigInt(result.gasUsed)).toBeGreaterThan(0n);
    expect(BigInt(result.gasWanted)).toBeGreaterThan(0n);
    expect(Array.isArray(result.events)).toBe(true);

    expect(result.confirmed).toBeUndefined();
    expect(result.confirmationHeight).toBeUndefined();
  });

  it('returns confirmed/confirmationHeight when wait_for_confirmation is true', async () => {
    const { address } = await client.callTool<{ address: string }>(
      'get_account_info',
    );

    const result = await client.callTool<{
      confirmed?: boolean;
      confirmationHeight?: string;
    }>('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
      wait_for_confirmation: true,
    });

    expect(result.confirmed).toBe(true);
    expect(result.confirmationHeight).toBeTruthy();
    expect(BigInt(result.confirmationHeight!)).toBeGreaterThan(0n);
  });
});

describe('deploy_app with services variant', () => {
  const leaseClient = new MCPTestClient();
  const fredClient = new MCPTestClient();

  let leaseUuid: string;

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);

    // Fund credits so this file is independent of test-ordering. Lifecycle
    // already does this for its lease, but credits are scoped per-account
    // and we don't want to assume the previous file's leftover balance
    // is sufficient.
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    const skuDenom = micro!.basePrice.denom;
    await leaseClient.callTool<{ code: number }>('fund_credit', {
      amount: `10000000${skuDenom}`,
    });
  });

  afterAll(async () => {
    // Tear down the lease so subsequent test runs don't accumulate
    // dangling active leases on the chain.
    if (leaseUuid) {
      try {
        await leaseClient.callTool('close_lease', { lease_uuid: leaseUuid });
      } catch {
        // best-effort cleanup
      }
    }
    await Promise.all([leaseClient.close(), fredClient.close()]);
  });

  it('deploys with the explicit services map (multi-port, env)', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      provider_uuid: string;
      provider_url: string;
      state: string;
    }>('deploy_app', {
      size: 'docker-micro',
      // Explicit services form — not the high-level image/port shorthand.
      // ports is a map keyed by `<port>/<proto>` per the schema.
      services: {
        web: {
          image: 'nginxinc/nginx-unprivileged:alpine',
          ports: { '8080/tcp': {} },
          env: { E2E_VARIANT: 'services' },
        },
      },
    });

    expect(result.lease_uuid).toBeTruthy();
    expect(result.provider_uuid).toBeTruthy();
    // The chain state at this point should be whatever the deploy helper
    // returns once the provider acknowledged the lease — same as the
    // image/port path. We accept any non-empty state string.
    expect(result.state).toBeTruthy();
    leaseUuid = result.lease_uuid;
  });
});

describe('ADR-036 auth-token wire shape', () => {
  // No MCP server / chain dependency — these tests pin the public token
  // format (consumed by providerd) entirely from the exported helpers.
  // CLAUDE.md states the token uses `meta_hash` (NOT `meta_hash_hex`)
  // and `timestamp` is a number (unix seconds), and the envelope is
  // base64-of-JSON. Each is asserted below.

  it('createSignMessage produces the documented `<tenant>:<lease>:<timestamp>` shape', () => {
    const tenant = 'manifest1xxx';
    const lease = '019dd044-608f-7000-85a3-c98ec9a7c6de';
    const timestamp = 1_700_000_000;
    const msg = createSignMessage(tenant, lease, timestamp);
    expect(msg).toBe(`${tenant}:${lease}:${timestamp}`);
  });

  it('createLeaseDataSignMessage produces the documented `manifest lease data ...` shape', () => {
    const lease = '019dd044-608f-7000-85a3-c98ec9a7c6de';
    const metaHash = 'abcd1234'.padEnd(64, '0');
    const timestamp = 1_700_000_000;
    const msg = createLeaseDataSignMessage(lease, metaHash, timestamp);
    expect(msg).toBe(`manifest lease data ${lease} ${metaHash} ${timestamp}`);
  });

  it('createAuthToken envelope is base64-of-JSON with the documented field names', () => {
    const tenant = 'manifest1xxx';
    const lease = '019dd044-608f-7000-85a3-c98ec9a7c6de';
    const timestamp = 1_700_000_000;
    const pubKey = 'A'.repeat(44); // base64-shaped placeholder
    const signature = 'B'.repeat(88);

    const token = createAuthToken(tenant, lease, timestamp, pubKey, signature);

    // Token is base64. Decode and inspect.
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token))) as Record<
      string,
      unknown
    >;

    // Required fields, in the names providerd consumes:
    expect(decoded.tenant).toBe(tenant);
    expect(decoded.lease_uuid).toBe(lease);
    expect(decoded.pub_key).toBe(pubKey);
    expect(decoded.signature).toBe(signature);

    // timestamp is a NUMBER (unix seconds), not a string.
    expect(typeof decoded.timestamp).toBe('number');
    expect(decoded.timestamp).toBe(timestamp);

    // No metaHashHex/meta_hash_hex — only `meta_hash` is allowed (and
    // omitted entirely when not provided).
    expect(decoded.meta_hash).toBeUndefined();
    expect(decoded.meta_hash_hex).toBeUndefined();
    expect(decoded.metaHashHex).toBeUndefined();
  });

  it('createAuthToken with metaHashHex emits `meta_hash` (not `meta_hash_hex`)', () => {
    const metaHash = 'abcd1234'.padEnd(64, '0');
    const token = createAuthToken(
      'manifest1xxx',
      '019dd044-608f-7000-85a3-c98ec9a7c6de',
      1_700_000_000,
      'pubkey',
      'signature',
      metaHash,
    );

    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token))) as Record<
      string,
      unknown
    >;

    // The wire field name is `meta_hash` per CLAUDE.md, regardless of
    // the parameter name on the helper signature (`metaHashHex`).
    expect(decoded.meta_hash).toBe(metaHash);
    expect(decoded.meta_hash_hex).toBeUndefined();
    expect(decoded.metaHashHex).toBeUndefined();
  });
});
