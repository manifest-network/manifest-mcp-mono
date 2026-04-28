import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * Comprehensive routing coverage for cosmos_query / cosmos_tx beyond the
 * smoke tests in chain-tools.e2e.test.ts. The goal is to exercise every
 * query and (cheap, non-admin) transaction subcommand of every module
 * that is actually used on POA Manifest, so that a regression in
 * cosmos.ts routing or any per-module handler surfaces in e2e.
 *
 * Out of scope here:
 *   - staking, gov: disabled on POA Manifest
 *   - manifest payout / burn-held-balance: POA-admin-only, would need a
 *     group proposal flow
 *   - poa admin txs: POA-admin-only
 *   - ibc-transfer transfer: needs a second chain
 *   - group lifecycle txs (submit-proposal/vote/exec/etc.): see
 *     e2e/group-lifecycle.e2e.test.ts
 *   - wasm txs via cosmos_tx (store-code/instantiate/execute/migrate/
 *     update-admin/clear-admin): see e2e/wasm-mutations.e2e.test.ts
 *   - billing/sku mutating txs via cosmos_tx (create-provider, create-sku,
 *     create-lease, acknowledge-lease, etc.): see
 *     e2e/billing-sku-lifecycle.e2e.test.ts
 *
 * Devnet addresses come from e2e/.env. The constants below mirror those
 * so we don't shell out to read .env during the test.
 */

// Provider key (ADDR1 in e2e/.env) — registered as the SKU provider during
// init_billing.sh. Used as a recipient for multi-send and as the creator
// argument for sku/wasm queries that need a known account.
const PROVIDER_ADDRESS = 'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct';

// POA admin group-policy address. Has no signing key — we only use it as a
// query target (e.g., as the admin in tokenfactory denoms-from-admin).
const POA_ADMIN_ADDRESS =
  'manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj';

// PWR denom (tokenfactory, owned by POA admin). Created in genesis.
const PWR_DENOM = `factory/${POA_ADMIN_ADDRESS}/upwr`;

