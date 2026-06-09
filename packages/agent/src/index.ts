/**
 * `@manifest-network/manifest-mcp-agent` — MCP server wrapping
 * `@manifest-network/manifest-agent-core` orchestration via MCP
 * elicitation + progress notifications.
 *
 * Five tools, each a thin adapter around an agent-core operation
 * (two — `manage_domain_orchestrated` and `lookup_custom_domain_orchestrated`
 * — wrap different branches of the same `manageDomain` function):
 *
 *   | MCP tool                             | agent-core function       |
 *   | ------------------------------------ | ------------------------- |
 *   | deploy_app_orchestrated              | deployApp                 |
 *   | manage_domain_orchestrated           | manageDomain (set/clear)  |
 *   | lookup_custom_domain_orchestrated    | manageDomain (lookup)     |
 *   | troubleshoot_deployment_orchestrated | troubleshootDeployment    |
 *   | close_lease_orchestrated             | closeLease                |
 *
 * The wrapper is **pure adapter** — no orchestration logic, no
 * re-rendering of the human-prose blocks that agent-core's
 * `internals/render-*.ts` modules produce. See PLAN.md §2 for the
 * callback → elicitation translation contract and §6.2 for the
 * `_meta.manifest` matrix (downstream-visible; the manifest-agent
 * plugin's PreToolUse hook reads `_meta.manifest.broadcasts`).
 */

import type {
  AgentCoreRuntime,
  CloseLeaseArgs,
  CloseLeaseOptions,
  DenomMap,
  DeployAppOptions,
  DeploySpec,
  LeaseStateName,
  ManageDomainArgs,
  ManageDomainOptions,
  TroubleshootArgs,
  TroubleshootOptions,
} from '@manifest-network/manifest-agent-core';
import {
  loadChainDenomMap,
  closeLease as realCloseLease,
  deployApp as realDeployApp,
  manageDomain as realManageDomain,
  troubleshootDeployment as realTroubleshoot,
} from '@manifest-network/manifest-agent-core';
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  manifestMeta,
  mutatingAnnotations,
  readOnlyAnnotations,
  structuredResponse,
  VERSION,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  makeCloseLeaseCallbacks,
  makeDeployCallbacks,
  makeLookupDomainCallbacks,
  makeManageDomainCallbacks,
  makeTroubleshootCallbacks,
} from './callbacks.js';
import { assertElicitationCapability } from './elicitation.js';
import { parseBooleanEnv } from './env.js';
import { buildRuntime } from './runtime.js';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

/**
 * Zod enum mirroring agent-core's `LeaseStateName` union — the value space of
 * `DeployResult.leaseState` and `CloseLeaseResult.finalState`. The trailing
 * `satisfies readonly LeaseStateName[]` fails the build if any literal here
 * drifts from the union. (If `LeaseStateName` gains a state, add it here too.)
 */
const leaseStateSchema = z.enum([
  'LEASE_STATE_UNSPECIFIED',
  'LEASE_STATE_PENDING',
  'LEASE_STATE_ACTIVE',
  'LEASE_STATE_INSUFFICIENT_FUNDS',
  'LEASE_STATE_CLOSED',
  'LEASE_STATE_REJECTED',
  'LEASE_STATE_EXPIRED',
] as const satisfies readonly LeaseStateName[]);

// ----------------------------------------------------------------------
// Dependency-injection seam for orchestrators (PLAN.md §1.1)
// ----------------------------------------------------------------------

/**
 * The four agent-core orchestration functions the wrapper invokes.
 * Each handler reads from `this.orchestrators[name]` rather than
 * importing directly, so tests can supply scripted fakes via
 * `new AgentMCPServer({ ..., orchestrators })`. Defaults to the real
 * `@manifest-network/manifest-agent-core` exports.
 *
 * Typed via `typeof realDeployApp` etc. — if agent-core evolves a
 * signature, the wrapper's seam type tracks it automatically and the
 * engineer gets a compile-time error at the next build.
 */
export interface AgentOrchestrators {
  deployApp: typeof realDeployApp;
  manageDomain: typeof realManageDomain;
  troubleshootDeployment: typeof realTroubleshoot;
  closeLease: typeof realCloseLease;
}

/**
 * Options for `AgentMCPServer`. Extends the standard
 * `ManifestMCPServerOptions` with an optional per-function override map
 * for tests. Production callers leave `orchestrators` undefined.
 */
