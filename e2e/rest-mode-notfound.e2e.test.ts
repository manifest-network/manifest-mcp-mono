import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'; // cf. e2e/wallet.e2e.test.ts:12
import {
  createManifestReadClient,
  LeaseState,
} from '@manifest-network/manifest-mcp-core'; // cf. e2e/deploy-roundtrip.e2e.test.ts:1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHAIN_ID = 'manifest-localnet';
const REST_URL = 'http://localhost:1317'; // cf. e2e/rest-mode.e2e.test.ts:29

describe('not-found contract over LCD (ENG-536)', () => {
  const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
  let client: Awaited<ReturnType<typeof createManifestReadClient>>;
  let freshAddress: string;

  beforeAll(async () => {
    client = await createManifestReadClient({
      config: { chainId: CHAIN_ID, restUrl: REST_URL },
    });
    const wallet = await DirectSecp256k1HdWallet.generate(24, { prefix: 'manifest' });
    freshAddress = (await wallet.getAccounts())[0].address;
  });
  afterAll(() => client?.dispose());

  it('getLease returns null for a lease that does not exist', async () => {
    await expect(client.getLease(ABSENT_UUID)).resolves.toBeNull();
  });

  it('getLeaseByCustomDomain returns null for an unclaimed FQDN', async () => {
    await expect(client.getLeaseByCustomDomain('definitely-unclaimed-xyz.example.com')).resolves.toBeNull();
  });

  it('getBalance returns credits: null for an address with no credit account', async () => {
    const result = await client.getBalance(freshAddress);
    expect(result.credits).toBeNull();
  });

  // Collection reads 200-with-empty — they must NOT be swept into the fix.
  it('getLeasesByTenant returns an empty list, not a throw, for a tenant with no leases', async () => {
    const result = await client.getLeasesByTenant({
      tenant: freshAddress,
      stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
    });
    expect(result.leases).toEqual([]);
  });
});
