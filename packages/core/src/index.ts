import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CosmosClientManager } from './client.js';
import { cosmosQuery, cosmosTx } from './cosmos.js';
import { getAvailableModules, getModuleSubcommands } from './modules.js';
import {
  ManifestMCPConfig,
  WalletProvider,
  AccountInfo,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from './types.js';
import { createValidatedConfig } from './config.js';
import { VERSION } from './version.js';
import { createSignMessage, createLeaseDataSignMessage, createAuthToken } from './http/auth.js';
import type { LeaseStateFilter } from './tools/listApps.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { getBalance } from './tools/getBalance.js';
import { listApps } from './tools/listApps.js';
import { appStatus } from './tools/appStatus.js';
import { getAppLogs } from './tools/getLogs.js';
import { fundCredits } from './tools/fundCredits.js';
import { deployApp } from './tools/deployApp.js';
import { stopApp } from './tools/stopApp.js';
import { restartApp } from './tools/restartApp.js';
import { updateApp } from './tools/updateApp.js';

/**
 * Sensitive field names that should be redacted from error responses
 */
const SENSITIVE_FIELDS = new Set([
  'mnemonic',
  'privatekey',
  'private_key',
  'secret',
  'password',
  'seed',
  'key',
  'token',
  'apikey',
  'api_key',
]);

/**
 * JSON replacer that converts BigInt values to strings
 */
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Recursively sanitize an object by redacting sensitive fields
 */
function sanitizeForLogging(obj: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 10) {
    return '[max depth exceeded]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Redact strings that look like mnemonics (12 or 24 words)
    const wordCount = obj.trim().split(/\s+/).length;
    if (wordCount === 12 || wordCount === 24) {
      return '[REDACTED - possible mnemonic]';
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.has(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value, depth + 1);
      }
    }
    return sanitized;
  }

  return obj;
}

// Re-export types and utilities
export * from './types.js';
export { createConfig, createValidatedConfig, validateConfig, DEFAULT_RETRY_CONFIG, type ValidationResult } from './config.js';
export { CosmosClientManager } from './client.js';
export { cosmosQuery, cosmosTx } from './cosmos.js';
export { getAvailableModules, getModuleSubcommands, getSubcommandUsage, getSupportedModules, isSubcommandSupported } from './modules.js';
export { MnemonicWalletProvider } from './wallet/index.js';
export { withRetry, isRetryableError, calculateBackoff, type RetryOptions } from './retry.js';
export { ProviderApiError } from './http/provider.js';
export { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
export { resolveLeaseProvider, resolveProviderUrl, type LeaseProviderInfo } from './tools/resolveLeaseProvider.js';
export { type LeaseStateFilter, type LeaseInfo } from './tools/listApps.js';
export { type DeployAppResult, type DeployAppInput } from './tools/deployApp.js';
export { type StopAppResult } from './tools/stopApp.js';
export { requireString, requireStringEnum, requireUuid, parseArgs, optionalBoolean } from './validation.js';

/** Maximum number of log lines that can be requested via get_logs */
const MAX_LOG_TAIL = 1000;

/** Valid lease state filter values */
const VALID_STATE_FILTERS = ['all', 'pending', 'active', 'closed', 'rejected', 'expired'] as const;

/**
 * Options for creating a ManifestMCPServer
 */
export interface ManifestMCPServerOptions {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
}

/**
 * Wrap a tool handler with error handling that preserves the existing error format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- args are validated by McpServer before reaching the handler
function withErrorHandling(
  toolName: string,
  fn: (...fnArgs: any[]) => Promise<CallToolResult>,
): (...cbArgs: any[]) => Promise<CallToolResult> {
  // For tools with no inputSchema, McpServer calls cb(extra) with one arg.
  // For tools with inputSchema, McpServer calls cb(parsedArgs, extra).
  // fn.length tells us whether the handler expects args (length >= 1) or not (length 0).
  const hasArgs = fn.length >= 1;

  return async (...cbArgs: any[]) => {
    const args = hasArgs ? (cbArgs[0] ?? {}) : {};
    try {
      return hasArgs ? await fn(args, cbArgs[1]) : await fn(cbArgs[0]);
    } catch (error) {
      let errorResponse: Record<string, unknown> = {
        error: true,
        tool: toolName,
        input: sanitizeForLogging(args),
      };

      if (error instanceof ManifestMCPError) {
        errorResponse = {
          ...errorResponse,
          code: error.code,
          message: error.message,
          details: sanitizeForLogging(error.details),
        };
      } else {
        errorResponse = {
          ...errorResponse,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(errorResponse, bigIntReplacer, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Helper to build a successful JSON text response
 */
function jsonResponse(data: unknown, replacer: ((key: string, value: unknown) => unknown) | null = null): CallToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, replacer as Parameters<typeof JSON.stringify>[1], 2),
      },
    ],
  };
}

