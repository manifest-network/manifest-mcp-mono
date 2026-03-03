import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
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
import { requireString, requireStringEnum, parseArgs, optionalBoolean } from './validation.js';
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
export { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
export { resolveLeaseProvider, type LeaseProviderInfo } from './tools/resolveLeaseProvider.js';
export { type LeaseStateFilter, type LeaseInfo } from './tools/listApps.js';
export { type DeployAppResult, type DeployAppInput } from './tools/deployApp.js';
export { type StopAppResult } from './tools/stopApp.js';
export { requireString, requireStringEnum, parseArgs, optionalBoolean } from './validation.js';

/** Maximum number of log lines that can be requested via get_logs */
const MAX_LOG_TAIL = 1000;

/**
 * All tools exposed by the MCP server
 */
const TOOLS: Tool[] = [
  {
    name: 'get_account_info',
    description: 'Get account address and key name for the configured key',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cosmos_query',
    description:
      'Execute any Cosmos SDK query command. Use list_modules and list_module_subcommands to discover available options.',
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description:
            'The module name (e.g., "bank", "staking", "distribution", "gov", "auth")',
        },
        subcommand: {
          type: 'string',
          description:
            'The subcommand (e.g., "balance", "balances", "delegations", "rewards", "proposals")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional arguments as an array of strings (e.g., ["<address>", "umfx"] for bank balance). Use array to preserve arguments with spaces.',
        },
      },
      required: ['module', 'subcommand'],
    },
  },
  {
    name: 'cosmos_tx',
    description:
      'Execute any Cosmos SDK transaction. Automatically signs with the configured key and estimates gas. Use list_modules and list_module_subcommands to discover available options.',
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'The module name (e.g., "bank", "staking", "gov")',
        },
        subcommand: {
          type: 'string',
          description: 'The subcommand (e.g., "send", "delegate", "unbond", "vote")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Arguments to the transaction as an array of strings (e.g., ["<to_address>", "1000umfx"] for bank send). Use array to preserve arguments with spaces.',
        },
        wait_for_confirmation: {
          type: 'boolean',
          description:
            'If true, wait for the transaction to be included in a block before returning. Defaults to false (broadcast only).',
        },
      },
      required: ['module', 'subcommand', 'args'],
    },
  },
  {
    name: 'list_modules',
    description:
      'List all available query and transaction modules supported by the chain',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_module_subcommands',
    description:
      'List all available subcommands for a specific module (query or tx)',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['query', 'tx'],
          description: 'Whether to list query or transaction subcommands',
        },
        module: {
          type: 'string',
          description: 'The module name (e.g., "bank", "staking")',
        },
      },
      required: ['type', 'module'],
    },
  },
  {
    name: 'browse_catalog',
    description:
      'Browse available cloud providers and service tiers. Returns active providers with health status and available SKU pricing.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_balance',
    description:
      'Get account balances, credit status, and spending estimates. Returns on-chain balances, credit account info, and estimated time until credit exhaustion.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'fund_credits',
    description:
      'Fund the credit account for deploying apps. Sends tokens to the billing credit account.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'string',
          description: 'Amount with denomination (e.g. "10000000umfx")',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'list_apps',
    description:
      'List all leases for the current account. Returns leases with their state, provider UUID, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['all', 'pending', 'active', 'closed', 'rejected', 'expired'],
          description: 'Filter leases by state (default: "all")',
        },
      },
      required: [],
    },
  },
  {
    name: 'app_status',
    description:
      'Get detailed status for a deployed app by lease UUID. Returns chain state, provider status, and connection info.',
    inputSchema: {
      type: 'object',
      properties: {
        lease_uuid: {
          type: 'string',
          description: 'The lease UUID of the app to check',
        },
      },
      required: ['lease_uuid'],
    },
  },
  {
    name: 'get_logs',
    description:
      'Get logs for a deployed app by lease UUID. Returns recent logs from all services, truncated to fit LLM context.',
    inputSchema: {
      type: 'object',
      properties: {
        lease_uuid: {
          type: 'string',
          description: 'The lease UUID of the app to get logs for',
        },
        tail: {
          type: 'number',
          description: 'Number of recent log lines to retrieve',
        },
      },
      required: ['lease_uuid'],
    },
  },
  {
    name: 'deploy_app',
    description:
      'Deploy a new application. Creates a lease, uploads the manifest to the provider, and polls until the app is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Docker image to deploy (e.g. "nginx:alpine")',
        },
        port: {
          type: 'number',
          description: 'Container port to expose (e.g. 80)',
        },
        size: {
          type: 'string',
          description: 'SKU tier name (e.g. "docker-micro", "docker-small")',
        },
        env: {
          type: 'object',
          description: 'Optional environment variables as key-value pairs',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['image', 'port', 'size'],
    },
  },
  {
    name: 'stop_app',
    description:
      'Stop a deployed app by closing its lease on-chain.',
    inputSchema: {
      type: 'object',
      properties: {
        lease_uuid: {
          type: 'string',
          description: 'The lease UUID of the app to stop',
        },
      },
      required: ['lease_uuid'],
    },
  },
  {
    name: 'restart_app',
    description:
      'Restart a deployed app via the provider.',
    inputSchema: {
      type: 'object',
      properties: {
        lease_uuid: {
          type: 'string',
          description: 'The lease UUID of the app to restart',
        },
      },
      required: ['lease_uuid'],
    },
  },
  {
    name: 'update_app',
    description:
      'Update a deployed app with a new manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        lease_uuid: {
          type: 'string',
          description: 'The lease UUID of the app to update',
        },
        manifest: {
          type: 'string',
          description: 'The full manifest JSON string to deploy',
        },
      },
      required: ['lease_uuid', 'manifest'],
    },
  },
];

