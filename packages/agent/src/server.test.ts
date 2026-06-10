// Vitest suite for `AgentMCPServer` per PLAN.md §6.2.
//
// Mock strategy (PLAN.md §6.1):
//   - `vi.mock('@manifest-network/manifest-mcp-core', ...)` for
//     `CosmosClientManager.getInstance` (chain construction — NOT part
//     of the orchestrator DI seam).
//   - **No** `vi.mock('@manifest-network/manifest-agent-core', ...)`. The
//     four orchestrator functions are injected via the constructor seam
//     `options.orchestrators?: Partial<AgentOrchestrators>` (PLAN.md
//     §1.1). Each test that exercises a tool handler supplies a scripted
//     fake; tests #8 (annotations matrix) and #9 (listTools count) leave
//     `orchestrators` undefined and exercise the real-default
//     construction path.

import type {
  CloseLeaseArgs,
  CloseLeaseCallbacks,
  CloseLeaseOptions,
  CloseLeaseResult,
  DeployAppCallbacks,
  DeployAppOptions,
  DeploymentPlanBlock,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainOptions,
  ManageDomainResult,
  Plan,
  PlanEdit,
  ProgressEvent,
  RecoveryChoice,
  RecoveryOption,
  TroubleshootArgs,
  TroubleshootCallbacks,
  TroubleshootOptions,
  TroubleshootReport,
} from '@manifest-network/manifest-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type ElicitRequestFormParams,
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  McpError,
  type ProgressNotification,
  ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
  callToolWithElicitation,
  type ElicitationScript,
} from '@manifest-network/manifest-mcp-core/__test-utils__/callToolWithElicitation.js';
import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { AgentMCPServer, type AgentOrchestrators } from './index.js';

const AGENT_TOOL_NAMES = [
  'deploy_app_orchestrated',
  'manage_domain_orchestrated',
  'lookup_custom_domain_orchestrated',
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

// ---------------------------------------------------------------------
// Test scaffolding helpers
// ---------------------------------------------------------------------

function makeServer(
  orchestrators?: Partial<AgentOrchestrators>,
): AgentMCPServer {
  return new AgentMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet({ signArbitrary: true }),
    ...(orchestrators ? { orchestrators } : {}),
  });
}

interface CaptureResult {
  toolResult: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  // The wrapper only ever sends form-mode elicitations (per the
  // `elicitation.ts` schema builders — none pass `mode: 'url'`). Narrow
  // the union at capture time so assertions can read `requestedSchema`
  // directly without a cast at every site.
  elicitations: ElicitRequestFormParams[];
  progress: ProgressNotification['params'][];
  logs: LoggingMessageNotification['params'][];
}

/**
 * Wire an MCP client (advertising elicitation), register notification
 * handlers for `notifications/progress` + `notifications/message`, and a
 * request handler for `elicitation/create`, then invoke the tool. Returns
 * the tool result alongside everything captured on the client side.
 *
 * Distinct from `callToolWithElicitation` (which intentionally omits
 * notification capture per PLAN.md §6.3); inline because tests #1 / #5 /
 * #10 need both elicitation responses AND notification streams.
 */
async function callToolWithCapture(
  server: AgentMCPServer,
  toolName: string,
  toolInput: Record<string, unknown>,
  script: ElicitationScript,
): Promise<CaptureResult> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  activeTransports.push(clientTransport, serverTransport);

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } },
  );

  const elicitations: ElicitRequestFormParams[] = [];
  const progress: ProgressNotification['params'][] = [];
  const logs: LoggingMessageNotification['params'][] = [];

  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    elicitations.push(req.params as ElicitRequestFormParams);
    return await script.respond(req);
  });
  client.setNotificationHandler(ProgressNotificationSchema, (n) => {
    progress.push(n.params);
  });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params);
  });

  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const toolResult = (await client.callTool({
      name: toolName,
      arguments: toolInput,
    })) as CaptureResult['toolResult'];
    return { toolResult, elicitations, progress, logs };
  } finally {
    await client.close().catch(() => {});
  }
}

function parseStructured<T = Record<string, unknown>>(result: {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}): T {
  if (result.structuredContent) return result.structuredContent as T;
  return JSON.parse(result.content[0].text) as T;
}

// ---------------------------------------------------------------------

