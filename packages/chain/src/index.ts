import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CosmosClientManager,
  cosmosQuery,
  cosmosTx,
  getAvailableModules,
  getModuleSubcommands,
  createValidatedConfig,
  createMnemonicServer,
  VERSION,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  type AccountInfo,
  withErrorHandling,
  jsonResponse,
  bigIntReplacer,
} from '@manifest-network/manifest-mcp-core';
import type { ManifestMCPConfig, WalletProvider } from '@manifest-network/manifest-mcp-core';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

/**
 * MCP server for Cosmos SDK chain operations: queries, transactions, and module discovery.
 */
export class ChainMCPServer {
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
        name: '@manifest-network/manifest-mcp-chain',
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
  }

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

export function createMnemonicChainServer(config: MnemonicServerConfig): Promise<ChainMCPServer> {
  return createMnemonicServer(config, ChainMCPServer);
}