/**
 * Transport-agnostic ManifestMCPServer class
 */
export class ManifestMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private config: ManifestMCPConfig;

  constructor(options: ManifestMCPServerOptions) {
    this.config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(this.config, this.walletProvider);

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-core',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerTools();
  }

  /**
   * Register all MCP tools with Zod schemas and directive descriptions
   */
  private registerTools(): void {
    // ── get_account_info ──
    this.mcpServer.registerTool(
      'get_account_info',
      {
        description: 'Get the wallet address for the configured key. Use this to check which account is active.',
      },
      withErrorHandling('get_account_info', async () => {
        const address = await this.walletProvider.getAddress();
        const accountInfo: AccountInfo = { address };
        return jsonResponse(accountInfo);
      }),
    );

    // ── cosmos_query ──
    this.mcpServer.registerTool(
      'cosmos_query',
      {
        description: 'Execute any Cosmos SDK query command. Use this for chain queries not covered by the high-level tools (get_balance, list_apps, etc.). Call list_modules and list_module_subcommands first to discover available options.',
        inputSchema: {
          module: z.string().describe('The module name (e.g., "bank", "staking", "distribution", "gov", "auth")'),
          subcommand: z.string().describe('The subcommand (e.g., "balance", "balances", "delegations", "rewards", "proposals")'),
          args: z.array(z.string()).optional().describe('Additional arguments as an array of strings (e.g., ["<address>", "umfx"] for bank balance). Use array to preserve arguments with spaces.'),
        },
      },
      withErrorHandling('cosmos_query', async (args) => {
        const result = await cosmosQuery(
          this.clientManager,
          args.module as string,
          args.subcommand as string,
          (args.args as string[] | undefined) ?? [],
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── cosmos_tx ──
    this.mcpServer.registerTool(
      'cosmos_tx',
      {
        description: 'Execute any Cosmos SDK transaction with automatic signing and gas estimation. Use this for chain transactions not covered by the high-level tools (fund_credits, deploy_app, stop_app, etc.). Call list_modules and list_module_subcommands first to discover available options.',
        inputSchema: {
          module: z.string().describe('The module name (e.g., "bank", "staking", "gov")'),
          subcommand: z.string().describe('The subcommand (e.g., "send", "delegate", "unbond", "vote")'),
          args: z.array(z.string()).describe('Arguments to the transaction as an array of strings (e.g., ["<to_address>", "1000umfx"] for bank send). Use array to preserve arguments with spaces.'),
          wait_for_confirmation: z.boolean().optional().describe('If true, wait for the transaction to be included in a block before returning. Defaults to false (broadcast only).'),
        },
      },
      withErrorHandling('cosmos_tx', async (args) => {
        const result = await cosmosTx(
          this.clientManager,
          args.module as string,
          args.subcommand as string,
          args.args as string[],
          (args.wait_for_confirmation as boolean | undefined) ?? false,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── list_modules ──
    this.mcpServer.registerTool(
      'list_modules',
      {
        description: 'List all available query and transaction modules. Call this before using cosmos_query or cosmos_tx to discover what modules are available.',
      },
      withErrorHandling('list_modules', async () => {
        const modules = getAvailableModules();
        return jsonResponse(modules);
      }),
    );

    // ── list_module_subcommands ──
    this.mcpServer.registerTool(
      'list_module_subcommands',
      {
        description: 'List available subcommands for a specific module. Call this after list_modules to discover the exact subcommand names and required arguments before calling cosmos_query or cosmos_tx.',
        inputSchema: {
          type: z.enum(['query', 'tx']).describe('Whether to list query or transaction subcommands'),
          module: z.string().describe('The module name (e.g., "bank", "staking")'),
        },
      },
      withErrorHandling('list_module_subcommands', async (args) => {
        const type = args.type as 'query' | 'tx';
        const module = args.module as string;
        const subcommands = getModuleSubcommands(type, module);
        return jsonResponse({ type, module, subcommands });
      }),
    );

    // ── browse_catalog ──
    this.mcpServer.registerTool(
      'browse_catalog',
      {
        description: 'Browse available cloud providers and service tiers. Use this before deploy_app to see which providers are online and what SKU sizes (e.g. docker-micro, docker-small) are available with pricing.',
      },
      withErrorHandling('browse_catalog', async () => {
        const queryClient = await this.clientManager.getQueryClient();
        const result = await browseCatalog(queryClient);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── get_balance ──
    this.mcpServer.registerTool(
      'get_balance',
      {
        description: 'Get account balances, credit status, and spending estimates. Use this to check if you have enough credits before deploying, or to monitor remaining credit lifetime.',
      },
      withErrorHandling('get_balance', async () => {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getBalance(queryClient, address);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── fund_credits ──
    this.mcpServer.registerTool(
      'fund_credits',
      {
        description: 'Fund the billing credit account by sending tokens from the wallet. Use this when get_balance shows insufficient credits for deploying apps.',
        inputSchema: {
          amount: z.string().describe('Amount with denomination (e.g. "10000000umfx")'),
        },
      },
      withErrorHandling('fund_credits', async (args) => {
        const result = await fundCredits(this.clientManager, args.amount as string);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── list_apps ──
    this.mcpServer.registerTool(
      'list_apps',
      {
        description: 'List all leases (deployed apps) for the current account. Use this to find lease UUIDs needed by app_status, get_logs, stop_app, restart_app, and update_app.',
        inputSchema: {
          state: z.enum(VALID_STATE_FILTERS).optional().describe('Filter leases by state (default: "all")'),
        },
      },
      withErrorHandling('list_apps', async (args) => {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const stateFilter: LeaseStateFilter = (args.state as LeaseStateFilter | undefined) ?? 'all';
        const result = await listApps(queryClient, address, stateFilter);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── app_status ──
    this.mcpServer.registerTool(
      'app_status',
      {
        description: 'Get detailed status and connection info for a deployed app. Use this after deploy_app or list_apps to check if an app is running and get its URL.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to check'),
        },
      },
      withErrorHandling('app_status', async (args) => {
        const leaseUuid = args.lease_uuid as string;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await appStatus(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── get_logs ──
    this.mcpServer.registerTool(
      'get_logs',
      {
        description: 'Get recent container logs for a deployed app. Use this to debug apps that are failing or to verify an app started correctly after deploy_app.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to get logs for'),
          tail: z.number().int().min(1).max(MAX_LOG_TAIL).optional().describe('Number of recent log lines to retrieve'),
        },
      },
      withErrorHandling('get_logs', async (args) => {
        const leaseUuid = args.lease_uuid as string;
        const tail = args.tail as number | undefined;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getAppLogs(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          tail,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── deploy_app ──
    this.mcpServer.registerTool(
      'deploy_app',
      {
        description: 'Deploy a new containerized application. Requires funded credits (use fund_credits if needed). Creates a lease on-chain, uploads the container manifest to a provider, and polls until ready. Use browse_catalog first to see available SKU sizes.',
        inputSchema: {
          image: z.string().describe('Docker image to deploy (e.g. "nginx:alpine")'),
          port: z.number().int().min(1).max(65535).describe('Container port to expose (e.g. 80)'),
          size: z.string().describe('SKU tier name (e.g. "docker-micro", "docker-small")'),
          env: z.record(z.string(), z.string()).optional().describe('Optional environment variables as key-value pairs'),
        },
      },
      withErrorHandling('deploy_app', async (args) => {
        const result = await deployApp(
          this.clientManager,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          (addr, uuid, metaHashHex) => this.getLeaseDataAuthToken(addr, uuid, metaHashHex),
          {
            image: args.image as string,
            port: args.port as number,
            size: args.size as string,
            env: args.env as Record<string, string> | undefined,
          },
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── stop_app ──
    this.mcpServer.registerTool(
      'stop_app',
      {
        description: 'Stop a deployed app by closing its lease on-chain. This is permanent — the app cannot be restarted after stopping. Use restart_app instead if you just want to restart it.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to stop'),
        },
      },
      withErrorHandling('stop_app', async (args) => {
        const result = await stopApp(this.clientManager, args.lease_uuid as string);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── restart_app ──
    this.mcpServer.registerTool(
      'restart_app',
      {
        description: 'Restart a running app via the provider without closing its lease. Use this to apply configuration changes or recover from a crash.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to restart'),
        },
      },
      withErrorHandling('restart_app', async (args) => {
        const leaseUuid = args.lease_uuid as string;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await restartApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── update_app ──
    this.mcpServer.registerTool(
      'update_app',
      {
        description: 'Update a deployed app with a new container manifest. Use this to change the Docker image, ports, or environment variables of a running app without closing the lease.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to update'),
          manifest: z.string().describe('The full manifest JSON string to deploy'),
        },
      },
      withErrorHandling('update_app', async (args) => {
        const manifest = args.manifest as string;

        try {
          const parsed = JSON.parse(manifest);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('must be a JSON object');
          }
        } catch (err) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const leaseUuid = args.lease_uuid as string;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();

        const result = await updateApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          manifest,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );
  }

  private async getProviderAuthToken(address: string, leaseUuid: string): Promise<string> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication.'
      );
    }
    const timestamp = new Date().toISOString();
    const message = createSignMessage(address, leaseUuid, timestamp);
    const { pub_key, signature } = await this.walletProvider.signArbitrary(address, message);
    return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature);
  }

  private async getLeaseDataAuthToken(address: string, leaseUuid: string, metaHashHex: string): Promise<string> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication.'
      );
    }
    const timestamp = new Date().toISOString();
    const message = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);
    const { pub_key, signature } = await this.walletProvider.signArbitrary(address, message);
    return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature, metaHashHex);
  }

  /**
   * Get the underlying MCP server instance
   */
  getServer(): Server {
    return this.mcpServer.server;
  }

  /**
   * Get the client manager
   */
  getClientManager(): CosmosClientManager {
    return this.clientManager;
  }

  /**
   * Disconnect and clean up resources
   */
  disconnect(): void {
    this.clientManager.disconnect();
  }
}

/**
 * Create a ManifestMCPServer with mnemonic wallet (for testing or non-interactive use)
 *
 * @example
 * ```typescript
 * import { createMnemonicServer } from '@manifest-network/manifest-mcp-core';
 *
 * const server = await createMnemonicServer({
 *   chainId: 'manifest-ledger-testnet',
 *   rpcUrl: 'https://nodes.chandrastation.com/rpc/manifest/',
 *   gasPrice: '1.0umfx',
 *   mnemonic: 'your twelve word mnemonic phrase here...',
 * });
 * ```
 */
export async function createMnemonicServer(config: {
  chainId: string;
  rpcUrl: string;
  gasPrice: string;
  addressPrefix?: string;
  mnemonic: string;
}): Promise<ManifestMCPServer> {
  const { MnemonicWalletProvider } = await import('./wallet/mnemonic.js');

  const { mnemonic, ...mcpConfig } = config;
  const walletProvider = new MnemonicWalletProvider(mcpConfig, mnemonic);
  await walletProvider.connect();

  return new ManifestMCPServer({
    config: mcpConfig,
    walletProvider,
  });
}