/**
 * Options for creating a ManifestMCPServer
 */
export interface ManifestMCPServerOptions {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
}

/**
 * Transport-agnostic ManifestMCPServer class
 */
export class ManifestMCPServer {
  private server: Server;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private config: ManifestMCPConfig;

  constructor(options: ManifestMCPServerOptions) {
    this.config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(this.config, this.walletProvider);

    this.server = new Server(
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

    this.setupHandlers();
  }

  /**
   * Set up the MCP request handlers
   */
  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolInput = request.params.arguments || {};

      try {
        return await this.handleToolCall(toolName, toolInput);
      } catch (error) {
        // Build detailed error response with sanitized inputs
        let errorResponse: Record<string, unknown> = {
          error: true,
          tool: toolName,
          input: sanitizeForLogging(toolInput),
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
              type: 'text',
              text: JSON.stringify(errorResponse, bigIntReplacer, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle a tool call
   */
  private async handleToolCall(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    switch (toolName) {
      case 'get_account_info': {
        const address = await this.walletProvider.getAddress();
        const accountInfo: AccountInfo = {
          address,
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(accountInfo, null, 2),
            },
          ],
        };
      }

      case 'cosmos_query': {
        const module = requireString(toolInput, 'module');
        const subcommand = requireString(toolInput, 'subcommand');
        const args = parseArgs(toolInput.args);

        const result = await cosmosQuery(this.clientManager, module, subcommand, args);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'cosmos_tx': {
        const module = requireString(toolInput, 'module', ManifestMCPErrorCode.TX_FAILED);
        const subcommand = requireString(toolInput, 'subcommand', ManifestMCPErrorCode.TX_FAILED);
        const args = parseArgs(toolInput.args);
        const waitForConfirmation = optionalBoolean(toolInput, 'wait_for_confirmation');

        const result = await cosmosTx(
          this.clientManager,
          module,
          subcommand,
          args,
          waitForConfirmation
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'list_modules': {
        const modules = getAvailableModules();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(modules, null, 2),
            },
          ],
        };
      }

      case 'list_module_subcommands': {
        const type = requireStringEnum(toolInput, 'type', ['query', 'tx'] as const);
        const module = requireString(toolInput, 'module');

        const subcommands = getModuleSubcommands(type, module);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  type,
                  module,
                  subcommands,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'browse_catalog': {
        const queryClient = await this.clientManager.getQueryClient();
        const result = await browseCatalog(queryClient);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'get_balance': {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getBalance(queryClient, address);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'fund_credits': {
        const amount = requireString(toolInput, 'amount');
        const result = await fundCredits(this.clientManager, amount);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'list_apps': {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const VALID_STATE_FILTERS = ['all', 'pending', 'active', 'closed', 'rejected', 'expired'] as const;
        const stateFilter: LeaseStateFilter = typeof toolInput.state === 'string'
          ? requireStringEnum(toolInput, 'state', VALID_STATE_FILTERS)
          : 'all';
        const result = await listApps(queryClient, address, stateFilter);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'app_status': {
        const leaseUuid = requireString(toolInput, 'lease_uuid');
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await appStatus(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'get_logs': {
        const leaseUuid = requireString(toolInput, 'lease_uuid');
        const rawTail = toolInput.tail;
        const tail = typeof rawTail === 'number' && Number.isFinite(rawTail) && rawTail > 0
          ? Math.min(Math.floor(rawTail), MAX_LOG_TAIL)
          : undefined;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getAppLogs(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          tail,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'deploy_app': {
        const image = requireString(toolInput, 'image');
        const port = toolInput.port;
        if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            'port must be a positive number',
          );
        }
        const size = requireString(toolInput, 'size');
        const env = toolInput.env as Record<string, string> | undefined;

        const result = await deployApp(
          this.clientManager,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          (addr, uuid, metaHashHex) => this.getLeaseDataAuthToken(addr, uuid, metaHashHex),
          { image, port, size, env },
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'stop_app': {
        const leaseUuid = requireString(toolInput, 'lease_uuid');
        const result = await stopApp(this.clientManager, leaseUuid);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'restart_app': {
        const leaseUuid = requireString(toolInput, 'lease_uuid');
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await restartApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      case 'update_app': {
        const leaseUuid = requireString(toolInput, 'lease_uuid');
        const manifest = requireString(toolInput, 'manifest');

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

        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();

        const result = await updateApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          manifest,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, bigIntReplacer, 2),
            },
          ],
        };
      }

      default:
        throw new ManifestMCPError(
          ManifestMCPErrorCode.UNKNOWN_ERROR,
          `Unknown tool: ${toolName}`
        );
    }
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
   * Get the advertised tool list (for testing / introspection)
   */
  getTools(): Tool[] {
    return TOOLS;
  }

  /**
   * Get the underlying MCP server instance
   */
  getServer(): Server {
    return this.server;
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
