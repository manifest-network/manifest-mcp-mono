import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  type AccountInfo,
  bigIntReplacer,
  CosmosClientManager,
  cosmosEstimateFee,
  cosmosQuery,
  cosmosTx,
  createMnemonicServer,
  createValidatedConfig,
  getAvailableModules,
  getModuleSubcommands,
  jsonResponse,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  manifestMeta,
  mutatingAnnotations,
  readOnlyAnnotations,
  VERSION,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestFaucet } from './faucet.js';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';
export type {
  FaucetAccount,
  FaucetDripResult,
  FaucetStatusResponse,
  RequestFaucetResult,
} from './faucet.js';
export {
  fetchFaucetStatus,
  requestFaucet,
  requestFaucetCredit,
} from './faucet.js';

export interface ChainMCPServerOptions extends ManifestMCPServerOptions {
  /** Faucet base URL. When set, the `request_faucet` tool is registered. */
  readonly faucetUrl?: string;
}

/**
 * MCP server for Cosmos SDK chain operations: queries, transactions, and module discovery.
 */
export class ChainMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;

  constructor(options: ChainMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-chain',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerTools(options.faucetUrl);
  }

  private registerTools(faucetUrl?: string): void {
    // ── get_account_info ──
    this.mcpServer.registerTool(
      'get_account_info',
      {
        description:
          'Get the wallet address for the configured key. Use this to check which account is active.',
        annotations: readOnlyAnnotations('Get agent wallet address', {
          openWorld: false,
        }),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
        description:
          'Execute any Cosmos SDK query command. Call list_modules and list_module_subcommands first to discover available options.',
        inputSchema: {
          module: z
            .string()
            .describe(
              'The module name (e.g., "bank", "staking", "distribution", "gov", "auth")',
            ),
          subcommand: z
            .string()
            .describe(
              'The subcommand (e.g., "balance", "balances", "delegations", "rewards", "proposals")',
            ),
          args: z
            .array(z.string())
            .optional()
            .describe(
              'Additional arguments as an array of strings (e.g., ["<address>", "umfx"] for bank balance). Use array to preserve arguments with spaces.',
            ),
        },
        annotations: readOnlyAnnotations('Run a Cosmos SDK query'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('cosmos_query', async (args) => {
        const result = await cosmosQuery(
          this.clientManager,
          args.module,
          args.subcommand,
          args.args ?? [],
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── cosmos_tx ──
    this.mcpServer.registerTool(
      'cosmos_tx',
      {
        description:
          'Execute any Cosmos SDK transaction with automatic signing and gas estimation. Call list_modules and list_module_subcommands first to discover available options.',
        inputSchema: {
          module: z
            .string()
            .describe('The module name (e.g., "bank", "staking", "gov")'),
          subcommand: z
            .string()
            .describe(
              'The subcommand (e.g., "send", "delegate", "unbond", "vote")',
            ),
          args: z
            .array(z.string())
            .describe(
              'Arguments to the transaction as an array of strings (e.g., ["<to_address>", "1000umfx"] for bank send). Use array to preserve arguments with spaces.',
            ),
          wait_for_confirmation: z
            .boolean()
            .optional()
            .describe(
              'If true, wait for the transaction to be included in a block before returning. Defaults to false (broadcast only).',
            ),
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this transaction. Defaults to the server-configured value (typically 1.5). Increase if a transaction fails with out-of-gas errors.',
            ),
        },
        annotations: mutatingAnnotations('Broadcast a Cosmos SDK transaction', {
          // Generic tx — can carry destructive messages (close, redelegate
          // away, gov vote, etc.). Treat conservatively as destructive.
          destructive: true,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: true,
        }),
      },
      withErrorHandling('cosmos_tx', async (args) => {
        const result = await cosmosTx(
          this.clientManager,
          args.module,
          args.subcommand,
          args.args,
          args.wait_for_confirmation ?? false,
          args.gas_multiplier !== undefined
            ? { gasMultiplier: args.gas_multiplier }
            : undefined,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── cosmos_estimate_fee ──
    this.mcpServer.registerTool(
      'cosmos_estimate_fee',
      {
        description:
          'Estimate the gas and fee for any Cosmos SDK transaction without broadcasting it. ' +
          'Runs the same simulation cosmos_tx would run internally. ' +
          'Call list_modules and list_module_subcommands first to discover available options.',
        inputSchema: {
          module: z
            .string()
            .describe('The module name (e.g., "bank", "staking", "gov")'),
          subcommand: z
            .string()
            .describe(
              'The subcommand (e.g., "send", "delegate", "unbond", "vote")',
            ),
          args: z
            .array(z.string())
            .optional()
            .describe(
              'Arguments to the transaction as an array of strings (e.g., ["<to_address>", "1000umfx"] for bank send). Use array to preserve arguments with spaces. Omit for subcommands that take no arguments.',
            ),
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this estimation. Defaults to the server-configured value (typically 1.5).',
            ),
        },
        annotations: readOnlyAnnotations('Estimate Cosmos SDK transaction fee'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('cosmos_estimate_fee', async (args) => {
        const result = await cosmosEstimateFee(
          this.clientManager,
          args.module,
          args.subcommand,
          args.args ?? [],
          args.gas_multiplier !== undefined
            ? { gasMultiplier: args.gas_multiplier }
            : undefined,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── list_modules ──
    this.mcpServer.registerTool(
      'list_modules',
      {
        description:
          'List all available query and transaction modules. Call this before using cosmos_query or cosmos_tx to discover what modules are available.',
        // Backed by a static in-process registry (modules.ts), no chain RPC.
        annotations: readOnlyAnnotations('List Cosmos SDK modules', {
          openWorld: false,
        }),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
        description:
          'List available subcommands for a specific module. Call this after list_modules to discover the exact subcommand names and required arguments before calling cosmos_query or cosmos_tx.',
        inputSchema: {
          type: z
            .enum(['query', 'tx'])
            .describe('Whether to list query or transaction subcommands'),
          module: z
            .string()
            .describe('The module name (e.g., "bank", "staking")'),
        },
        // Backed by a static in-process registry (modules.ts), no chain RPC.
        annotations: readOnlyAnnotations(
          'List subcommands for a Cosmos SDK module',
          {
            openWorld: false,
          },
        ),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('list_module_subcommands', async (args) => {
        const subcommands = getModuleSubcommands(args.type, args.module);
        return jsonResponse({
          type: args.type,
          module: args.module,
          subcommands,
        });
      }),
    );

    if (faucetUrl) {
      this.mcpServer.registerTool(
        'request_faucet',
        {
          description:
            'Request testnet tokens from the faucet. ' +
            'Each denom has an independent cooldown period. ' +
            'If no denom is specified, all available denoms are requested.',
          inputSchema: {
            denom: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe(
                'Specific denom to request (e.g. "umfx"). If omitted, requests all available denoms.',
              ),
          },
          // The faucet operator's wallet (not the agent's) signs and
          // broadcasts; from the agent's perspective this is an HTTP request
          // that returns funds. Hence broadcasts=false. It does mutate
          // external state, so readOnlyHint is false.
          annotations: mutatingAnnotations(
            'Request testnet tokens from faucet',
            {
              destructive: false,
              idempotent: false,
            },
          ),
          _meta: manifestMeta({
            broadcasts: false,
            estimable: false,
          }),
        },
        withErrorHandling('request_faucet', async (args) => {
          const address = await this.walletProvider.getAddress();
          const result = await requestFaucet(faucetUrl, address, args.denom);
          return jsonResponse(result);
        }),
      );
    }
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

export function createMnemonicChainServer(
  config: MnemonicServerConfig,
): Promise<ChainMCPServer> {
  return createMnemonicServer(config, ChainMCPServer);
}