describe('Chain routing coverage', () => {
  const client = new MCPTestClient();

  let testAddress: string;
  let providerUuid: string | undefined;
  let skuUuid: string | undefined;
  let converterAddress: string | undefined;

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });

    const acct = await client.callTool<{ address: string }>('get_account_info');
    testAddress = acct.address;

    // Discover provider/sku UUIDs created by init_billing.sh — used by sku
    // and billing query tests below. Best-effort: tests that need them
    // skip the assertion if undefined.
    //
    // Filter by ADDR1 explicitly: billing-sku-lifecycle (alphabetically
    // earlier) self-registers the test wallet as a *second* provider. A
    // bare providers[0] would be order-dependent and may surface either
    // ADDR1 or testAddress — downstream `skus-by-provider` etc. would
    // pass against the wrong provider's SKUs.
    try {
      const providers = await client.callTool<{
        result: { providers: Array<{ uuid: string; address: string }> };
      }>('cosmos_query', {
        module: 'sku',
        subcommand: 'provider-by-address',
        args: [PROVIDER_ADDRESS],
      });
      providerUuid = providers.result.providers[0]?.uuid;
    } catch {
      // ignore
    }

    try {
      const skus = await client.callTool<{
        result: { skus: Array<{ uuid: string; name: string }> };
      }>('cosmos_query', { module: 'sku', subcommand: 'skus' });
      skuUuid = skus.result.skus.find((s) => s.name === 'docker-micro')?.uuid;
    } catch {
      // ignore
    }

    converterAddress = process.env.MANIFEST_CONVERTER_ADDRESS;
  });

  afterAll(async () => {
    await client.close();
  });

  // ==========================================================================
  // bank — queries
  // ==========================================================================
  describe('bank queries', () => {
    it('balance', async () => {
      const result = await client.callTool<{
        result: { balance: { denom: string; amount: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balance',
        args: [testAddress, 'umfx'],
      });
      expect(result.result.balance.denom).toBe('umfx');
      expect(BigInt(result.result.balance.amount)).toBeGreaterThan(0n);
    });

    it('spendable-balances', async () => {
      const result = await client.callTool<{
        result: { balances: Array<{ denom: string; amount: string }> };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'spendable-balances',
        args: [testAddress],
      });
      expect(Array.isArray(result.result.balances)).toBe(true);
      expect(result.result.balances.find((b) => b.denom === 'umfx')).toBeDefined();
    });

    it('total-supply', async () => {
      const result = await client.callTool<{
        result: { supply: Array<{ denom: string; amount: string }> };
      }>('cosmos_query', { module: 'bank', subcommand: 'total-supply' });
      expect(Array.isArray(result.result.supply)).toBe(true);
      expect(result.result.supply.find((c) => c.denom === 'umfx')).toBeDefined();
    });

    it('total (alias of total-supply)', async () => {
      const result = await client.callTool<{
        result: { supply: Array<{ denom: string }> };
      }>('cosmos_query', { module: 'bank', subcommand: 'total' });
      expect(Array.isArray(result.result.supply)).toBe(true);
    });

    it('supply-of', async () => {
      const result = await client.callTool<{
        result: { amount: { denom: string; amount: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'supply-of',
        args: ['umfx'],
      });
      expect(result.result.amount.denom).toBe('umfx');
      expect(BigInt(result.result.amount.amount)).toBeGreaterThan(0n);
    });

    it('params', async () => {
      const result = await client.callTool<{
        result: { params: { defaultSendEnabled?: boolean } };
      }>('cosmos_query', { module: 'bank', subcommand: 'params' });
      expect(result.result.params).toBeDefined();
    });

    it('denom-metadata', async () => {
      const result = await client.callTool<{
        result: { metadata: { base: string; symbol: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'denom-metadata',
        args: ['umfx'],
      });
      expect(result.result.metadata.base).toBe('umfx');
      expect(result.result.metadata.symbol).toBe('MFX');
    });

    it('denoms-metadata', async () => {
      const result = await client.callTool<{
        result: { metadatas: Array<{ base: string }> };
      }>('cosmos_query', { module: 'bank', subcommand: 'denoms-metadata' });
      expect(Array.isArray(result.result.metadatas)).toBe(true);
      expect(result.result.metadatas.find((m) => m.base === 'umfx')).toBeDefined();
    });

    it('send-enabled', async () => {
      const result = await client.callTool<{
        result: { sendEnabled: unknown[] };
      }>('cosmos_query', { module: 'bank', subcommand: 'send-enabled' });
      expect(Array.isArray(result.result.sendEnabled)).toBe(true);
    });
  });

  // ==========================================================================
  // bank — transactions
  // ==========================================================================
  describe('bank transactions', () => {
    it('multi-send distributes to two recipients in one tx', async () => {
      const queryBalance = async (
        address: string,
        denom: string,
      ): Promise<bigint> => {
        const res = await client.callTool<{
          result: { balance: { amount: string } };
        }>('cosmos_query', {
          module: 'bank',
          subcommand: 'balance',
          args: [address, denom],
        });
        return BigInt(res.result.balance.amount);
      };

      const beforeProvider = await queryBalance(PROVIDER_ADDRESS, 'umfx');
      const beforeSelf = await queryBalance(testAddress, 'umfx');

      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'bank',
        subcommand: 'multi-send',
        args: [`${PROVIDER_ADDRESS}:1000umfx`, `${testAddress}:500umfx`],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);

      const afterProvider = await queryBalance(PROVIDER_ADDRESS, 'umfx');
      const afterSelf = await queryBalance(testAddress, 'umfx');

      // Provider received exactly 1000.
      expect(afterProvider - beforeProvider).toBe(1000n);
      // Self received 500 but also paid the full 1500 input + gas; assert
      // the net change is at least -1000 (sent 1500, got 500 back, minus fees).
      expect(beforeSelf - afterSelf).toBeGreaterThanOrEqual(1000n);
    });
  });

  // ==========================================================================
  // auth — queries (no tx handlers in registry)
  // ==========================================================================
  describe('auth queries', () => {
    it('accounts (paginated list)', async () => {
      const result = await client.callTool<{
        result: { accounts: unknown[] };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'accounts',
        args: ['--limit', '5'],
      });
      expect(Array.isArray(result.result.accounts)).toBe(true);
      expect(result.result.accounts.length).toBeGreaterThan(0);
    });

    it('params', async () => {
      const result = await client.callTool<{
        result: { params: unknown };
      }>('cosmos_query', { module: 'auth', subcommand: 'params' });
      expect(result.result.params).toBeDefined();
    });

    it('module-accounts', async () => {
      const result = await client.callTool<{
        result: { accounts: unknown[] };
      }>('cosmos_query', { module: 'auth', subcommand: 'module-accounts' });
      expect(Array.isArray(result.result.accounts)).toBe(true);
      expect(result.result.accounts.length).toBeGreaterThan(0);
    });

    it('module-account-by-name (fee_collector)', async () => {
      const result = await client.callTool<{
        result: { account: unknown };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'module-account-by-name',
        args: ['fee_collector'],
      });
      expect(result.result.account).toBeDefined();
    });

    it('address-string-to-bytes round-trips through address-bytes-to-string', async () => {
      const toBytes = await client.callTool<{
        result: { addressBytes: string };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'address-string-to-bytes',
        args: [testAddress],
      });
      expect(toBytes.result.addressBytes).toMatch(/^[0-9a-fA-F]+$/);

      const toString = await client.callTool<{
        result: { addressString: string };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'address-bytes-to-string',
        args: [toBytes.result.addressBytes],
      });
      expect(toString.result.addressString).toBe(testAddress);
    });

    it('bech32-prefix', async () => {
      const result = await client.callTool<{
        result: { bech32Prefix: string };
      }>('cosmos_query', { module: 'auth', subcommand: 'bech32-prefix' });
      expect(result.result.bech32Prefix).toBe('manifest');
    });

    it('account-info', async () => {
      const result = await client.callTool<{
        result: { info: { address: string } };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'account-info',
        args: [testAddress],
      });
      expect(result.result.info.address).toBe(testAddress);
    });
  });

  // ==========================================================================
  // poa — queries (admin txs are out of scope)
  // ==========================================================================
  describe('poa queries', () => {
    it('consensus-power for the genesis validator', async () => {
      // The chain has exactly one validator created from the provider key
      // via `genesis gentx`. We discover its valoper via staking validators.
      // If staking is fully disabled and returns empty, skip the assertion
      // — `authority` and `pending-validators` (covered in chain-tools)
      // already exercise the poa routing layer.
      let valoper: string | undefined;
      try {
        const validators = await client.callTool<{
          result: { validators: Array<{ operatorAddress: string }> };
        }>('cosmos_query', {
          module: 'staking',
          subcommand: 'validators',
        });
        valoper = validators.result.validators[0]?.operatorAddress;
      } catch {
        // staking module disabled — fall through
      }

      if (!valoper) {
        console.warn(
          '[chain-routing] No valoper available for poa consensus-power; skipping assertion.',
        );
        return;
      }

      const result = await client.callTool<{
        result: { consensusPower: string | number };
      }>('cosmos_query', {
        module: 'poa',
        subcommand: 'consensus-power',
        args: [valoper],
      });
      expect(result.result.consensusPower).toBeDefined();
    });
  });

  // ==========================================================================
  // tokenfactory — queries + transactions
  //
  // Creates a single fresh denom at the top of the section so subsequent
  // burn/change-admin/set-denom-metadata tests can act on it. After
  // change-admin runs, the test wallet is no longer the admin, so order
  // matters: queries → mint → burn → set-denom-metadata → change-admin.
  // ==========================================================================
  describe('tokenfactory', () => {
    const subdenom = `routing${Date.now()}`;
    let denom: string;
    let mintAmount: bigint;

    it('create-denom (setup)', async () => {
      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'tokenfactory',
        subcommand: 'create-denom',
        args: [subdenom],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);
      denom = `factory/${testAddress}/${subdenom}`;
    });

    it('mint (setup)', async () => {
      mintAmount = 1_000_000n;
      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'tokenfactory',
        subcommand: 'mint',
        args: [`${mintAmount}${denom}`, testAddress],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);
    });

    it('query: params', async () => {
      const result = await client.callTool<{
        result: { params: unknown };
      }>('cosmos_query', { module: 'tokenfactory', subcommand: 'params' });
      expect(result.result.params).toBeDefined();
    });

    it('query: denom-authority-metadata', async () => {
      const result = await client.callTool<{
        result: { authorityMetadata: { admin: string } };
      }>('cosmos_query', {
        module: 'tokenfactory',
        subcommand: 'denom-authority-metadata',
        args: [denom],
      });
      expect(result.result.authorityMetadata.admin).toBe(testAddress);
    });

    it('query: denoms-from-admin', async () => {
      const result = await client.callTool<{
        result: { denoms: string[] };
      }>('cosmos_query', {
        module: 'tokenfactory',
        subcommand: 'denoms-from-admin',
        args: [testAddress],
      });
      expect(result.result.denoms).toContain(denom);
    });

    it('tx: burn (subset of minted balance)', async () => {
      const burnAmount = 100_000n;
      const beforeRes = await client.callTool<{
        result: { balance: { amount: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balance',
        args: [testAddress, denom],
      });
      const before = BigInt(beforeRes.result.balance.amount);

      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'tokenfactory',
        subcommand: 'burn',
        args: [`${burnAmount}${denom}`, testAddress],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);

      const afterRes = await client.callTool<{
        result: { balance: { amount: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balance',
        args: [testAddress, denom],
      });
      const after = BigInt(afterRes.result.balance.amount);
      expect(before - after).toBe(burnAmount);
    });

    it('tx: set-denom-metadata', async () => {
      const metadata = JSON.stringify({
        base: denom,
        display: subdenom,
        denomUnits: [
          { denom, exponent: 0, aliases: [] },
          { denom: subdenom, exponent: 6, aliases: [] },
        ],
        name: 'Routing Test Token',
        symbol: 'RTT',
        description: 'Token created by chain-routing.e2e.test.ts',
      });

      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'tokenfactory',
        subcommand: 'set-denom-metadata',
        args: [metadata],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);

      const meta = await client.callTool<{
        result: { metadata: { symbol: string } };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'denom-metadata',
        args: [denom],
      });
      expect(meta.result.metadata.symbol).toBe('RTT');
    });

    it('tx: change-admin transfers admin to PROVIDER_ADDRESS', async () => {
      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'tokenfactory',
        subcommand: 'change-admin',
        args: [denom, PROVIDER_ADDRESS],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);

      const meta = await client.callTool<{
        result: { authorityMetadata: { admin: string } };
      }>('cosmos_query', {
        module: 'tokenfactory',
        subcommand: 'denom-authority-metadata',
        args: [denom],
      });
      expect(meta.result.authorityMetadata.admin).toBe(PROVIDER_ADDRESS);
    });
  });

  // ==========================================================================
  // billing — queries
  //
  // Lifecycle test funds credits later; we need an existing credit account
  // for credit-account / credit-estimate to return data, so seed a tiny
  // credit here. SKU pricing denom is the PWR denom (factory/POA/upwr) and
  // the test wallet has 1e12 upwr from genesis (init_chain.sh:92).
  // ==========================================================================
  describe('billing queries', () => {
    beforeAll(async () => {
      const fundResult = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'billing',
        subcommand: 'fund-credit',
        args: [testAddress, `1000000${PWR_DENOM}`],
        wait_for_confirmation: true,
      });
      expect(fundResult.code).toBe(0);
    });

    it('params', async () => {
      const result = await client.callTool<{
        result: { params: unknown };
      }>('cosmos_query', { module: 'billing', subcommand: 'params' });
      expect(result.result.params).toBeDefined();
    });

    it('leases', async () => {
      const result = await client.callTool<{
        result: { leases: unknown[] };
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'leases',
      });
      expect(Array.isArray(result.result.leases)).toBe(true);
    });

    it('leases-by-tenant', async () => {
      const result = await client.callTool<{
        result: { leases: unknown[] };
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'leases-by-tenant',
        args: [testAddress],
      });
      expect(Array.isArray(result.result.leases)).toBe(true);
    });

    it('leases-by-provider', async () => {
      if (!providerUuid) {
        console.warn('[chain-routing] No providerUuid — skipping leases-by-provider');
        return;
      }
      const result = await client.callTool<{
        result: { leases: unknown[] };
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'leases-by-provider',
        args: [providerUuid],
      });
      expect(Array.isArray(result.result.leases)).toBe(true);
    });

    it('leases-by-sku', async () => {
      if (!skuUuid) {
        console.warn('[chain-routing] No skuUuid — skipping leases-by-sku');
        return;
      }
      const result = await client.callTool<{
        result: { leases: unknown[] };
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'leases-by-sku',
        args: [skuUuid],
      });
      expect(Array.isArray(result.result.leases)).toBe(true);
    });

    it('credit-accounts', async () => {
      const result = await client.callTool<{
        result: { creditAccounts: unknown[] };
      }>('cosmos_query', { module: 'billing', subcommand: 'credit-accounts' });
      expect(result.result.creditAccounts).toBeDefined();
    });

    it('credit-account', async () => {
      const result = await client.callTool<{
        result: unknown;
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'credit-account',
        args: [testAddress],
      });
      // Returns whatever shape the credit account has — we only assert routing
      // succeeded and produced a `result` key.
      expect(result.result).toBeDefined();
    });

    it('credit-address', async () => {
      const result = await client.callTool<{
        result: { creditAddress: string };
      }>('cosmos_query', {
        module: 'billing',
        subcommand: 'credit-address',
        args: [testAddress],
      });
      expect(result.result.creditAddress).toBeDefined();
    });

    it('credit-estimate', async () => {
      const result = await client.callTool<{ result: unknown }>('cosmos_query', {
        module: 'billing',
        subcommand: 'credit-estimate',
        args: [testAddress],
      });
      expect(result.result).toBeDefined();
    });

    it('provider-withdrawable', async () => {
      if (!providerUuid) {
        console.warn('[chain-routing] No providerUuid — skipping provider-withdrawable');
        return;
      }
      const result = await client.callTool<{ result: unknown }>('cosmos_query', {
        module: 'billing',
        subcommand: 'provider-withdrawable',
        args: [providerUuid],
      });
      expect(result.result).toBeDefined();
    });
  });

  // ==========================================================================
  // sku — queries (txs already exercised by lifecycle init)
  // ==========================================================================
  describe('sku queries', () => {
    it('params', async () => {
      const result = await client.callTool<{ result: { params: unknown } }>(
        'cosmos_query',
        { module: 'sku', subcommand: 'params' },
      );
      expect(result.result.params).toBeDefined();
    });

    it('providers', async () => {
      const result = await client.callTool<{
        result: { providers: Array<{ uuid: string }> };
      }>('cosmos_query', { module: 'sku', subcommand: 'providers' });
      expect(result.result.providers.length).toBeGreaterThan(0);
    });

    it('provider', async () => {
      if (!providerUuid) {
        console.warn('[chain-routing] No providerUuid — skipping provider');
        return;
      }
      const result = await client.callTool<{
        result: { provider: { uuid: string } };
      }>('cosmos_query', {
        module: 'sku',
        subcommand: 'provider',
        args: [providerUuid],
      });
      expect(result.result.provider.uuid).toBe(providerUuid);
    });

    it('skus', async () => {
      const result = await client.callTool<{
        result: { skus: Array<{ uuid: string; name: string }> };
      }>('cosmos_query', { module: 'sku', subcommand: 'skus' });
      expect(result.result.skus.length).toBeGreaterThan(0);
    });

    it('sku', async () => {
      if (!skuUuid) {
        console.warn('[chain-routing] No skuUuid — skipping sku');
        return;
      }
      const result = await client.callTool<{
        result: { sku: { uuid: string } };
      }>('cosmos_query', {
        module: 'sku',
        subcommand: 'sku',
        args: [skuUuid],
      });
      expect(result.result.sku.uuid).toBe(skuUuid);
    });

    it('skus-by-provider', async () => {
      if (!providerUuid) {
        console.warn('[chain-routing] No providerUuid — skipping skus-by-provider');
        return;
      }
      const result = await client.callTool<{
        result: { skus: Array<{ uuid: string }> };
      }>('cosmos_query', {
        module: 'sku',
        subcommand: 'skus-by-provider',
        args: [providerUuid],
      });
      expect(result.result.skus.length).toBeGreaterThan(0);
    });

    it('provider-by-address', async () => {
      const result = await client.callTool<{
        result: { providers: Array<{ uuid: string }> };
      }>('cosmos_query', {
        module: 'sku',
        subcommand: 'provider-by-address',
        args: [PROVIDER_ADDRESS],
      });
      expect(result.result.providers.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // wasm — queries (txs covered in e2e/wasm-mutations.e2e.test.ts)
  //
  // Uses the converter deployed by init_billing.sh, with the actual
  // code_id derived at runtime (init_billing.sh writes it to
  // /shared/converter.env, global-setup.ts copies it out into
  // process.env.MANIFEST_CONVERTER_CODE_ID). Hardcoding `'1'` would be
  // fragile against any earlier wasm upload in the run.
  // ==========================================================================
  describe('wasm queries', () => {
    let codeId: string;

    beforeAll(() => {
      const fromEnv = process.env.MANIFEST_CONVERTER_CODE_ID;
      if (!fromEnv) {
        throw new Error(
          'MANIFEST_CONVERTER_CODE_ID not set — global-setup.ts could not extract it from /shared/converter.env',
        );
      }
      codeId = fromEnv;
    });

    it('params', async () => {
      const result = await client.callTool<{ result: { params: unknown } }>(
        'cosmos_query',
        { module: 'wasm', subcommand: 'params' },
      );
      expect(result.result.params).toBeDefined();
    });

    it('codes (list)', async () => {
      const result = await client.callTool<{
        result: { codeInfos: Array<{ codeId: string }> };
      }>('cosmos_query', { module: 'wasm', subcommand: 'codes' });
      expect(result.result.codeInfos.length).toBeGreaterThan(0);
    });

    it('code', async () => {
      const result = await client.callTool<{
        result: { codeInfo: { codeId: string }; data: string };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'code',
        args: [codeId],
      });
      expect(result.result.codeInfo).toBeDefined();
      expect(result.result.data.length).toBeGreaterThan(0);
    });

    it('code-info', async () => {
      const result = await client.callTool<{
        result: { codeInfo: { codeId: string; creator: string } };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'code-info',
        args: [codeId],
      });
      expect(result.result.codeInfo.codeId.toString()).toBe(codeId);
      expect(result.result.codeInfo.creator).toBe(PROVIDER_ADDRESS);
    });

    it('contracts-by-code', async () => {
      const result = await client.callTool<{
        result: { contracts: string[] };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'contracts-by-code',
        args: [codeId],
      });
      expect(result.result.contracts.length).toBeGreaterThan(0);
    });

    it('contract-info', async () => {
      if (!converterAddress) {
        throw new Error('MANIFEST_CONVERTER_ADDRESS not set');
      }
      const result = await client.callTool<{
        result: { contractInfo: { codeId: string } };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'contract-info',
        args: [converterAddress],
      });
      expect(result.result.contractInfo.codeId.toString()).toBe(codeId);
    });

    it('contract-history', async () => {
      if (!converterAddress) {
        throw new Error('MANIFEST_CONVERTER_ADDRESS not set');
      }
      const result = await client.callTool<{
        result: { entries: unknown[] };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'contract-history',
        args: [converterAddress],
      });
      expect(result.result.entries.length).toBeGreaterThan(0);
    });

    it('all-contract-state', async () => {
      if (!converterAddress) {
        throw new Error('MANIFEST_CONVERTER_ADDRESS not set');
      }
      const result = await client.callTool<{
        result: { models: unknown[] };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'all-contract-state',
        args: [converterAddress],
      });
      expect(Array.isArray(result.result.models)).toBe(true);
    });

    it('smart-contract-state ({"config":{}})', async () => {
      if (!converterAddress) {
        throw new Error('MANIFEST_CONVERTER_ADDRESS not set');
      }
      const result = await client.callTool<{
        result: { data: { rate: string; source_denom: string } };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'smart-contract-state',
        args: [converterAddress, '{"config":{}}'],
      });
      expect(result.result.data.rate).toBe('0.379');
      expect(result.result.data.source_denom).toBe('umfx');
    });

    it('raw-contract-state with a likely-empty key', async () => {
      if (!converterAddress) {
        throw new Error('MANIFEST_CONVERTER_ADDRESS not set');
      }
      // We don't know the contract's storage layout, so query a key that
      // certainly does not exist. Routing succeeds even if data is empty.
      const result = await client.callTool<{ result: { data: string } }>(
        'cosmos_query',
        {
          module: 'wasm',
          subcommand: 'raw-contract-state',
          args: [converterAddress, '00'],
        },
      );
      expect(typeof result.result.data).toBe('string');
    });

    it('contracts-by-creator', async () => {
      const result = await client.callTool<{
        result: { contractAddresses: string[] };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'contracts-by-creator',
        args: [PROVIDER_ADDRESS],
      });
      expect(Array.isArray(result.result.contractAddresses)).toBe(true);
    });

    it('pinned-codes', async () => {
      const result = await client.callTool<{
        result: { codeIds: string[] };
      }>('cosmos_query', { module: 'wasm', subcommand: 'pinned-codes' });
      expect(Array.isArray(result.result.codeIds)).toBe(true);
    });

    it('wasm-limits-config', async () => {
      const result = await client.callTool<{
        result: { config: unknown };
      }>('cosmos_query', { module: 'wasm', subcommand: 'wasm-limits-config' });
      expect(result.result.config).toBeDefined();
    });

    it('build-address', async () => {
      // The deployed converter was created via Instantiate (not Instantiate2),
      // so its address won't match this build-address result. We only assert
      // the routing returns a manifest-prefixed address shape.
      //
      // wasm.code-info returns dataHash as base64 (toBase64 in queries/wasm.ts);
      // build-address expects the code-hash as hex, so we convert.
      const codeInfo = await client.callTool<{
        result: { codeInfo: { dataHash: string } };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'code-info',
        args: [codeId],
      });
      const codeHashHex = Buffer.from(
        codeInfo.result.codeInfo.dataHash,
        'base64',
      ).toString('hex');

      const result = await client.callTool<{
        result: { address: string };
      }>('cosmos_query', {
        module: 'wasm',
        subcommand: 'build-address',
        // salt must be hex per cosmwasm; "00" is fine here.
        args: [codeHashHex, PROVIDER_ADDRESS, '00'],
      });
      expect(result.result.address).toMatch(/^manifest1[a-z0-9]+$/);
    });
  });

  // ==========================================================================
  // distribution — probe for what works on POA Manifest
  //
  // The user noted "some distribution functions are also disabled". Each
  // probe wraps the query/tx in a try and reports skip-on-failure rather
  // than failing the suite.
  // ==========================================================================
  describe('distribution probes', () => {
    // Each probe accepts success OR a chain-side rejection (QUERY_FAILED /
    // TX_FAILED with a chain-emitted message). UNSUPPORTED_QUERY / *_TX,
    // UNKNOWN_MODULE, or transport-shaped failures are real regressions
    // and re-throw — they would mean the routing layer broke, not that
    // the module is disabled.
    const expectChainSide = (err: unknown, expectedCodes: string[]): void => {
      const code = parseToolErrorCode(err);
      if (!code || !expectedCodes.includes(code)) {
        throw err;
      }
    };

    it('query: params (probe)', async () => {
      try {
        const result = await client.callTool<{
          result: { params: unknown };
        }>('cosmos_query', { module: 'distribution', subcommand: 'params' });
        expect(result.result.params).toBeDefined();
      } catch (err) {
        expectChainSide(err, ['QUERY_FAILED']);
        console.warn(
          `[chain-routing] distribution params probe rejected by chain: ${err}`,
        );
      }
    });

    it('query: community-pool (probe)', async () => {
      try {
        const result = await client.callTool<{
          result: { pool: unknown };
        }>('cosmos_query', {
          module: 'distribution',
          subcommand: 'community-pool',
        });
        expect(result.result.pool).toBeDefined();
      } catch (err) {
        expectChainSide(err, ['QUERY_FAILED']);
        console.warn(
          `[chain-routing] distribution community-pool probe rejected by chain: ${err}`,
        );
      }
    });

    it('tx: fund-community-pool (probe)', async () => {
      try {
        const result = await client.callTool<{ code: number }>('cosmos_tx', {
          module: 'distribution',
          subcommand: 'fund-community-pool',
          args: ['100umfx'],
          wait_for_confirmation: true,
        });
        expect(result.code).toBe(0);
      } catch (err) {
        expectChainSide(err, ['TX_FAILED']);
        console.warn(
          `[chain-routing] distribution fund-community-pool probe rejected by chain: ${err}`,
        );
      }
    });
  });

  // Reference PWR_DENOM somewhere so it's not flagged as unused. (Future
  // tests may want to use it as a non-tenant-owned tokenfactory denom for
  // negative authority assertions.)
  describe('module references', () => {
    it('PWR_DENOM is the genesis tokenfactory denom owned by POA admin', () => {
      expect(PWR_DENOM).toMatch(
        new RegExp(`^factory/${POA_ADMIN_ADDRESS}/upwr$`),
      );
    });
  });
});
