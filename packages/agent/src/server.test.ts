// DRAFT — depends on engineer's task #8 (`src/index.ts` w/ AgentMCPServer +
// 4 registerTool calls + DI seam). Test #8 below (`tool annotations +
// _meta.manifest`) is fully implemented and pins the public contract from
// PLAN.md §6.2 — the engineer's tool-registration code MUST match this
// matrix. The other nine tests are `it.todo(...)` placeholders that the
// QA engineer fills in once #8 lands. Until #8 lands the import below
// fails to resolve; that is the expected handoff signal.
//
// Mock strategy (per PLAN.md §6.1):
//   - `vi.mock('@manifest-network/manifest-mcp-core', ...)` for
//     `CosmosClientManager.getInstance` (unavoidable; this is the chain
//     construction path, NOT the agent-core orchestration seam).
//   - **No** `vi.mock('@manifest-network/manifest-agent-core', ...)`. The
//     four orchestrator functions are injected via the constructor seam
//     `options.orchestrators?: Partial<AgentOrchestrators>` (PLAN.md
//     §1.1). The `listTools`-only assertions in test #8 don't need any
//     orchestrator overrides — `listTools` walks the registered metadata
//     and never invokes a handler.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue({
        disconnect: vi.fn(),
        getQueryClient: vi.fn().mockResolvedValue({}),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({ chainId: 'test-chain' }),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
// NOTE: `AgentMCPServer` import resolves once engineer's #8 lands.
import { AgentMCPServer } from './index.js';

const AGENT_TOOL_NAMES = [
  'deploy_app_orchestrated',
  'manage_domain_orchestrated',
  'troubleshoot_deployment_orchestrated',
  'close_lease_orchestrated',
];

let activeTransports: InMemoryTransport[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  activeTransports = [];
});

afterEach(async () => {
  for (const t of activeTransports) {
    await t.close();
  }
  activeTransports = [];
});

describe('AgentMCPServer', () => {
  // -----------------------------------------------------------------
  // Test #8 — PUBLIC CONTRACT — annotations + _meta.manifest matrix.
  //
  // Per PLAN.md §6.2 and CLAUDE.md "Tool annotations and `_meta.manifest`":
  // the manifest-agent plugin's PreToolUse hook reads `_meta.manifest.
  // broadcasts` to derive its broadcast policy. Changing this matrix is a
  // downstream-visible change and must be coordinated with ENG-130.
  //
  // | Tool                                  | readOnly | destructive | idempotent | broadcasts | estimable |
  // | ------------------------------------- | -------- | ----------- | ---------- | ---------- | --------- |
  // | deploy_app_orchestrated               | false    | false       | false      | true       | false     |
  // | manage_domain_orchestrated            | false    | false       | true       | true       | false     |
  // | troubleshoot_deployment_orchestrated  | true     | —           | —          | false      | false     |
  // | close_lease_orchestrated              | false    | true        | true       | true       | false     |
  // -----------------------------------------------------------------
  describe('tool annotations + _meta.manifest', () => {
    async function listTools() {
      const server = new AgentMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        return new Map(result.tools.map((t) => [t.name, t]));
      } finally {
        await client.close();
      }
    }

    it('every tool has annotations.title and _meta.manifest at the current version', async () => {
      // Safety net: when a new tool is registered, this test fails until
      // the contract metadata is added. Per-tool tests below pin values.
      const tools = await listTools();
      expect(tools.size).toBe(AGENT_TOOL_NAMES.length);
      for (const [name, tool] of tools) {
        expect(tool.annotations?.title, `${name} annotations.title`).toEqual(
          expect.any(String),
        );
        expect(tool._meta, `${name} _meta`).toMatchObject({
          manifest: {
            v: 1,
            broadcasts: expect.any(Boolean),
            estimable: expect.any(Boolean),
          },
        });
      }
    });

    it('deploy_app_orchestrated broadcasts a non-destructive, non-idempotent tx (each deploy creates a new lease)', async () => {
      const t = (await listTools()).get('deploy_app_orchestrated');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });

    it('manage_domain_orchestrated broadcasts a non-destructive idempotent tx (re-setting same value is a no-op)', async () => {
      // broadcasts: true is conservative — `lookup` doesn't broadcast,
      // but the manage-domain action union is gated by the plugin
      // conservatively (PLAN.md §6.2 footnote).
      const t = (await listTools()).get('manage_domain_orchestrated');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });

    it('troubleshoot_deployment_orchestrated is read-only', async () => {
      const t = (await listTools()).get('troubleshoot_deployment_orchestrated');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: false,
        estimable: false,
      });
    });

    it('close_lease_orchestrated broadcasts a destructive, idempotent (closing a closed lease is a no-op) tx', async () => {
      const t = (await listTools()).get('close_lease_orchestrated');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });
  });

  // -----------------------------------------------------------------
  // Tests #1-7, #9-10 — populated once engineer's #8 ships.
  // Order follows PLAN.md §6.2 numbering for cross-reference.
  // -----------------------------------------------------------------
  it.todo(
    '#1 deploy_app_orchestrated happy path: onPlan → confirm elicit; onConfirm → yes; progress in order; returns DeployResult',
  );
  it.todo(
    '#2 deploy_app_orchestrated partial-success recovery: onFailure(envelope, options) → enum-of-options[].id elicit; choice flows through dispatchRecovery → TX_FAILED retry msg',
  );
  it.todo(
    '#3 deploy_app_orchestrated plan-edit: client returns accept{verdict:edit_env, env_json} → fake observes typed PlanEdit',
  );
  it.todo(
    '#4 manage_domain_orchestrated set happy path: one onConfirm elicit; no plan/recovery schema; result returned',
  );
  it.todo(
    '#5 troubleshoot_deployment_orchestrated happy path: onConfirm + onProgress; returns TroubleshootReport',
  );
  it.todo(
    '#6 close_lease_orchestrated happy path: onConfirm; returns CloseLeaseResult',
  );
  it.todo(
    '#7 elicitation capability guard: client without elicitation capability → INVALID_CONFIG error envelope mentioning "elicitation"',
  );
  it.todo(
    '#9 listTools via protocol: server advertises exactly 4 tools with the documented names (real-orchestrator default — no overrides)',
  );
  it.todo(
    '#10 progress event serialization: mock fires each of the 8 ProgressEvent kinds → notifications/progress with `kind` reachable in `message`',
  );
});
