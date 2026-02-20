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
import type { AppRegistry } from './registry.js';
import { createSignMessage, createAuthToken } from './http/auth.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { getBalance } from './tools/getBalance.js';
import { listApps } from './tools/listApps.js';
import { appStatus } from './tools/appStatus.js';
import { getAppLogs } from './tools/getLogs.js';

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
 * Parse raw args input into string array.
 */
function parseArgs(rawArgs: unknown): string[] {
  if (Array.isArray(rawArgs)) {
    return rawArgs.map(String);
  }
  return [];
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
export type { AppEntry, AppRegistry } from './registry.js';
export { InMemoryAppRegistry } from './registry.js';
export { ProviderApiError } from './http/provider.js';

/**
 * Tool definitions for the MCP server
 */
const tools: Tool[] = [
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
    name: 'list_apps',
    description:
      'List all deployed apps for the current account. Returns apps with their status, lease UUID, and metadata. Reconciles chain state with local registry.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'app_status',
    description:
      'Get detailed status for a deployed app by name. Returns chain state, provider status, and connection info.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the app to check',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_logs',
    description:
      'Get logs for a deployed app by name. Returns recent logs from all services, truncated to fit LLM context.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the app to get logs for',
        },
        tail: {
          type: 'number',
          description: 'Number of recent log lines to retrieve',
        },
      },
      required: ['name'],
    },
  },
];

/**
 * Options for creating a ManifestMCPServer
 */
export interface ManifestMCPServerOptions {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
  appRegistry?: AppRegistry;
}

/**
 * Transport-agnostic ManifestMCPServer class
 */
export class ManifestMCPServer {
  private server: Server;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private appRegistry: AppRegistry | undefined;
  private config: ManifestMCPConfig;

  constructor(options: ManifestMCPServerOptions) {
    this.config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.appRegistry = options.appRegistry;
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
      tools,
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
        const module = toolInput.module as string;
        const subcommand = toolInput.subcommand as string;
        const args = parseArgs(toolInput.args);

        if (!module || !subcommand) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'module and subcommand are required'
          );
        }

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
        const module = toolInput.module as string;
        const subcommand = toolInput.subcommand as string;
        const args = parseArgs(toolInput.args);
        const waitForConfirmation = (toolInput.wait_for_confirmation as boolean) || false;

        if (!module || !subcommand) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            'module and subcommand are required'
          );
        }

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
        const type = toolInput.type as string;
        const module = toolInput.module as string;

        if (!type || !module) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'type and module are required'
          );
        }

        if (type !== 'query' && type !== 'tx') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'type must be either "query" or "tx"'
          );
        }

        const subcommands = getModuleSubcommands(type as 'query' | 'tx', module);
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

      case 'list_apps': {
        if (!this.appRegistry) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.MISSING_CONFIG,
            'App registry is not configured. Pass appRegistry in ManifestMCPServerOptions.'
          );
        }
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await listApps(queryClient, address, this.appRegistry);
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
        if (!this.appRegistry) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.MISSING_CONFIG,
            'App registry is not configured. Pass appRegistry in ManifestMCPServerOptions.'
          );
        }
        const name = toolInput.name as string;
        if (!name) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'name is required'
          );
        }
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await appStatus(
          queryClient,
          address,
          name,
          this.appRegistry,
          (addr, leaseUuid) => this.getProviderAuthToken(addr, leaseUuid),
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
        if (!this.appRegistry) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.MISSING_CONFIG,
            'App registry is not configured. Pass appRegistry in ManifestMCPServerOptions.'
          );
        }
        const name = toolInput.name as string;
        if (!name) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'name is required'
          );
        }
        const rawTail = toolInput.tail;
        const tail = typeof rawTail === 'number' && Number.isFinite(rawTail) && rawTail > 0
          ? Math.floor(rawTail)
          : undefined;
        const address = await this.walletProvider.getAddress();
        const result = await getAppLogs(
          address,
          name,
          this.appRegistry,
          (addr, leaseUuid) => this.getProviderAuthToken(addr, leaseUuid),
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