export interface AgentMCPServerOptions extends ManifestMCPServerOptions {
  /**
   * Optional per-function overrides for the four agent-core
   * orchestration functions. Each provided key replaces the
   * corresponding `agent-core` function; missing keys fall back to the
   * real implementation. Intended for unit testing — production
   * callers leave this undefined.
   */
  readonly orchestrators?: Partial<AgentOrchestrators>;
}

// ----------------------------------------------------------------------
// Env-var helpers
// ----------------------------------------------------------------------

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ----------------------------------------------------------------------
// AgentMCPServer
// ----------------------------------------------------------------------

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export class AgentMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private orchestrators: AgentOrchestrators;
  // Env-derived per-call extras. Resolved once at construction; cached
  // promises lazy-initialise the actual values on first use so the
  // constructor stays synchronous.
  private chainDataFile: string | undefined;
  private dataDir: string | undefined;
  private fetchGuarded: boolean;
  private runtimePromise: Promise<AgentCoreRuntime> | null = null;
  private denomMapPromise: Promise<DenomMap> | null = null;

  constructor(options: AgentMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );

    this.orchestrators = {
      deployApp: options.orchestrators?.deployApp ?? realDeployApp,
      manageDomain: options.orchestrators?.manageDomain ?? realManageDomain,
      troubleshootDeployment:
        options.orchestrators?.troubleshootDeployment ?? realTroubleshoot,
      closeLease: options.orchestrators?.closeLease ?? realCloseLease,
    };

    this.chainDataFile = readEnv('MANIFEST_CHAIN_DATA_FILE');
    this.dataDir = readEnv('MANIFEST_AGENT_DATA_DIR');
    // Default ON — agent-core's documented invariant is that the SSRF
    // guard is on; opt-out requires an explicit MANIFEST_AGENT_FETCH_GUARDED=0
    // (or false/no/off). Mismatched values throw INVALID_CONFIG so a
    // typo doesn't silently disable the guard.
    this.fetchGuarded = parseBooleanEnv(
      process.env.MANIFEST_AGENT_FETCH_GUARDED,
      true,
      'MANIFEST_AGENT_FETCH_GUARDED',
    );

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-agent',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          // ENG-210: `logging: {}` is required for the SDK to emit our
          // `notifications/message` events to the host. Without it,
          // `assertNotificationCapability` throws and `safeNotify`
          // swallows every log emission — including the partial-success
          // warnings that callbacks.ts surfaces on recovery dismiss
          // (finding #1).
          logging: {},
        },
      },
    );

    this.registerTools();
  }

  // --- lazy resource accessors -------------------------------------

  private getRuntime(): Promise<AgentCoreRuntime> {
    if (this.runtimePromise === null) {
      const p = buildRuntime({
        clientManager: this.clientManager,
        fetchGuarded: this.fetchGuarded,
      });
      // Phase 2 (finding #12): clear the cache slot on rejection so a
      // transient failure (e.g. dynamic import of guarded-fetch hits a
      // ENETUNREACH) doesn't latch a rejected promise that all
      // subsequent tool calls re-throw forever. The identity guard
      // (`runtimePromise === p`) prevents a stale handler from a
      // previously-cleared-and-re-set slot racing in and clearing the
      // new promise.
      void p.catch(() => {
        if (this.runtimePromise === p) {
          this.runtimePromise = null;
        }
      });
      this.runtimePromise = p;
    }
    return this.runtimePromise;
  }

  private getDenomMap(): Promise<DenomMap> {
    if (this.denomMapPromise === null) {
      // `loadChainDenomMap` returns `EMPTY_DENOM_MAP` for
      // undefined / unreadable paths. `node:fs` is deferred to call
      // time by agent-core's own internal `await import('node:fs')`
      // inside `humanize-denom.ts` — no need for a wrapper-side
      // dynamic import here (the agent-core module is already in the
      // static graph via the orchestrator value imports above).
      const p = loadChainDenomMap(this.chainDataFile);
      // Phase 2 (finding #12): see getRuntime — same identity-guarded
      // cache-clear so transient failures don't poison the cache.
      void p.catch(() => {
        if (this.denomMapPromise === p) {
          this.denomMapPromise = null;
        }
      });
      this.denomMapPromise = p;
    }
    return this.denomMapPromise;
  }

  // --- per-call options builders -----------------------------------

  private async buildDeployOptions(): Promise<DeployAppOptions> {
    const [runtime, denomMap] = await Promise.all([
      this.getRuntime(),
      this.getDenomMap(),
    ]);
    // `dataDir` flows only from `MANIFEST_AGENT_DATA_DIR` (operator-set
    // at server-startup time). The per-call tool argument was removed in
    // Phase 2 (finding #4) because `saveManifest` chmods the supplied
    // path to 0o700 — an LLM-controllable arg there is a host-fs-damage
    // primitive.
    return {
      ...runtime,
      walletProvider: this.walletProvider,
      denomMap,
      ...(this.chainDataFile ? { chainDataFile: this.chainDataFile } : {}),
      ...(this.dataDir ? { dataDir: this.dataDir } : {}),
    };
  }

  private async buildChainOnlyOptions(): Promise<
    ManageDomainOptions & TroubleshootOptions & CloseLeaseOptions
  > {
    const [runtime, denomMap] = await Promise.all([
      this.getRuntime(),
      this.getDenomMap(),
    ]);
    return {
      ...runtime,
      denomMap,
      ...(this.chainDataFile ? { chainDataFile: this.chainDataFile } : {}),
    };
  }

  // --- tool registration -------------------------------------------

  private registerTools(): void {
    // ── deploy_app_orchestrated ──
    this.mcpServer.registerTool(
      'deploy_app_orchestrated',
      {
        description:
          'Orchestrate a deployment via @manifest-network/manifest-agent-core. ' +
          'Renders a plan, asks for confirmation via MCP elicitation, broadcasts ' +
          'the create-lease + manifest upload (+ optional set-domain) atomically ' +
          'through fred, and prompts for recovery on partial-success failures. ' +
          'Requires an elicitation-capable MCP host (Claude Code ≥ 2.1.76).',
        inputSchema: {
          spec: z
            .looseObject({
              // ENG-275: `size` is load-bearing (SKU resolution, fee
              // estimate, readiness, persisted manifest) but used to be an
              // undocumented escape-hatch field. Declare it as a typed,
              // discoverable optional property so a contract-following
              // caller can select a non-default SKU. `looseObject` still
              // passes the rest of the spec (image/services/etc.) through.
              size: z
                .string()
                .optional()
                .describe(
                  "Optional compute-tier / SKU name (e.g. 'small', 'medium'). " +
                    "Defaults to 'small' when omitted. Selects the on-chain SKU " +
                    'used for the lease item, fee estimate, and readiness check; ' +
                    "list available tiers via the lease server's get_skus. An " +
                    'unknown tier is rejected at the readiness check (before any ' +
                    'broadcast), which reports the available tier names.',
                ),
            })
            .describe(
              'DeploySpec — either SingleServiceSpec ({ image, port?, env?, customDomain?, size? }) ' +
                'or StackSpec ({ services: { [name]: ServiceDef }, customDomain?, serviceName?, size? }). ' +
                'agent-core validates structure; pass the typed shape from manifest-agent-core types.',
            ),
          // The `data_dir` per-call argument was removed in Phase 2
          // (finding #4). `saveManifest` chmods the supplied path to
          // 0o700; allowing the model / client to pick the path is a
          // host-fs-damage primitive. Operators set the persistence
          // location via the `MANIFEST_AGENT_DATA_DIR` env var only.
        },
        // Mirrors agent-core's DeployResult. structuredResponse drops
        // `undefined` over the JSON round-trip, so customDomain is optional.
        outputSchema: {
          leaseUuid: z.string(),
          providerUuid: z.string(),
          leaseState: leaseStateSchema,
          urls: z.array(z.string()),
          customDomain: z.string().optional(),
          manifestPath: z.string(),
        },
        // Each deploy creates a new lease — not idempotent, not destructive.
        annotations: mutatingAnnotations('Deploy app via orchestrated flow', {
          destructive: false,
          idempotent: false,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling(
        'deploy_app_orchestrated',
        async (args, extra: ToolExtra) => {
          assertElicitationCapability(this.mcpServer.server);
          const callbacks = makeDeployCallbacks({
            server: this.mcpServer.server,
            extra,
          });
          const opts = await this.buildDeployOptions();
          const result = await this.orchestrators.deployApp(
            args.spec as DeploySpec,
            callbacks,
            opts,
          );
          return structuredResponse(result, bigIntReplacer);
        },
      ),
    );

    // ── manage_domain_orchestrated ──
    this.mcpServer.registerTool(
      'manage_domain_orchestrated',
      {
        description:
          'Orchestrate a lease custom-domain set/clear operation via ' +
          '@manifest-network/manifest-agent-core. Broadcasts then verifies ' +
          'on-chain state. Confirmation is gathered via MCP elicitation. ' +
          '(For read-only reverse-lookup, use `lookup_custom_domain_orchestrated`.)',
        inputSchema: {
          action: z
            .enum(['set', 'clear'])
            .describe('Operation: set attaches an FQDN; clear releases it.'),
          lease_uuid: z
            .string()
            .optional()
            .describe('Lease UUID. Required for action=set / action=clear.'),
          fqdn: z
            .string()
            .optional()
            .describe(
              'FQDN to attach. Required for action=set. Ignored for action=clear.',
            ),
          service_name: z
            .string()
            .optional()
            .describe(
              'Stack-lease service name addressing the LeaseItem. Optional for ' +
                'set/clear on a 1-item legacy lease.',
            ),
        },
        // Mirrors agent-core's ManageDomainResult set/clear arms (identical
        // shape; lookup is the separate lookup_custom_domain_orchestrated tool).
        outputSchema: {
          action: z.enum(['set', 'clear']),
          leaseUuid: z.string(),
          verified: z.boolean(),
          finalCustomDomain: z.string().nullable(),
        },
        // Re-setting the same value is a no-op (idempotent in the converged
        // sense). Not destructive — clearing only removes the index entry.
        annotations: mutatingAnnotations(
          'Manage lease custom domain via orchestrated flow',
          { destructive: false, idempotent: true },
        ),
        _meta: manifestMeta({
          // set/clear always broadcast a `MsgSetItemCustomDomain` tx.
          // (Read-only lookup was split into
          // `lookup_custom_domain_orchestrated` per ENG-212, so this flag
          // is now unconditionally honest.)
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling(
        'manage_domain_orchestrated',
        async (args, extra: ToolExtra) => {
          assertElicitationCapability(this.mcpServer.server);
          const callbacks = makeManageDomainCallbacks({
            server: this.mcpServer.server,
            extra,
          });
          const opts = await this.buildChainOnlyOptions();
          const mdArgs = buildManageDomainArgs(args);
          const result = await this.orchestrators.manageDomain(
            mdArgs,
            callbacks,
            opts,
          );
          return structuredResponse(result, bigIntReplacer);
        },
      ),
    );

    // ── lookup_custom_domain_orchestrated ──
    this.mcpServer.registerTool(
      'lookup_custom_domain_orchestrated',
      {
        description:
          'Reverse-resolve a custom-domain FQDN to its owning lease via ' +
          '@manifest-network/manifest-agent-core (pure chain query — no broadcast, ' +
          'zero elicitations; runs on hosts without MCP elicitation capability). ' +
          'Returns the lease that has claimed the FQDN, or null when unclaimed.',
        inputSchema: {
          fqdn: z
            .string()
            .describe('FQDN to reverse-resolve (e.g. "app.example.com").'),
        },
        // Mirrors agent-core's ManageDomainResult lookup arm.
        outputSchema: {
          action: z.literal('lookup'),
          fqdn: z.string(),
          lease: z.object({ leaseUuid: z.string() }).nullable(),
        },
        annotations: readOnlyAnnotations(
          'Look up lease by custom domain (orchestrated)',
        ),
        _meta: manifestMeta({ broadcasts: false, estimable: false }),
      },
      withErrorHandling(
        'lookup_custom_domain_orchestrated',
        async (args, extra: ToolExtra) => {
          // Guard at the wrapper so an empty/whitespace fqdn surfaces under
          // the MCP tool name, not agent-core's internal `manageDomain`.
          // agent-core trims internally, so only the non-empty check
          // belongs here.
          if (typeof args.fqdn !== 'string' || args.fqdn.trim() === '') {
            throw new ManifestMCPError(
              ManifestMCPErrorCode.INVALID_CONFIG,
              'lookup_custom_domain_orchestrated: fqdn must be a non-empty string.',
            );
          }
          // Pure chain query — no onConfirm, so skip the elicitation guard
          // (mirrors troubleshoot_deployment_orchestrated).
          const callbacks = makeLookupDomainCallbacks({
            server: this.mcpServer.server,
            extra,
          });
          const opts = await this.buildChainOnlyOptions();
          const mdArgs: ManageDomainArgs = {
            action: 'lookup',
            fqdn: args.fqdn,
          };
          const result = await this.orchestrators.manageDomain(
            mdArgs,
            callbacks,
            opts,
          );
          return structuredResponse(result, bigIntReplacer);
        },
      ),
    );

    // ── troubleshoot_deployment_orchestrated ──
    this.mcpServer.registerTool(
      'troubleshoot_deployment_orchestrated',
      {
        description:
          'Produce a markdown-formatted chain-side diagnostic report for a lease ' +
          'via @manifest-network/manifest-agent-core. Pure chain query — no ' +
          'broadcast and zero elicitations (read-only path; runs on hosts without ' +
          'MCP elicitation capability). Report returned as structured content.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('Lease UUID to diagnose.'),
        },
        // Mirrors agent-core's TroubleshootReport (a markdown blob).
        outputSchema: {
          markdown: z.string(),
        },
        annotations: readOnlyAnnotations(
          'Diagnose lease via orchestrated flow',
        ),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling(
        'troubleshoot_deployment_orchestrated',
        async (args, extra: ToolExtra) => {
          // Phase 2 (findings #10 + #11): troubleshoot is purely
          // read-only — agent-core never invokes `onConfirm` and the
          // wrapper supplies no other elicitation callback. Skip the
          // capability guard so headless / auto-approve hosts can use
          // the diagnostic report.
          const callbacks = makeTroubleshootCallbacks({
            server: this.mcpServer.server,
            extra,
          });
          const opts = await this.buildChainOnlyOptions();
          const tArgs: TroubleshootArgs = { leaseUuid: args.lease_uuid };
          const result = await this.orchestrators.troubleshootDeployment(
            tArgs,
            callbacks,
            opts,
          );
          return structuredResponse(result, bigIntReplacer);
        },
      ),
    );

    // ── close_lease_orchestrated ──
    this.mcpServer.registerTool(
      'close_lease_orchestrated',
      {
        description:
          'Orchestrate closing a lease via @manifest-network/manifest-agent-core. ' +
          'Asks for confirmation via MCP elicitation, broadcasts the close-lease ' +
          'tx, then verifies the lease reached a terminal state on-chain. ' +
          'Permanent — the lease cannot be reopened.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('Lease UUID to close.'),
        },
        // Mirrors agent-core's CloseLeaseResult.
        outputSchema: {
          leaseUuid: z.string(),
          finalState: leaseStateSchema,
        },
        // Closing is permanent (destructive); closing a closed lease converges
        // to the same terminal state (idempotent in the convergence sense).
        annotations: mutatingAnnotations('Close lease via orchestrated flow', {
          destructive: true,
          idempotent: true,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling(
        'close_lease_orchestrated',
        async (args, extra: ToolExtra) => {
          assertElicitationCapability(this.mcpServer.server);
          const callbacks = makeCloseLeaseCallbacks({
            server: this.mcpServer.server,
            extra,
          });
          const opts = await this.buildChainOnlyOptions();
          const cArgs: CloseLeaseArgs = { leaseUuid: args.lease_uuid };
          const result = await this.orchestrators.closeLease(
            cArgs,
            callbacks,
            opts,
          );
          return structuredResponse(result, bigIntReplacer);
        },
      ),
    );
  }

  // --- accessors --------------------------------------------------

  getServer(): Server {
    return this.mcpServer.server;
  }

  getClientManager(): CosmosClientManager {
    return this.clientManager;
  }

  disconnect(): void {
    this.clientManager.disconnect();
  }
}

// ----------------------------------------------------------------------
// ManageDomainArgs assembly
// ----------------------------------------------------------------------

interface ManageDomainToolArgs {
  action: 'set' | 'clear';
  lease_uuid?: string;
  fqdn?: string;
  service_name?: string;
}

function buildManageDomainArgs(args: ManageDomainToolArgs): ManageDomainArgs {
  switch (args.action) {
    case 'set':
      if (!args.lease_uuid || !args.fqdn) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'manage_domain_orchestrated: action=set requires both lease_uuid and fqdn.',
        );
      }
      return {
        action: 'set',
        leaseUuid: args.lease_uuid,
        fqdn: args.fqdn,
        ...(args.service_name ? { serviceName: args.service_name } : {}),
      };
    case 'clear':
      if (!args.lease_uuid) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'manage_domain_orchestrated: action=clear requires lease_uuid.',
        );
      }
      return {
        action: 'clear',
        leaseUuid: args.lease_uuid,
        ...(args.service_name ? { serviceName: args.service_name } : {}),
      };
  }
}

// ----------------------------------------------------------------------
// Mnemonic-wallet shorthand (production-only path; no DI overrides)
// ----------------------------------------------------------------------

/**
 * Build an `AgentMCPServer` with a mnemonic-backed wallet. Mirrors
 * `createMnemonicLeaseServer` / `createMnemonicChainServer`. Does NOT
 * accept the `orchestrators` DI overrides — production-only path.
 */
export function createMnemonicAgentServer(
  config: MnemonicServerConfig,
): Promise<AgentMCPServer> {
  return createMnemonicServer(config, AgentMCPServer);
}
