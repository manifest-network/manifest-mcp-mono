import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Live assertion of every MCP tool's `annotations` and `_meta.manifest`
 * payload through the stdio transport. Per CLAUDE.md these fields are the
 * public contract that the manifest-agent plugin consumes; the per-package
 * server.test.ts files pin them at the unit level, but this file pins
 * them end-to-end so a regression in MCP SDK serialization, the
 * `manifestMeta()` helper, or the tool-metadata builders would surface
 * here too.
 *
 * The expected matrix below mirrors the one in:
 *   packages/{chain,lease,fred,cosmwasm}/src/server.test.ts
 * Keep both in sync — a downstream-visible change requires a coordinated
 * plugin update and updates to *both* test files.
 */

interface ExpectedAnnotations {
  title: string; // exact title (not asserted today — title strings are owned
  // by the server; we only assert it's a non-empty string)
  readOnlyHint: boolean;
  destructiveHint?: boolean; // only asserted for mutating tools
  idempotentHint: boolean;
  openWorldHint: boolean;
  broadcasts: boolean;
  estimable: boolean;
}

const CHAIN_MATRIX: Record<string, ExpectedAnnotations> = {
  get_account_info: {
    title: 'Get account info',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
    broadcasts: false,
    estimable: false,
  },
  cosmos_query: {
    title: 'Cosmos query',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  cosmos_estimate_fee: {
    title: 'Estimate fee',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  list_modules: {
    title: 'List modules',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
    broadcasts: false,
    estimable: false,
  },
  list_module_subcommands: {
    title: 'List module subcommands',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
    broadcasts: false,
    estimable: false,
  },
  cosmos_tx: {
    title: 'Cosmos tx',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: true,
  },
  request_faucet: {
    title: 'Request faucet funds',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
};

const LEASE_MATRIX: Record<string, ExpectedAnnotations> = {
  credit_balance: {
    title: 'Credit balance',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  leases_by_tenant: {
    title: 'Leases by tenant',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  get_skus: {
    title: 'Get SKUs',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  get_providers: {
    title: 'Get providers',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  fund_credit: {
    title: 'Fund credit',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
  close_lease: {
    title: 'Close lease',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
};

const FRED_MATRIX: Record<string, ExpectedAnnotations> = {
  browse_catalog: {
    title: 'Browse catalog',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  app_status: {
    title: 'App status',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  get_logs: {
    title: 'Get logs',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  app_diagnostics: {
    title: 'App diagnostics',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  app_releases: {
    title: 'App releases',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  deploy_app: {
    title: 'Deploy app',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
  restart_app: {
    title: 'Restart app',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
  update_app: {
    title: 'Update app',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
};

const COSMWASM_MATRIX: Record<string, ExpectedAnnotations> = {
  get_mfx_to_pwr_rate: {
    title: 'Get MFX-to-PWR rate',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    broadcasts: false,
    estimable: false,
  },
  convert_mfx_to_pwr: {
    title: 'Convert MFX to PWR',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    broadcasts: true,
    estimable: false,
  },
};

interface ToolDescriptor {
  name: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: {
    manifest?: { v: number; broadcasts: boolean; estimable: boolean };
  };
}

/**
 * Common per-tool assertions. Title is asserted to be a non-empty string
 * (the exact strings are owned by each server and don't need duplication
 * here); flag-style annotations and the `_meta.manifest` block are pinned
 * to the values in the matrix.
 */
function assertToolMatrix(
  tool: ToolDescriptor,
  expected: ExpectedAnnotations,
): void {
  expect(typeof tool.annotations?.title, `${tool.name} annotations.title`).toBe(
    'string',
  );
  expect(
    (tool.annotations?.title ?? '').length,
    `${tool.name} annotations.title length`,
  ).toBeGreaterThan(0);

  expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
    expected.readOnlyHint,
  );
  if (expected.destructiveHint !== undefined) {
    expect(
      tool.annotations?.destructiveHint,
      `${tool.name} destructiveHint`,
    ).toBe(expected.destructiveHint);
  }
  expect(tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe(
    expected.idempotentHint,
  );
  expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(
    expected.openWorldHint,
  );

  expect(tool._meta?.manifest, `${tool.name} _meta.manifest`).toEqual({
    v: 1,
    broadcasts: expected.broadcasts,
    estimable: expected.estimable,
  });
}

describe('Tool annotations + _meta.manifest (live MCP transport)', () => {
  describe('chain (default — no faucet)', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
    });

    afterAll(async () => {
      await client.close();
    });

    it('exposes 6 tools (no request_faucet without MANIFEST_FAUCET_URL)', async () => {
      const tools = await client.listToolsRaw();
      const names = new Set(tools.map((t) => t.name));
      expect(names).not.toContain('request_faucet');
      expect(tools).toHaveLength(6);
    });

    it('every chain tool matches the annotation matrix', async () => {
      const tools = await client.listToolsRaw();
      for (const tool of tools) {
        const expected = CHAIN_MATRIX[tool.name];
        expect(expected, `unexpected tool ${tool.name}`).toBeDefined();
        assertToolMatrix(tool, expected);
      }
    });
  });

  describe('chain (with faucet — conditional registration)', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({
        serverEntry: 'packages/node/dist/chain.js',
        // Any URL works — we only verify registration, not invocation.
        faucetUrl: 'https://faucet.test.invalid',
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it('registers request_faucet when MANIFEST_FAUCET_URL is set', async () => {
      const tools = await client.listToolsRaw();
      const names = new Set(tools.map((t) => t.name));
      expect(names).toContain('request_faucet');
      expect(tools).toHaveLength(7);
    });

    it('request_faucet has correct annotations + _meta.manifest', async () => {
      const tools = await client.listToolsRaw();
      const faucet = tools.find((t) => t.name === 'request_faucet');
      expect(faucet).toBeDefined();
      assertToolMatrix(faucet!, CHAIN_MATRIX.request_faucet);
    });
  });

  describe('lease', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({ serverEntry: 'packages/node/dist/lease.js' });
    });

    afterAll(async () => {
      await client.close();
    });

    it('every lease tool matches the annotation matrix', async () => {
      const tools = await client.listToolsRaw();
      expect(tools).toHaveLength(6);
      for (const tool of tools) {
        const expected = LEASE_MATRIX[tool.name];
        expect(expected, `unexpected tool ${tool.name}`).toBeDefined();
        assertToolMatrix(tool, expected);
      }
    });
  });

  describe('fred', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({ serverEntry: 'packages/node/dist/fred.js' });
    });

    afterAll(async () => {
      await client.close();
    });

    it('every fred tool matches the annotation matrix', async () => {
      const tools = await client.listToolsRaw();
      expect(tools).toHaveLength(8);
      for (const tool of tools) {
        const expected = FRED_MATRIX[tool.name];
        expect(expected, `unexpected tool ${tool.name}`).toBeDefined();
        assertToolMatrix(tool, expected);
      }
    });
  });

  describe('cosmwasm', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({ serverEntry: 'packages/node/dist/cosmwasm.js' });
    });

    afterAll(async () => {
      await client.close();
    });

    it('every cosmwasm tool matches the annotation matrix', async () => {
      const tools = await client.listToolsRaw();
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        const expected = COSMWASM_MATRIX[tool.name];
        expect(expected, `unexpected tool ${tool.name}`).toBeDefined();
        assertToolMatrix(tool, expected);
      }
    });
  });
});