describe('AgentMCPServer', () => {
  // ─────────────────────────────────────────────────────────────────
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
  // | lookup_custom_domain_orchestrated     | true     | —           | true       | false      | false     |
  // | troubleshoot_deployment_orchestrated  | true     | —           | true       | false      | false     |
  // | close_lease_orchestrated              | false    | true        | true       | true       | false     |
  // ─────────────────────────────────────────────────────────────────
  describe('tool annotations + _meta.manifest', () => {
    async function listTools() {
      const server = makeServer();
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

    it('lookup_custom_domain_orchestrated is read-only', async () => {
      const t = (await listTools()).get('lookup_custom_domain_orchestrated');
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

  // ─────────────────────────────────────────────────────────────────
  // Test #9 — listTools via protocol (smoke: real-default orchestrator
  // construction; no overrides). Exercises that `?? realX` works at
  // construction without invoking any orchestrator.
  // ─────────────────────────────────────────────────────────────────
  describe('#9 listTools via protocol', () => {
    it('advertises exactly 5 tools with the documented names', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(5);
        expect(result.tools.map((t) => t.name).sort()).toEqual(
          [...AGENT_TOOL_NAMES].sort(),
        );
      } finally {
        await client.close();
      }
    });

    // Phase 2 (finding #4): the per-call `data_dir` argument was removed
    // from `deploy_app_orchestrated`. Pin that surface — re-adding it
    // would reintroduce the LLM-controlled chmod-arbitrary-path
    // primitive.
    it('deploy_app_orchestrated input schema does NOT accept data_dir', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        const deploy = result.tools.find(
          (t) => t.name === 'deploy_app_orchestrated',
        );
        const props = (
          deploy?.inputSchema as { properties?: Record<string, unknown> }
        ).properties;
        expect(Object.keys(props ?? {})).toEqual(['spec']);
        expect(props).not.toHaveProperty('data_dir');
      } finally {
        await client.close();
      }
    });

    // ENG-275: `size` (the SKU / compute-tier selector) is load-bearing —
    // it drives SKU resolution, fee estimation, readiness, and the
    // persisted manifest — yet it used to be an undocumented escape-hatch
    // field readable only via cast. Promote it to a discoverable, typed
    // optional property on the `spec` schema so a contract-following caller
    // can select a non-default SKU. The property stays NESTED under `spec`
    // (not a sibling tool arg), so the top-level `['spec']` contract above
    // is unaffected.
    it('deploy_app_orchestrated spec schema surfaces a documented `size` property', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        const deploy = result.tools.find(
          (t) => t.name === 'deploy_app_orchestrated',
        );
        const specSchema = (
          deploy?.inputSchema as {
            properties?: { spec?: unknown };
          }
        ).properties?.spec as {
          properties?: { size?: { type?: string; description?: string } };
          required?: string[];
        };
        const size = specSchema?.properties?.size;
        expect(size).toBeDefined();
        expect(size?.type).toBe('string');
        expect(size?.description ?? '').not.toBe('');
        // Optional: omitting `size` must remain valid (defaults to 'small').
        expect(specSchema?.required ?? []).not.toContain('size');
      } finally {
        await client.close();
      }
    });

    // ENG-296: `providerUuid` and `skuUuid` are SKU disambiguators declared
    // as discoverable, typed optional properties on the `spec` schema so a
    // contract-following caller (or LLM) can pin a specific SKU or provider.
    // Mirrors the `size` test above — property stays NESTED under `spec`,
    // so the top-level `['spec']` contract is unaffected.
    it('deploy_app_orchestrated spec schema surfaces documented `providerUuid` and `skuUuid` properties', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        const deploy = result.tools.find(
          (t) => t.name === 'deploy_app_orchestrated',
        );
        const specSchema = (
          deploy?.inputSchema as {
            properties?: { spec?: unknown };
          }
        ).properties?.spec as {
          properties?: {
            providerUuid?: { type?: string; description?: string };
            skuUuid?: { type?: string; description?: string };
          };
          required?: string[];
        };
        const providerUuid = specSchema?.properties?.providerUuid;
        expect(
          providerUuid,
          'providerUuid must be defined on spec schema',
        ).toBeDefined();
        expect(providerUuid?.type).toBe('string');
        expect(providerUuid?.description ?? '').not.toBe('');
        // Optional: callers may omit it.
        expect(specSchema?.required ?? []).not.toContain('providerUuid');

        const skuUuid = specSchema?.properties?.skuUuid;
        expect(skuUuid, 'skuUuid must be defined on spec schema').toBeDefined();
        expect(skuUuid?.type).toBe('string');
        expect(skuUuid?.description ?? '').not.toBe('');
        // Optional: callers may omit it.
        expect(specSchema?.required ?? []).not.toContain('skuUuid');
      } finally {
        await client.close();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #11 — MANIFEST_AGENT_DATA_DIR env flow (Phase 2 / finding #4).
  // The per-call `data_dir` argument was removed; the env-var-only path
  // is the public contract. Assert the env value flows through to
  // `DeployAppOptions.dataDir` as observed by the orchestrator fake.
  // ─────────────────────────────────────────────────────────────────
  describe('#11 MANIFEST_AGENT_DATA_DIR env flow', () => {
    const ENV = 'MANIFEST_AGENT_DATA_DIR';
    let restore: string | undefined;
    beforeEach(() => {
      restore = process.env[ENV];
    });
    afterEach(() => {
      if (restore === undefined) {
        delete process.env[ENV];
      } else {
        process.env[ENV] = restore;
      }
    });

    it('env value flows into DeployAppOptions.dataDir', async () => {
      process.env[ENV] = '/tmp/fixture-manifest-data';
      let observedDataDir: string | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        opts,
      ) => {
        observedDataDir = opts.dataDir;
        // Short-circuit — the env wiring is the contract under test.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        cb.onProgress?.({ kind: 'user_confirmed' });
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'test stub: short-circuit after observing opts.dataDir',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'confirm' },
          }),
        },
      );
      expect(observedDataDir).toBe('/tmp/fixture-manifest-data');
    });

    it('unset env → DeployAppOptions.dataDir is undefined', async () => {
      delete process.env[ENV];
      let observedDataDir: string | undefined | symbol = Symbol('unset');
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        opts,
      ) => {
        observedDataDir = opts.dataDir;
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        cb.onProgress?.({ kind: 'user_confirmed' });
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'test stub: short-circuit after observing opts.dataDir',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'confirm' },
          }),
        },
      );
      // Spread omits `dataDir` when env is unset (see buildDeployOptions);
      // orchestrator therefore receives the slot as `undefined`.
      expect(observedDataDir).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ENG-258 r2 FIX A — snake_case sku_uuid / provider_uuid normalization.
  //
  // browse_catalog / check_deployment_readiness emit snake_case keys
  // (`sku_uuid`, `provider_uuid`). An LLM copying those keys into the
  // orchestrated spec silently drops them because agent-core reads the
  // camelCase variants. The handler normalizes snake → camel (preferring
  // an explicit camelCase value when both are present).
  // ─────────────────────────────────────────────────────────────────
  describe('deploy_app_orchestrated snake_case sku_uuid / provider_uuid normalization', () => {
    function makeShortCircuitDeploy(
      capture: (spec: DeploySpec) => void,
    ): AgentOrchestrators['deployApp'] {
      return async (_spec, cb, _opts) => {
        capture(_spec);
        // Short-circuit after observing the spec — no broadcast needed.
        cb.onProgress?.({ kind: 'user_confirmed' });
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'test stub: short-circuit after observing spec',
        );
      };
    }

    it('sku_uuid (snake) → skuUuid (camel) when skuUuid is absent', async () => {
      let observedSpec: DeploySpec | undefined;
      const server = makeServer({
        deployApp: makeShortCircuitDeploy((s) => {
          observedSpec = s;
        }),
      });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80, sku_uuid: 'sku-abc-123' } },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'confirm' },
          }),
        },
      );
      expect(
        (observedSpec as unknown as Record<string, unknown>)?.skuUuid,
      ).toBe('sku-abc-123');
    });

    it('provider_uuid (snake) → providerUuid (camel) when providerUuid is absent', async () => {
      let observedSpec: DeploySpec | undefined;
      const server = makeServer({
        deployApp: makeShortCircuitDeploy((s) => {
          observedSpec = s;
        }),
      });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        {
          spec: { image: 'nginx', port: 80, provider_uuid: 'prov-xyz-789' },
        },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'confirm' },
          }),
        },
      );
      expect(
        (observedSpec as unknown as Record<string, unknown>)?.providerUuid,
      ).toBe('prov-xyz-789');
    });

    it('explicit camelCase skuUuid wins over snake_case sku_uuid when both are present', async () => {
      let observedSpec: DeploySpec | undefined;
      const server = makeServer({
        deployApp: makeShortCircuitDeploy((s) => {
          observedSpec = s;
        }),
      });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        {
          spec: {
            image: 'nginx',
            port: 80,
            skuUuid: 'sku-camel-wins',
            sku_uuid: 'sku-snake-loses',
          },
        },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'confirm' },
          }),
        },
      );
      expect(
        (observedSpec as unknown as Record<string, unknown>)?.skuUuid,
      ).toBe('sku-camel-wins');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #1 — deploy_app_orchestrated happy path. Asserts:
  //   - onPlan elicitation carries the discriminated-union schema with
  //     enum: ['confirm','edit_env','replace_spec','cancel'].
  //   - Client returning accept{verdict:'confirm'} flows back to the
  //     fake as `'confirm'`.
  //   - onConfirm elicitation carries the binary yes/no schema with
  //     enum: ['yes','no'].
  //   - Progress notifications arrive in scripted order with the kind
  //     embedded in `params.message` (JSON-stringified).
  //   - Tool returns the fake's DeployResult.
  // ─────────────────────────────────────────────────────────────────
  describe('#1 deploy_app_orchestrated happy path', () => {
    it('routes plan + confirm elicitations and returns DeployResult', async () => {
      const planBlock: DeploymentPlanBlock = {
        text: '## Deployment plan body',
      };
      const recapBlock: DeploymentPlanBlock = { text: 'About to deploy nginx' };
      const deployResult: DeployResult = {
        leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
        providerUuid: 'prov-uuid',
        leaseState: 'LEASE_STATE_ACTIVE',
        urls: ['https://app.example.com/'],
        manifestPath: '',
      };
      let observedPlanVerdict: PlanEdit | 'confirm' | 'cancel' | undefined;
      let observedConfirm: 'yes' | 'no' | undefined;

      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec: DeploySpec,
        cb: DeployAppCallbacks,
        _opts: DeployAppOptions,
      ): Promise<DeployResult> => {
        cb.onProgress?.({
          kind: 'readiness_evaluated',
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
        });
        cb.onProgress?.({ kind: 'deployment_plan_rendered', block: planBlock });
        observedPlanVerdict = await cb.onPlan?.({
          summary: {
            format: 'single',
            serviceCount: 1,
            portCount: 1,
            envCount: 0,
            envKeys: [],
            images: ['nginx'],
          },
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '100' }],
              gas: 200000,
            },
          },
        } satisfies Plan);
        observedConfirm = await cb.onConfirm?.(recapBlock);
        cb.onProgress?.({ kind: 'user_confirmed' });
        cb.onProgress?.({ kind: 'deploy_app_broadcast' });
        cb.onProgress?.({
          kind: 'deploy_response_classified',
          outcome: 'active',
        });
        cb.onProgress?.({
          kind: 'app_ready_confirmed',
          leaseUuid: deployResult.leaseUuid,
        });
        cb.onProgress?.({ kind: 'success_rendered', result: deployResult });
        cb.onComplete?.(deployResult);
        return deployResult;
      };

      const server = makeServer({ deployApp: fakeDeploy });
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: (req) => {
            const params = req.params as ElicitRequestFormParams;
            const schema = params.requestedSchema as unknown as {
              properties: Record<string, { enum?: string[] }>;
            };
            const verdictEnum = schema.properties.verdict?.enum ?? [];
            if (verdictEnum.length === 4) {
              // plan schema
              return { action: 'accept', content: { verdict: 'confirm' } };
            }
            // confirm schema
            return { action: 'accept', content: { verdict: 'yes' } };
          },
        },
      );

      // Fake observed the typed callback returns.
      expect(observedPlanVerdict).toBe('confirm');
      expect(observedConfirm).toBe('yes');

      // Two elicitations: plan, then confirm.
      expect(captured.elicitations).toHaveLength(2);
      const planReq = captured.elicitations[0];
      expect(planReq.message).toBe(planBlock.text);
      const planSchema = planReq.requestedSchema as unknown as {
        properties: { verdict: { enum: string[]; enumNames?: string[] } };
      };
      expect(planSchema.properties.verdict.enum).toEqual([
        'confirm',
        'edit_env',
        'replace_spec',
        'cancel',
      ]);
      expect(planSchema.properties.verdict.enumNames).toEqual([
        'Approve plan',
        'Edit env vars',
        'Replace spec',
        'Cancel',
      ]);
      const confirmReq = captured.elicitations[1];
      expect(confirmReq.message).toBe(recapBlock.text);
      const confirmSchema = confirmReq.requestedSchema as unknown as {
        properties: { verdict: { enum: string[] } };
      };
      expect(confirmSchema.properties.verdict.enum).toEqual(['yes', 'no']);

      // Progress arrives in scripted order; each notification's `message`
      // field is JSON-stringified ProgressEvent.
      expect(
        captured.progress.map((p) => JSON.parse(p.message ?? '').kind),
      ).toEqual([
        'readiness_evaluated',
        'deployment_plan_rendered',
        'user_confirmed',
        'deploy_app_broadcast',
        'deploy_response_classified',
        'app_ready_confirmed',
        'success_rendered',
      ]);

      // Tool result is the typed DeployResult (structured content + text).
      expect(captured.toolResult.isError).toBeUndefined();
      const parsed = parseStructured<DeployResult>(captured.toolResult);
      expect(parsed).toMatchObject({
        leaseUuid: deployResult.leaseUuid,
        providerUuid: deployResult.providerUuid,
        leaseState: 'LEASE_STATE_ACTIVE',
        urls: ['https://app.example.com/'],
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #2 — deploy_app_orchestrated partial-success recovery.
  //   - Fake fires onFailure(envelope, options) with all four
  //     RecoveryOptions.
  //   - Wrapper builds the elicitation with enum from `options[].id`,
  //     enumNames from `options[].label`.
  //   - Message body concatenates `envelope.reason` + the option
  //     `label: description` lines (per PLAN.md §2.4 + callbacks.ts
  //     renderRecoveryMessage; all strings agent-core-owned).
  //   - Client returns accept{choice:'retry_set_domain'}; fake observes
  //     the typed RecoveryChoice.
  //   - Fake throws ManifestMCPError(TX_FAILED, "retry_set_domain
  //     completed...") matching dispatchRecovery's contract; tool
  //     surfaces it as the structured error envelope.
  // ─────────────────────────────────────────────────────────────────
  describe('#2 deploy_app_orchestrated partial-success recovery', () => {
    it('routes RecoveryOption[] through the elicitation and returns the dispatchRecovery throw as TX_FAILED', async () => {
      const envelope: FailureEnvelope = {
        outcome: 'partially_succeeded',
        leaseUuid: 'lease-1',
        requestedCustomDomain: 'app.example.com',
        reason:
          'Partial success: lease lease-1 created but custom_domain attach failed.',
      };
      const options: RecoveryOption[] = [
        {
          id: 'retry_set_domain',
          label: 'Retry set-domain + upload',
          description:
            'Retry the set-domain transaction against the already-created lease.',
        },
        {
          id: 'salvage_without_domain',
          label: 'Salvage without domain',
          description: 'Keep the lease without the requested custom domain.',
        },
        {
          id: 'cancel_lease',
          label: 'Cancel the lease',
          description:
            'Submit a cancel-lease transaction (pre-active terminal).',
        },
        {
          id: 'close_lease',
          label: 'Cancel or close the lease',
          description:
            'Submit a close-lease transaction (post-active or pre-active terminal).',
        },
      ];
      let observedChoice: RecoveryChoice | undefined;

      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        observedChoice = await cb.onFailure?.(envelope, options);
        // Replicate dispatchRecovery's `retry_set_domain` contract — a
        // ManifestMCPError(TX_FAILED) carrying the retry message.
        // (Importing the real `ManifestMCPError` via the mocked-module
        // surface still works because `importOriginal` is spread.)
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          `retry_set_domain completed for ${envelope.leaseUuid}; caller should re-run troubleshootDeployment to confirm app readiness.`,
        );
      };

      const server = makeServer({ deployApp: fakeDeploy });
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: () => ({
            action: 'accept',
            content: { choice: 'retry_set_domain' },
          }),
        },
      );

      // Fake observed the typed RecoveryChoice.
      expect(observedChoice).toEqual({ id: 'retry_set_domain' });

      // Exactly one elicitation — the recovery picker.
      expect(captured.elicitations).toHaveLength(1);
      const recReq = captured.elicitations[0];
      const recSchema = recReq.requestedSchema as unknown as {
        properties: {
          choice: { enum: string[]; enumNames?: string[] };
        };
      };
      // Enum mirrors options[].id 1-1 (dynamic build).
      expect(recSchema.properties.choice.enum).toEqual(
        options.map((o) => o.id),
      );
      expect(recSchema.properties.choice.enumNames).toEqual(
        options.map((o) => o.label),
      );
      // Message carries envelope.reason + per-option label:description
      // lines (mechanical assembly; no wrapper-flavored prose).
      expect(recReq.message).toContain(envelope.reason);
      for (const o of options) {
        expect(recReq.message).toContain(o.label);
        expect(recReq.message).toContain(o.description);
      }

      // Tool result surfaces the structured TX_FAILED envelope.
      expect(captured.toolResult.isError).toBe(true);
      const parsed = JSON.parse(captured.toolResult.content[0].text) as {
        code: string;
        message: string;
      };
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.message).toContain('retry_set_domain completed');
      expect(parsed.message).toContain(envelope.leaseUuid);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #2b/c/d — Phase 2 (finding #1) — recovery-prompt dismiss.
  //
  // The previous behavior threw INVALID_CONFIG on `decline` / `cancel`,
  // which unwound agent-core's `onFailure` invocation and left the
  // partial-success lease orphaned on-chain. Phase 2 synthesizes a
  // lease-preserving `salvage_without_domain` default and emits a
  // warning `notifications/message` so the user knows the default was
  // applied.
  // ─────────────────────────────────────────────────────────────────
  describe('#2b deploy_app_orchestrated recovery dismiss', () => {
    const envelope: FailureEnvelope = {
      outcome: 'partially_succeeded',
      leaseUuid: 'lease-1',
      requestedCustomDomain: 'app.example.com',
      reason:
        'Partial success: lease lease-1 created but custom_domain attach failed.',
    };
    const fullOptions: RecoveryOption[] = [
      {
        id: 'retry_set_domain',
        label: 'Retry set-domain + upload',
        description:
          'Retry the set-domain transaction against the already-created lease.',
      },
      {
        id: 'salvage_without_domain',
        label: 'Salvage without domain',
        description: 'Keep the lease without the requested custom domain.',
      },
      {
        id: 'cancel_lease',
        label: 'Cancel the lease',
        description: 'Submit a cancel-lease transaction (pre-active terminal).',
      },
      {
        id: 'close_lease',
        label: 'Cancel or close the lease',
        description:
          'Submit a close-lease transaction (post-active or pre-active terminal).',
      },
    ];

    async function runDismissCase(action: 'decline' | 'cancel'): Promise<{
      observed: RecoveryChoice | undefined;
      captured: CaptureResult;
    }> {
      let observed: RecoveryChoice | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        observed = await cb.onFailure?.(envelope, fullOptions);
        // Mimic dispatchRecovery's `salvage_without_domain` contract —
        // it returns the lease with the domain field cleared. Resolve
        // the orchestrator so we can inspect the warning notification.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'salvage_without_domain applied; lease preserved.',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        { respond: () => ({ action }) },
      );
      return { observed, captured };
    }

    it('action=cancel → synthesizes salvage_without_domain + emits warning notification', async () => {
      const { observed, captured } = await runDismissCase('cancel');
      expect(observed).toEqual({ id: 'salvage_without_domain' });
      // Warning notifications/message landed on the log channel.
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        dismissed_action: string;
        applied_default: string;
      };
      expect(data.kind).toBe('recovery_dismissed');
      expect(data.dismissed_action).toBe('cancel');
      expect(data.applied_default).toBe('salvage_without_domain');
    });

    it('action=decline → synthesizes salvage_without_domain + emits warning notification', async () => {
      const { observed, captured } = await runDismissCase('decline');
      expect(observed).toEqual({ id: 'salvage_without_domain' });
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      expect(
        (warnings[0].data as { dismissed_action: string }).dismissed_action,
      ).toBe('decline');
    });

    it('defensive: empty options[] on dismiss → INVALID_CONFIG', async () => {
      // Should be unreachable from agent-core today
      // (render-partial-success-prompt.ts always includes salvage_without_domain),
      // but pin the defensive branch.
      let observedError: { code?: string; message?: string } | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        try {
          await cb.onFailure?.(envelope, []);
        } catch (e) {
          observedError = e as { code?: string; message?: string };
        }
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'defensive-branch sentinel',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        { respond: () => ({ action: 'cancel' }) },
      );
      expect(observedError?.code).toBe('INVALID_CONFIG');
      expect(observedError?.message).toContain('salvage_without_domain');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #3 — deploy_app_orchestrated plan-edit. Client returns
  //   accept{verdict:'edit_env', env_json:'{"FOO":"bar"}'} → wrapper's
  //   `parsePlanVerdict` decodes to typed `{kind:'edit_env', env:...}`.
  // ─────────────────────────────────────────────────────────────────
  describe('#3 deploy_app_orchestrated plan-edit', () => {
    it("threads accept{verdict:'edit_env', env_json} as a typed PlanEdit back to the orchestrator", async () => {
      let observedPlanVerdict: PlanEdit | 'confirm' | 'cancel' | undefined;
      // The fake shortcircuits after onPlan — the typed return is the
      // only assertion this test needs.
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        cb.onProgress?.({
          kind: 'deployment_plan_rendered',
          block: { text: '## Deployment plan body' },
        });
        observedPlanVerdict = await cb.onPlan?.({
          summary: {
            format: 'single',
            serviceCount: 1,
            portCount: 1,
            envCount: 0,
            envKeys: [],
            images: ['nginx'],
          },
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '100' }],
              gas: 200000,
            },
          },
        });
        // Cancel out the rest of the flow — the typed PlanEdit reaching
        // the orchestrator is the contract under test.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'test stub: short-circuit after onPlan',
        );
      };

      const server = makeServer({ deployApp: fakeDeploy });
      await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: () => ({
            action: 'accept',
            content: {
              verdict: 'edit_env',
              env_json: '{"FOO":"bar"}',
            },
          }),
        },
      );

      expect(observedPlanVerdict).toEqual({
        kind: 'edit_env',
        env: { FOO: 'bar' },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #4 — manage_domain_orchestrated set happy path. Exactly one
  // elicitation (confirm); no plan / recovery schema; result returned.
  //
  // Uses the shared `callToolWithElicitation` helper to keep coverage of
  // the helper alive alongside the inline-capture path tests.
  // ─────────────────────────────────────────────────────────────────
  describe('#4 manage_domain_orchestrated set happy path', () => {
    it('elicits a single yes/no confirm and returns the ManageDomainResult', async () => {
      const expectedFqdn = 'app.example.com';
      const expectedLeaseUuid = '550e8400-e29b-41d4-a716-446655440000';
      let observedArgs: ManageDomainArgs | undefined;
      const elicitations: ElicitRequestFormParams[] = [];

      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        args: ManageDomainArgs,
        cb: ManageDomainCallbacks,
        _opts: ManageDomainOptions,
      ): Promise<ManageDomainResult> => {
        observedArgs = args;
        const yesNo = await cb.onConfirm?.({
          text: `Set custom domain on lease ${expectedLeaseUuid}`,
        });
        expect(yesNo).toBe('yes');
        const result: ManageDomainResult = {
          action: 'set',
          leaseUuid: expectedLeaseUuid,
          verified: true,
          finalCustomDomain: expectedFqdn,
        };
        cb.onComplete?.(result);
        return result;
      };

      const server = makeServer({ manageDomain: fakeManageDomain });
      const result = await callToolWithElicitation(
        server.getServer(),
        'manage_domain_orchestrated',
        {
          action: 'set',
          lease_uuid: expectedLeaseUuid,
          fqdn: expectedFqdn,
        },
        {
          respond: (req) => {
            elicitations.push(req.params as ElicitRequestFormParams);
            return { action: 'accept', content: { verdict: 'yes' } };
          },
        },
        activeTransports,
      );

      expect(observedArgs).toEqual({
        action: 'set',
        leaseUuid: expectedLeaseUuid,
        fqdn: expectedFqdn,
      });
      // Exactly one elicitation — the yes/no confirm. No plan / recovery.
      expect(elicitations).toHaveLength(1);
      const schema = elicitations[0].requestedSchema as unknown as {
        properties: { verdict: { enum: string[] } };
      };
      expect(schema.properties.verdict.enum).toEqual(['yes', 'no']);
      expect(result.isError).toBeUndefined();
      const parsed = parseStructured<ManageDomainResult>(result);
      expect(parsed).toMatchObject({
        action: 'set',
        leaseUuid: expectedLeaseUuid,
        verified: true,
        finalCustomDomain: expectedFqdn,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Copilot PR review (post-Phase-2): buildManageDomainArgs missing-arg
  // throws must surface as ManifestMCPError(INVALID_CONFIG), not a
  // plain Error that withErrorHandling coerces to code:'UNKNOWN'.
  // ─────────────────────────────────────────────────────────────────
  describe('manage_domain_orchestrated input validation', () => {
    const cases: Array<{
      label: string;
      input: Record<string, unknown>;
      messageMatch: RegExp;
    }> = [
      {
        label: 'action=set missing lease_uuid',
        input: { action: 'set', fqdn: 'app.example.com' },
        messageMatch: /action=set requires both lease_uuid and fqdn/,
      },
      {
        label: 'action=set missing fqdn',
        input: {
          action: 'set',
          lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        },
        messageMatch: /action=set requires both lease_uuid and fqdn/,
      },
      {
        label: 'action=clear missing lease_uuid',
        input: { action: 'clear' },
        messageMatch: /action=clear requires lease_uuid/,
      },
    ];

    for (const c of cases) {
      it(`${c.label} → INVALID_CONFIG (not UNKNOWN)`, async () => {
        const server = makeServer();
        const captured = await callToolWithCapture(
          server,
          'manage_domain_orchestrated',
          c.input,
          { respond: () => ({ action: 'cancel' }) },
        );
        expect(captured.toolResult.isError).toBe(true);
        const parsed = JSON.parse(captured.toolResult.content[0].text) as {
          code: string;
          message: string;
        };
        expect(parsed.code).toBe('INVALID_CONFIG');
        expect(parsed.message).toMatch(c.messageMatch);
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // lookup_custom_domain_orchestrated (ENG-212) — read-only reverse
  // lookup split out of manage_domain_orchestrated. Pure chain query:
  // the handler builds `{ action:'lookup', fqdn }` and calls the shared
  // `manageDomain` orchestrator. No elicitation, no broadcast.
  // ─────────────────────────────────────────────────────────────────
  describe('lookup_custom_domain_orchestrated', () => {
    it('resolves an FQDN to its owning lease with ZERO elicitations', async () => {
      const fqdn = 'app.example.com';
      const leaseUuid = '550e8400-e29b-41d4-a716-446655440000';
      let observedArgs: ManageDomainArgs | undefined;

      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        args: ManageDomainArgs,
        _cb: ManageDomainCallbacks,
        _opts: ManageDomainOptions,
      ): Promise<ManageDomainResult> => {
        observedArgs = args;
        return { action: 'lookup', fqdn, lease: { leaseUuid } };
      };

      const server = makeServer({ manageDomain: fakeManageDomain });
      const captured = await callToolWithCapture(
        server,
        'lookup_custom_domain_orchestrated',
        { fqdn },
        {
          respond: () => {
            throw new Error('lookup must not elicit');
          },
        },
      );

      expect(observedArgs).toEqual({ action: 'lookup', fqdn });
      expect(captured.elicitations).toHaveLength(0);
      expect(captured.toolResult.isError).toBeUndefined();
      const parsed = parseStructured<ManageDomainResult>(captured.toolResult);
      expect(parsed).toEqual({
        action: 'lookup',
        fqdn,
        lease: { leaseUuid },
      });
    });

    it('returns lease:null when the FQDN is unclaimed', async () => {
      const fqdn = 'unclaimed.example.com';
      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        _args,
        _cb,
        _opts,
      ): Promise<ManageDomainResult> => ({
        action: 'lookup',
        fqdn,
        lease: null,
      });

      const server = makeServer({ manageDomain: fakeManageDomain });
      const captured = await callToolWithCapture(
        server,
        'lookup_custom_domain_orchestrated',
        { fqdn },
        {
          respond: () => {
            throw new Error('lookup must not elicit');
          },
        },
      );

      expect(captured.toolResult.isError).toBeUndefined();
      const parsed = parseStructured<ManageDomainResult>(captured.toolResult);
      expect(parsed).toEqual({ action: 'lookup', fqdn, lease: null });
    });

    // The wrapper guards an empty/whitespace-only fqdn BEFORE reaching
    // agent-core, surfacing the tool-named INVALID_CONFIG envelope rather
    // than leaking agent-core's internal `manageDomain` function name.
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('rejects %s fqdn with a tool-named INVALID_CONFIG before reaching agent-core', async (_label, fqdn) => {
      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async () => {
        throw new Error(
          'manageDomain must not be called when wrapper rejects empty fqdn',
        );
      };

      const server = makeServer({ manageDomain: fakeManageDomain });
      const captured = await callToolWithCapture(
        server,
        'lookup_custom_domain_orchestrated',
        { fqdn },
        {
          respond: () => {
            throw new Error('lookup must not elicit');
          },
        },
      );

      expect(captured.toolResult.isError).toBe(true);
      const parsed = JSON.parse(captured.toolResult.content[0].text) as {
        code: string;
        message: string;
      };
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toContain(
        'lookup_custom_domain_orchestrated: fqdn must be a non-empty string.',
      );
    });

    // Mirrors the troubleshoot pin (#5): the lookup factory must omit
    // `onConfirm` — agent-core's `lookupDomain` never invokes one, and
    // supplying it would re-introduce a dead-branch elicitation on a
    // read-only path.
    it('makeLookupDomainCallbacks does not supply onConfirm', async () => {
      let observed: ManageDomainCallbacks | undefined;
      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        _args,
        cb,
        _opts,
      ): Promise<ManageDomainResult> => {
        observed = cb;
        return {
          action: 'lookup',
          fqdn: 'app.example.com',
          lease: { leaseUuid: 'lease-1' },
        };
      };
      const server = makeServer({ manageDomain: fakeManageDomain });
      await callToolWithCapture(
        server,
        'lookup_custom_domain_orchestrated',
        { fqdn: 'app.example.com' },
        { respond: () => ({ action: 'accept', content: {} }) },
      );
      expect(observed).toBeDefined();
      expect(observed?.onConfirm).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #5 — troubleshoot_deployment_orchestrated happy path. Phase 2
  // (finding #11): the wrapper no longer supplies an `onConfirm`
  // callback and agent-core never invokes one — so this flow MUST run
  // with ZERO elicitations. The progress emission + report passthrough
  // remain the contract.
  // ─────────────────────────────────────────────────────────────────
  describe('#5 troubleshoot_deployment_orchestrated happy path', () => {
    it('emits progress and returns the TroubleshootReport with NO elicitation', async () => {
      const expectedLeaseUuid = '550e8400-e29b-41d4-a716-446655440000';
      const report: TroubleshootReport = {
        markdown: '# Lease diagnostic — lease-1\n\nState: ACTIVE',
      };
      let observedArgs: TroubleshootArgs | undefined;

      const fakeTroubleshoot: AgentOrchestrators['troubleshootDeployment'] =
        async (
          args: TroubleshootArgs,
          cb: TroubleshootCallbacks,
          _opts: TroubleshootOptions,
        ): Promise<TroubleshootReport> => {
          observedArgs = args;
          // No onConfirm — the wrapper no longer supplies one.
          cb.onProgress?.({
            kind: 'readiness_evaluated',
            readiness: {
              status: 'ok',
              reasons: [],
              suggestedActions: [],
              walletBalances: [],
              credits: null,
              sku: null,
            },
          });
          cb.onComplete?.(report);
          return report;
        };

      const server = makeServer({
        troubleshootDeployment: fakeTroubleshoot,
      });
      const captured = await callToolWithCapture(
        server,
        'troubleshoot_deployment_orchestrated',
        { lease_uuid: expectedLeaseUuid },
        {
          respond: () => {
            throw new Error(
              'troubleshoot must not elicit; the wrapper drops onConfirm.',
            );
          },
        },
      );

      expect(observedArgs).toEqual({ leaseUuid: expectedLeaseUuid });
      expect(captured.elicitations).toHaveLength(0);
      expect(captured.progress).toHaveLength(1);
      expect(JSON.parse(captured.progress[0].message ?? '').kind).toBe(
        'readiness_evaluated',
      );
      expect(captured.toolResult.isError).toBeUndefined();
      const parsed = parseStructured<TroubleshootReport>(captured.toolResult);
      expect(parsed.markdown).toContain('Lease diagnostic');
    });

    // Phase 2 (finding #11): the `TroubleshootCallbacks` type still
    // declares `onConfirm` as optional, but the wrapper's factory now
    // omits it. Pin that the factory's return shape doesn't carry one
    // — re-adding it would re-introduce the dead-branch elicitation.
    it('makeTroubleshootCallbacks does not supply onConfirm', async () => {
      let observed: TroubleshootCallbacks | undefined;
      const fakeTroubleshoot: AgentOrchestrators['troubleshootDeployment'] =
        async (_args, cb, _opts) => {
          observed = cb;
          return { markdown: '' };
        };
      const server = makeServer({
        troubleshootDeployment: fakeTroubleshoot,
      });
      await callToolWithCapture(
        server,
        'troubleshoot_deployment_orchestrated',
        { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        { respond: () => ({ action: 'accept', content: {} }) },
      );
      expect(observed).toBeDefined();
      expect(observed?.onConfirm).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #6 — close_lease_orchestrated happy path.
  // ─────────────────────────────────────────────────────────────────
  describe('#6 close_lease_orchestrated happy path', () => {
    it('elicits confirm and returns the CloseLeaseResult', async () => {
      const expectedLeaseUuid = '550e8400-e29b-41d4-a716-446655440000';
      const result: CloseLeaseResult = {
        leaseUuid: expectedLeaseUuid,
        finalState: 'LEASE_STATE_CLOSED',
      };
      let observedArgs: CloseLeaseArgs | undefined;

      const fakeClose: AgentOrchestrators['closeLease'] = async (
        args: CloseLeaseArgs,
        cb: CloseLeaseCallbacks,
        _opts: CloseLeaseOptions,
      ): Promise<CloseLeaseResult> => {
        observedArgs = args;
        const yesNo = await cb.onConfirm?.({
          text: `Close lease ${args.leaseUuid}.`,
        });
        expect(yesNo).toBe('yes');
        cb.onComplete?.(result);
        return result;
      };

      const server = makeServer({ closeLease: fakeClose });
      const captured = await callToolWithCapture(
        server,
        'close_lease_orchestrated',
        { lease_uuid: expectedLeaseUuid },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'yes' },
          }),
        },
      );

      expect(observedArgs).toEqual({ leaseUuid: expectedLeaseUuid });
      expect(captured.elicitations).toHaveLength(1);
      expect(captured.toolResult.isError).toBeUndefined();
      const parsed = parseStructured<CloseLeaseResult>(captured.toolResult);
      expect(parsed).toEqual(result);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #7 — elicitation capability guard.
  //
  // Phase 2 (finding #10): the guard is no longer unconditional. The
  // read-only paths run without elicitation; only the broadcast-
  // requiring paths reject hosts that don't advertise
  // `capabilities.elicitation`.
  //
  // | Tool / action                                     | Guard? |
  // | ------------------------------------------------- | ------ |
  // | deploy_app_orchestrated                           | yes    |
  // | manage_domain_orchestrated  action=set            | yes    |
  // | manage_domain_orchestrated  action=clear          | yes    |
  // | lookup_custom_domain_orchestrated                 | NO     |
  // | troubleshoot_deployment_orchestrated              | NO     |
  // | close_lease_orchestrated                          | yes    |
  // ─────────────────────────────────────────────────────────────────
  describe('#7 elicitation capability guard', () => {
    interface GuardCase {
      label: string;
      toolName: string;
      args: Record<string, unknown>;
      orchestratorKey: keyof AgentOrchestrators;
      mustGuard: boolean;
      // When `mustGuard:false`, the fake must produce a real result the
      // tool can return — pass via this hook.
      buildFake?: () => Partial<AgentOrchestrators>;
    }

    const guardCases: GuardCase[] = [
      {
        label: 'deploy_app_orchestrated',
        toolName: 'deploy_app_orchestrated',
        args: { spec: { image: 'nginx', port: 80 } },
        orchestratorKey: 'deployApp',
        mustGuard: true,
      },
      {
        label: 'manage_domain_orchestrated action=set',
        toolName: 'manage_domain_orchestrated',
        args: {
          action: 'set',
          lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
          fqdn: 'app.example.com',
        },
        orchestratorKey: 'manageDomain',
        mustGuard: true,
      },
      {
        label: 'manage_domain_orchestrated action=clear',
        toolName: 'manage_domain_orchestrated',
        args: {
          action: 'clear',
          lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        },
        orchestratorKey: 'manageDomain',
        mustGuard: true,
      },
      {
        label: 'close_lease_orchestrated',
        toolName: 'close_lease_orchestrated',
        args: { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        orchestratorKey: 'closeLease',
        mustGuard: true,
      },
      {
        label: 'lookup_custom_domain_orchestrated',
        toolName: 'lookup_custom_domain_orchestrated',
        args: {
          fqdn: 'app.example.com',
        },
        orchestratorKey: 'manageDomain',
        mustGuard: false,
        buildFake: () => ({
          manageDomain: (async () => ({
            action: 'lookup',
            fqdn: 'app.example.com',
            lease: { leaseUuid: 'lease-1' },
          })) as unknown as AgentOrchestrators['manageDomain'],
        }),
      },
      {
        label: 'troubleshoot_deployment_orchestrated',
        toolName: 'troubleshoot_deployment_orchestrated',
        args: { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        orchestratorKey: 'troubleshootDeployment',
        mustGuard: false,
        buildFake: () => ({
          troubleshootDeployment: (async () => ({
            markdown: '# diagnostic',
          })) as unknown as AgentOrchestrators['troubleshootDeployment'],
        }),
      },
    ];

    for (const c of guardCases) {
      if (c.mustGuard) {
        it(`${c.label}: missing elicitation capability → INVALID_CONFIG`, async () => {
          const orchestratorEntered = vi.fn();
          const sentinel: Partial<AgentOrchestrators> = {
            [c.orchestratorKey]: (async (..._a: unknown[]) => {
              orchestratorEntered();
              throw new Error('should not reach orchestrator');
            }) as unknown,
          } as Partial<AgentOrchestrators>;
          const server = makeServer(sentinel);
          const result = await callToolWithElicitation(
            server.getServer(),
            c.toolName,
            c.args,
            { respond: (): ElicitResult => ({ action: 'decline' }) },
            activeTransports,
            /* declareElicitationCapability */ false,
          );
          expect(result.isError).toBe(true);
          const parsed = JSON.parse(result.content[0].text) as {
            code: string;
            message: string;
          };
          expect(parsed.code).toBe('INVALID_CONFIG');
          expect(parsed.message).toMatch(/elicitation/i);
          expect(orchestratorEntered).not.toHaveBeenCalled();
        });
      } else {
        it(`${c.label}: missing elicitation capability → SUCCESS (read-only path)`, async () => {
          const server = makeServer(c.buildFake?.());
          const result = await callToolWithElicitation(
            server.getServer(),
            c.toolName,
            c.args,
            { respond: (): ElicitResult => ({ action: 'accept' }) },
            activeTransports,
            /* declareElicitationCapability */ false,
          );
          expect(result.isError).toBeUndefined();
        });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #10 — progress event serialization. Fire each of the 8
  // `ProgressEvent` kinds through a fake `troubleshootDeployment` (the
  // simplest orchestrator that can emit progress without confirmation
  // gating). Assert: 8 notifications/progress arrive; each `message`
  // JSON-parses to the original event; kinds preserved in order.
  // ─────────────────────────────────────────────────────────────────
  describe('#10 progress event serialization', () => {
    it('emits one notifications/progress per ProgressEvent kind with the kind reachable in the message field', async () => {
      const events: ProgressEvent[] = [
        {
          kind: 'readiness_evaluated',
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
        },
        {
          kind: 'deployment_plan_rendered',
          block: { text: 'plan' },
        },
        { kind: 'user_confirmed' },
        { kind: 'deploy_app_broadcast', leaseUuid: 'lease-1' },
        { kind: 'deploy_response_classified', outcome: 'active' },
        { kind: 'app_ready_confirmed', leaseUuid: 'lease-1' },
        {
          kind: 'manifest_saved',
          leaseUuid: 'lease-1',
          manifestPath: '/tmp/manifest.json',
        },
        {
          kind: 'success_rendered',
          result: {
            leaseUuid: 'lease-1',
            providerUuid: 'prov-1',
            leaseState: 'LEASE_STATE_ACTIVE',
            urls: [],
            manifestPath: '',
          },
        },
      ];

      const fakeTroubleshoot: AgentOrchestrators['troubleshootDeployment'] =
        async (_args, cb, _opts) => {
          // Phase 2 (finding #11): troubleshoot has no onConfirm. Fire
          // events directly.
          for (const ev of events) {
            cb.onProgress?.(ev);
          }
          const report: TroubleshootReport = { markdown: 'done' };
          cb.onComplete?.(report);
          return report;
        };

      const server = makeServer({
        troubleshootDeployment: fakeTroubleshoot,
      });
      const captured = await callToolWithCapture(
        server,
        'troubleshoot_deployment_orchestrated',
        { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        {
          respond: () => {
            throw new Error('troubleshoot must not elicit');
          },
        },
      );

      expect(captured.progress).toHaveLength(events.length);
      const decodedKinds = captured.progress.map(
        (p) => JSON.parse(p.message ?? '').kind,
      );
      expect(decodedKinds).toEqual(events.map((e) => e.kind));
      // Spot-check round-trip on a payload-bearing event.
      const decodedThird = JSON.parse(captured.progress[3].message ?? '');
      expect(decodedThird).toEqual({
        kind: 'deploy_app_broadcast',
        leaseUuid: 'lease-1',
      });
      // ENG-210 (Phase 2): the wrapper now declares
      // `capabilities: { tools: {}, logging: {} }` so the
      // `notifications/message` (level=info) sibling emissions per
      // progress event reach the host. Assert the log channel mirrors
      // the progress channel — one info log per progress event,
      // wrapping the original ProgressEvent in `data.event`.
      expect(captured.logs).toHaveLength(events.length);
      const decodedLogEventKinds = captured.logs.map(
        (l) =>
          (l.data as { kind?: string; event?: { kind?: string } } | undefined)
            ?.event?.kind,
      );
      expect(decodedLogEventKinds).toEqual(events.map((e) => e.kind));
      for (const l of captured.logs) {
        expect(l.level).toBe('info');
        expect((l.data as { kind?: string } | undefined)?.kind).toBe(
          'progress',
        );
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #12 — Phase 2 (findings #7 + #8): every elicitInput call
  // passes a RequestOptions second-arg carrying a 10-minute timeout
  // and the in-flight request's AbortSignal.
  //
  // We spy on `server.elicitInput` directly and exercise one call site
  // per tool surface (manage_domain onConfirm, close_lease onConfirm —
  // troubleshoot has no elicitInput call any more, see #11).
  // ─────────────────────────────────────────────────────────────────
  describe('#12 elicitInput RequestOptions (timeout + signal)', () => {
    it('manage_domain set: elicitInput receives { timeout: 600000, signal: AbortSignal }', async () => {
      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        _args,
        cb,
        _opts,
      ) => {
        await cb.onConfirm?.({ text: 'set?' });
        return {
          action: 'set',
          leaseUuid: 'lease-1',
          verified: true,
          finalCustomDomain: 'app.example.com',
        } satisfies ManageDomainResult;
      };
      const server = makeServer({ manageDomain: fakeManageDomain });
      const sdkServer = server.getServer();
      const spy = vi.spyOn(sdkServer, 'elicitInput');
      await callToolWithElicitation(
        sdkServer,
        'manage_domain_orchestrated',
        {
          action: 'set',
          lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
          fqdn: 'app.example.com',
        },
        {
          respond: () => ({ action: 'accept', content: { verdict: 'yes' } }),
        },
        activeTransports,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const requestOptions = spy.mock.calls[0][1];
      expect(requestOptions).toBeDefined();
      expect(requestOptions?.timeout).toBe(10 * 60_000);
      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('close_lease: elicitInput receives RequestOptions with timeout + signal', async () => {
      const fakeClose: AgentOrchestrators['closeLease'] = async (
        _args,
        cb,
        _opts,
      ) => {
        await cb.onConfirm?.({ text: 'close?' });
        return {
          leaseUuid: 'lease-1',
          finalState: 'LEASE_STATE_CLOSED',
        } satisfies CloseLeaseResult;
      };
      const server = makeServer({ closeLease: fakeClose });
      const sdkServer = server.getServer();
      const spy = vi.spyOn(sdkServer, 'elicitInput');
      await callToolWithElicitation(
        sdkServer,
        'close_lease_orchestrated',
        { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        {
          respond: () => ({ action: 'accept', content: { verdict: 'yes' } }),
        },
        activeTransports,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const requestOptions = spy.mock.calls[0][1];
      expect(requestOptions?.timeout).toBe(10 * 60_000);
      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #13 — Phase 2 (finding #13): parsePlanVerdict's `replace_spec`
  // branch rejects JSON arrays (matches the parallel `edit_env` guard).
  // Pre-fix `typeof [] === 'object'` slipped through, letting an array
  // get cast to `DeploySpec`.
  // ─────────────────────────────────────────────────────────────────
  describe('#13 parsePlanVerdict replace_spec Array.isArray guard', () => {
    async function runWithSpecJson(specJson: string): Promise<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }> {
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        cb.onProgress?.({
          kind: 'deployment_plan_rendered',
          block: { text: 'plan' },
        });
        await cb.onPlan?.({
          summary: {
            format: 'single',
            serviceCount: 1,
            portCount: 1,
            envCount: 0,
            envKeys: [],
            images: ['nginx'],
          },
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '100' }],
              gas: 200000,
            },
          },
        });
        // Unreachable when parsePlanVerdict throws above.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'should-not-reach',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        {
          respond: () => ({
            action: 'accept',
            content: { verdict: 'replace_spec', spec_json: specJson },
          }),
        },
      );
      return captured.toolResult;
    }

    it('spec_json="[]" rejected with INVALID_CONFIG (JSON object required)', async () => {
      const result = await runWithSpecJson('[]');
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as {
        code: string;
        message: string;
      };
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/must parse to a JSON object/);
    });

    it('spec_json="[{...}]" rejected with INVALID_CONFIG (JSON object required)', async () => {
      const result = await runWithSpecJson('[{"image":"nginx"}]');
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as {
        code: string;
        message: string;
      };
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/must parse to a JSON object/);
    });
  });

  // Phase 2 finding #12 regression — `getRuntime` / `getDenomMap`
  // cache-clear-on-rejection — lives in `index-cache.test.ts` (uses
  // a file-scoped `vi.mock('./runtime.js', ...)` to inject a
  // fail-then-succeed buildRuntime). Kept separate so the local-mock
  // hoist doesn't bleed into this suite's tests.

  // ─────────────────────────────────────────────────────────────────
  // Test #14 — Phase 2 (ENG-210): the server advertises `logging: {}`
  // capability at initialize. Without it the SDK's
  // `assertNotificationCapability` throws and every
  // `notifications/message` is dropped by `safeNotify`'s catch.
  // ─────────────────────────────────────────────────────────────────
  describe('#14 logging capability', () => {
    it('advertises logging:{} at initialize', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        { capabilities: {} },
      );
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const caps = client.getServerCapabilities();
        expect(caps?.logging).toBeDefined();
        expect(caps?.tools).toBeDefined();
      } finally {
        await client.close();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Test #15 — ENG-272 — elicitInput REJECTION → safe defaults.
  //
  // PRIOR BUG: when `server.elicitInput(...)` REJECTS (10-min timeout,
  // host abort, transport close) instead of resolving with a
  // `decline`/`cancel` action, the thrown `McpError` propagated past the
  // callback, past agent-core, into `withErrorHandling`, which (it is not
  // a `ManifestMCPError`) coerced it to `code:'UNKNOWN'` — AFTER a paid
  // lease may already exist for the deploy recovery path.
  //
  // FIX: each elicit site catches the rejection and applies a safe
  // default:
  //   - recovery (onFailure) → `salvage_without_domain` (lease preserved);
  //     surfaces as TX_FAILED from agent-core (NOT UNKNOWN).
  //   - confirm/plan (onPlan, onConfirm ×3) → decline; agent-core throws
  //     OPERATION_CANCELLED (NOT UNKNOWN); no broadcast fires.
  // A warning `notifications/message` documents the implicit decision.
  //
  // The spy targets `server.getServer().elicitInput` directly (the method
  // the callback code awaits) — `mockRejectedValueOnce` short-circuits
  // before the request reaches the client transport, exactly modelling a
  // rejected in-flight elicitation. Mirrors the test #12 spy pattern.
  // ─────────────────────────────────────────────────────────────────
  describe('#15 elicitInput rejection — safe defaults', () => {
    const envelope: FailureEnvelope = {
      outcome: 'partially_succeeded',
      leaseUuid: 'lease-272',
      requestedCustomDomain: 'app.example.com',
      reason:
        'Partial success: lease lease-272 created but custom_domain attach failed.',
    };
    const fullOptions: RecoveryOption[] = [
      {
        id: 'retry_set_domain',
        label: 'Retry set-domain + upload',
        description:
          'Retry the set-domain transaction against the already-created lease.',
      },
      {
        id: 'salvage_without_domain',
        label: 'Salvage without domain',
        description: 'Keep the lease without the requested custom domain.',
      },
      {
        id: 'cancel_lease',
        label: 'Cancel the lease',
        description: 'Submit a cancel-lease transaction (pre-active terminal).',
      },
      {
        id: 'close_lease',
        label: 'Cancel or close the lease',
        description:
          'Submit a close-lease transaction (post-active or pre-active terminal).',
      },
    ];

    // A `respond` that must never run — when the spy rejects/resolves the
    // call short-circuits before the request reaches the client handler.
    const respondNever: ElicitationScript = {
      respond: () => {
        throw new Error('elicitInput spy should intercept before the wire');
      },
    };

    function parseResultCode(captured: CaptureResult): {
      code?: string;
      message?: string;
    } {
      return JSON.parse(captured.toolResult.content[0].text) as {
        code?: string;
        message?: string;
      };
    }

    it('#15a recovery (onFailure) rejection → salvage_without_domain, lease preserved (TX_FAILED, not UNKNOWN)', async () => {
      let observed: RecoveryChoice | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        observed = await cb.onFailure?.(envelope, fullOptions);
        // Mimic dispatchRecovery's salvage_without_domain contract: it
        // preserves the lease (no stopApp) and surfaces TX_FAILED.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'salvage_without_domain applied; lease preserved.',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      vi.spyOn(server.getServer(), 'elicitInput').mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, 'Request timed out', {
          timeout: 600000,
        }),
      );
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        respondNever,
      );

      // Lease-preserving default returned to the orchestrator.
      expect(observed).toEqual({ id: 'salvage_without_domain' });
      // Tool result is the TX_FAILED salvage outcome — NOT UNKNOWN.
      expect(captured.toolResult.isError).toBe(true);
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.code).not.toBe('UNKNOWN');
      // Exactly one warning notification, describing the implicit choice.
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        dismissed_action: string;
        applied_default: string;
      };
      expect(data.kind).toBe('recovery_dismissed');
      expect(data.dismissed_action).toBe('timeout');
      expect(data.applied_default).toBe('salvage_without_domain');
    });

    it('#15b recovery (onFailure) rejection via ConnectionClosed → salvage_without_domain (connection_closed tag)', async () => {
      let observed: RecoveryChoice | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        observed = await cb.onFailure?.(envelope, fullOptions);
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'salvage_without_domain applied; lease preserved.',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      vi.spyOn(server.getServer(), 'elicitInput').mockRejectedValueOnce(
        new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
      );
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        respondNever,
      );

      expect(observed).toEqual({ id: 'salvage_without_domain' });
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('TX_FAILED');
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        dismissed_action: string;
        applied_default: string;
      };
      expect(data.kind).toBe('recovery_dismissed');
      expect(data.dismissed_action).toBe('connection_closed');
      expect(data.applied_default).toBe('salvage_without_domain');
    });

    it('#15c deploy onPlan rejection → cancel (OPERATION_CANCELLED, not UNKNOWN)', async () => {
      let observed: PlanEdit | 'confirm' | 'cancel' | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        cb.onProgress?.({
          kind: 'deployment_plan_rendered',
          block: { text: 'plan' },
        });
        observed = await cb.onPlan?.({
          summary: {
            format: 'single',
            serviceCount: 1,
            portCount: 1,
            envCount: 0,
            envKeys: [],
            images: ['nginx'],
          },
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '100' }],
              gas: 200000,
            },
          },
        });
        // Real deploy-app throws OPERATION_CANCELLED on a 'cancel' verdict.
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.OPERATION_CANCELLED,
          'User cancelled deployment at plan step.',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      vi.spyOn(server.getServer(), 'elicitInput').mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
      );
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        respondNever,
      );

      expect(observed).toBe('cancel');
      expect(captured.toolResult.isError).toBe(true);
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('OPERATION_CANCELLED');
      expect(parsed.code).not.toBe('UNKNOWN');
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        callback: string;
        applied_default: string;
      };
      expect(data.kind).toBe('elicit_timeout');
      expect(data.callback).toBe('onPlan');
      expect(data.applied_default).toBe('cancel');
    });

    it('#15d deploy onConfirm rejection → no (OPERATION_CANCELLED, not UNKNOWN)', async () => {
      let confirmVerdict: 'yes' | 'no' | undefined;
      const fakeDeploy: AgentOrchestrators['deployApp'] = async (
        _spec,
        cb,
        _opts,
      ) => {
        cb.onProgress?.({
          kind: 'deployment_plan_rendered',
          block: { text: 'plan' },
        });
        const planVerdict = await cb.onPlan?.({
          summary: {
            format: 'single',
            serviceCount: 1,
            portCount: 1,
            envCount: 0,
            envKeys: [],
            images: ['nginx'],
          },
          readiness: {
            status: 'ok',
            reasons: [],
            suggestedActions: [],
            walletBalances: [],
            credits: null,
            sku: null,
          },
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '100' }],
              gas: 200000,
            },
          },
        });
        expect(planVerdict).toBe('confirm');
        confirmVerdict = await cb.onConfirm?.({ text: 'Proceed?' });
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.OPERATION_CANCELLED,
          'User declined to proceed at intent-recap step.',
        );
      };
      const server = makeServer({ deployApp: fakeDeploy });
      // onPlan resolves (accept→confirm), then onConfirm REJECTS.
      vi.spyOn(server.getServer(), 'elicitInput')
        .mockResolvedValueOnce({
          action: 'accept',
          content: { verdict: 'confirm' },
        } as ElicitResult)
        .mockRejectedValueOnce(
          new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
        );
      const captured = await callToolWithCapture(
        server,
        'deploy_app_orchestrated',
        { spec: { image: 'nginx', port: 80 } },
        respondNever,
      );

      expect(confirmVerdict).toBe('no');
      expect(captured.toolResult.isError).toBe(true);
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('OPERATION_CANCELLED');
      expect(parsed.code).not.toBe('UNKNOWN');
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        callback: string;
        applied_default: string;
      };
      expect(data.kind).toBe('elicit_timeout');
      expect(data.callback).toBe('onConfirm');
      expect(data.applied_default).toBe('no');
    });

    it('#15e manage_domain onConfirm rejection → no (OPERATION_CANCELLED); broadcast NOT fired', async () => {
      let confirmVerdict: 'yes' | 'no' | undefined;
      const fakeManageDomain: AgentOrchestrators['manageDomain'] = async (
        _args,
        cb,
        _opts,
      ) => {
        confirmVerdict = await cb.onConfirm?.({ text: 'Set domain?' });
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.OPERATION_CANCELLED,
          'User declined to proceed with manage-domain set.',
        );
      };
      const server = makeServer({ manageDomain: fakeManageDomain });
      vi.spyOn(server.getServer(), 'elicitInput').mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
      );
      const captured = await callToolWithCapture(
        server,
        'manage_domain_orchestrated',
        {
          action: 'set',
          lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
          fqdn: 'app.example.com',
        },
        respondNever,
      );

      expect(confirmVerdict).toBe('no');
      expect(captured.toolResult.isError).toBe(true);
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('OPERATION_CANCELLED');
      expect(parsed.code).not.toBe('UNKNOWN');
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        callback: string;
        applied_default: string;
      };
      expect(data.kind).toBe('elicit_timeout');
      expect(data.callback).toBe('onConfirm');
      expect(data.applied_default).toBe('no');
    });

    it('#15f close_lease onConfirm rejection → no (OPERATION_CANCELLED); lease left open', async () => {
      let confirmVerdict: 'yes' | 'no' | undefined;
      const fakeCloseLease: AgentOrchestrators['closeLease'] = async (
        _args,
        cb,
        _opts,
      ) => {
        confirmVerdict = await cb.onConfirm?.({ text: 'Close lease?' });
        const { ManifestMCPError, ManifestMCPErrorCode } = await import(
          '@manifest-network/manifest-mcp-core'
        );
        throw new ManifestMCPError(
          ManifestMCPErrorCode.OPERATION_CANCELLED,
          'User declined to proceed with close-lease.',
        );
      };
      const server = makeServer({ closeLease: fakeCloseLease });
      vi.spyOn(server.getServer(), 'elicitInput').mockRejectedValueOnce(
        new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
      );
      const captured = await callToolWithCapture(
        server,
        'close_lease_orchestrated',
        { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' },
        respondNever,
      );

      expect(confirmVerdict).toBe('no');
      expect(captured.toolResult.isError).toBe(true);
      const parsed = parseResultCode(captured);
      expect(parsed.code).toBe('OPERATION_CANCELLED');
      expect(parsed.code).not.toBe('UNKNOWN');
      const warnings = captured.logs.filter((l) => l.level === 'warning');
      expect(warnings).toHaveLength(1);
      const data = warnings[0].data as {
        kind: string;
        callback: string;
        applied_default: string;
      };
      expect(data.kind).toBe('elicit_timeout');
      expect(data.callback).toBe('onConfirm');
      expect(data.applied_default).toBe('no');
    });
  });
});
