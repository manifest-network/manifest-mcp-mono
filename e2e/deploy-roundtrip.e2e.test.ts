import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * End-to-end roundtrip for the M1 (ENG-84) primitives:
 *   - check_deployment_readiness  — composite pre-flight
 *   - build_manifest_preview      — manifest validation + meta_hash
 *   - deploy_app                  — chain TX + provider upload
 *   - wait_for_app_ready          — provider-side poll
 *   - close_lease                 — cleanup
 *
 * Runs against the same docker-compose devnet as lifecycle.e2e.test.ts.
 * The existing lifecycle test exercises deploy/update/restart/close end-to-
 * end; this file is narrower: it pins that the new pre-flight primitives
 * agree with what deploy_app and the chain actually accept, so the
 * manifest-agent plugin (M3) can rely on the contract without re-deriving
 * it.
 */

const IMAGE = 'nginxinc/nginx-unprivileged:alpine';
const PORT = 8080;

describe('Deploy roundtrip via M1 primitives', () => {
  const leaseClient = new MCPTestClient();
  const fredClient = new MCPTestClient();

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([leaseClient.close(), fredClient.close()]);
  });

  // ------------------------------------------------------------------
  // 1. Pre-flight: pure read-only primitives, no chain TXs yet.
  // ------------------------------------------------------------------

  it('build_manifest_preview accepts a valid single-service manifest', async () => {
    const result = await fredClient.callTool<{
      manifest_json: string;
      manifest: Record<string, unknown>;
      format: 'single' | 'stack';
      meta_hash_hex: string;
      validation: { valid: boolean; errors: string[] };
    }>('build_manifest_preview', { image: IMAGE, port: PORT });

    expect(result.format).toBe('single');
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errors).toEqual([]);
    expect(result.meta_hash_hex).toMatch(/^[0-9a-f]{64}$/);

    // The canonicalized manifest_json should round-trip cleanly.
    expect(JSON.parse(result.manifest_json)).toEqual({
      image: IMAGE,
      ports: { '8080/tcp': {} },
    });
  });

  it('build_manifest_preview rejects a manifest with a blocked env name', async () => {
    const result = await fredClient.callTool<{
      validation: { valid: boolean; errors: string[] };
    }>('build_manifest_preview', {
      image: IMAGE,
      port: PORT,
      env: { PATH: '/usr/local/bin' },
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => e.includes('PATH'))).toBe(true);
  });

  it('build_manifest_preview parses a raw stack manifest', async () => {
    const raw = JSON.stringify({
      services: { web: { image: IMAGE, ports: { '8080/tcp': {} } } },
    });
    const result = await fredClient.callTool<{
      format: 'single' | 'stack';
      validation: { valid: boolean; errors: string[] };
      meta_hash_hex: string;
    }>('build_manifest_preview', { manifest: raw });

    expect(result.format).toBe('stack');
    expect(result.validation.valid).toBe(true);
    expect(result.meta_hash_hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('check_deployment_readiness reports the missing SKU when the size is unknown', async () => {
    const result = await fredClient.callTool<{
      ready: boolean;
      missing_steps: string[];
      sku: { name: string } | null;
      available_sku_names: string[];
    }>('check_deployment_readiness', { size: 'docker-massive-imaginary' });

    expect(result.ready).toBe(false);
    expect(result.sku).toBeNull();
    expect(
      result.missing_steps.some((m) => m.includes('docker-massive-imaginary')),
    ).toBe(true);
    expect(result.available_sku_names).toContain('docker-micro');
  });

  // ------------------------------------------------------------------
  // 2. Make sure credits are funded (otherwise readiness reports false).
  // ------------------------------------------------------------------

  it('fund_credit funds the test wallet for the roundtrip', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    expect(micro).toBeDefined();
    const skuDenom = micro!.basePrice.denom;

    const result = await leaseClient.callTool<{
      code: number;
      transactionHash: string;
    }>('fund_credit', { amount: `5000000${skuDenom}` });

    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // 3. Readiness should now agree the deploy can proceed.
  // ------------------------------------------------------------------

  it('check_deployment_readiness reports ready: true once funded', async () => {
    const result = await fredClient.callTool<{
      ready: boolean;
      missing_steps: string[];
      sku: { name: string; provider_uuid: string } | null;
      tenant: string;
      image: string | null;
      size: string | null;
    }>('check_deployment_readiness', {
      size: 'docker-micro',
      image: IMAGE,
    });

    expect(result.ready).toBe(true);
    expect(result.missing_steps).toEqual([]);
    expect(result.sku?.name).toBe('docker-micro');
    expect(result.size).toBe('docker-micro');
    expect(result.image).toBe(IMAGE);
    expect(result.tenant).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // 4. Deploy and assert the lease reaches ACTIVE via wait_for_app_ready.
  //    Pinning the meta_hash from build_manifest_preview against the eventual
  //    on-chain lease's meta_hash would be ideal here, but the chain stores
  //    it on the lease record and this would require an extra cosmos_query;
  //    we instead rely on the structural guarantee (deploy_app and
  //    build_manifest_preview both call metaHashHex on the same canonical
  //    JSON via the shared helper extracted in ENG-84).
  // ------------------------------------------------------------------

  let leaseUuid: string;

  it('deploy_app creates a lease and reaches ACTIVE during its internal poll', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      provider_uuid: string;
      provider_url: string;
      state: LeaseState;
    }>('deploy_app', {
      image: IMAGE,
      port: PORT,
      size: 'docker-micro',
    });

    expect(result.lease_uuid).toBeTruthy();
    expect(result.provider_uuid).toBeTruthy();
    expect(result.provider_url).toBeTruthy();
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);

    leaseUuid = result.lease_uuid;
  });

  it('wait_for_app_ready returns immediately for an already-active lease', async () => {
    // deploy_app's internal poll already ran. wait_for_app_ready should see
    // the lease is ACTIVE on its first iteration and return the JSON-encoded
    // state name (not the numeric enum that deploy_app surfaces).
    const result = await fredClient.callTool<{
      lease_uuid: string;
      provider_uuid: string;
      provider_url: string;
      state: string;
      status: { state: number };
    }>('wait_for_app_ready', {
      lease_uuid: leaseUuid,
      // Tighten the timeout from the default 120s — we expect this to
      // return on the first iteration.
      timeout_seconds: 30,
      interval_seconds: 2,
    });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.state).toBe('LEASE_STATE_ACTIVE');
    expect(result.status.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  // ------------------------------------------------------------------
  // 5. Cleanup. close_lease is the only mutating step we run on this
  //    lease — kept after wait_for_app_ready so the assertion on
  //    LEASE_STATE_ACTIVE is unambiguous.
  // ------------------------------------------------------------------

  it('close_lease closes the lease', async () => {
    const result = await leaseClient.callTool<{
      lease_uuid: string;
      status: string;
    }>('close_lease', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.status).toBe('stopped');
  });
});
