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
              text: JSON.stringify(errorResponse, null, 2),
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
              text: JSON.stringify(result, null, 2),
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
              text: JSON.stringify(result, null, 2),
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

      default:
        throw new ManifestMCPError(
          ManifestMCPErrorCode.UNKNOWN_ERROR,
          `Unknown tool: ${toolName}`
        );
    }
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
