import { fromUtf8, toUtf8 } from '@cosmjs/encoding';
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createValidatedConfig,
  jsonResponse,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  MnemonicWalletProvider,
  VERSION,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import { cosmwasm } from '@manifest-network/manifestjs';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

const { MsgExecuteContract } = cosmwasm.wasm.v1;

export interface CosmwasmMCPServerOptions extends ManifestMCPServerOptions {
  readonly converterAddress: string;
}

/** Response shape of the converter contract's {"config":{}} smart query. */
interface ConverterConfig {
  readonly poa_admin: string;
  readonly rate: string;
  readonly source_denom: string;
  readonly target_denom: string;
  readonly paused: boolean;
}

/**
 * Calculate the conversion output using integer arithmetic on a decimal rate string.
 * e.g., amount="1000000", rate="0.379" -> "379000"
 */
function calculateConversion(amount: string, rateStr: string): string {
  if (!/^\d+$/.test(amount)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid conversion amount: "${amount}". Must be a non-negative integer string.`,
    );
  }
  if (!/^\d+(\.\d+)?$/.test(rateStr)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Invalid conversion rate from contract: "${rateStr}". Expected a decimal number.`,
    );
  }
  const parts = rateStr.split('.');
  const decimals = parts[1]?.length ?? 0;
  const numerator = BigInt(rateStr.replace('.', ''));
  const denominator = BigInt(10) ** BigInt(decimals);
  const result = (BigInt(amount) * numerator) / denominator;
  return result.toString();
}

export class CosmwasmMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private converterAddress: string;

  constructor(options: CosmwasmMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.converterAddress = options.converterAddress;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-cosmwasm',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  private async queryConverterConfig(): Promise<ConverterConfig> {
    await this.clientManager.acquireRateLimit();
    const queryClient = await this.clientManager.getQueryClient();
    const wasm = queryClient.cosmwasm.wasm.v1;
    const result = await wasm.smartContractState({
      address: this.converterAddress,
      queryData: toUtf8(JSON.stringify({ config: {} })),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(fromUtf8(result.data));
    } catch (error) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Failed to parse converter config response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj !== 'object' ||
      obj === null ||
      typeof obj.poa_admin !== 'string' ||
      typeof obj.rate !== 'string' ||
      typeof obj.source_denom !== 'string' ||
      typeof obj.target_denom !== 'string' ||
      typeof obj.paused !== 'boolean'
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Unexpected converter config shape from contract ${this.converterAddress}. ` +
          `Expected {poa_admin: string, rate: string, source_denom: string, target_denom: string, paused: boolean}.`,
      );
    }

    return obj as unknown as ConverterConfig;
  }

  private registerTools(): void {
    // -- get_mfx_to_pwr_rate --
    this.mcpServer.registerTool(
      'get_mfx_to_pwr_rate',
      {
        description:
          'Get the current MFX-to-PWR conversion rate and optionally preview how much PWR a given amount of MFX would produce. Use this before convert_mfx_to_pwr to see the expected output.',
        inputSchema: {
          amount: z
            .string()
            .optional()
            .describe(
              'Optional amount of umfx to preview conversion for (e.g. "1000000" for 1 MFX)',
            ),
        },
      },
      withErrorHandling('get_mfx_to_pwr_rate', async (args) => {
        const config = await this.queryConverterConfig();

        const response: Record<string, unknown> = {
          rate: config.rate,
          source_denom: config.source_denom,
          target_denom: config.target_denom,
          paused: config.paused,
          converter_address: this.converterAddress,
        };

        if (args.amount) {
          const outputAmount = calculateConversion(args.amount, config.rate);
          response.preview = {
            input_amount: args.amount,
            input_denom: config.source_denom,
            output_amount: outputAmount,
            output_denom: config.target_denom,
          };
        }

        return jsonResponse(response, bigIntReplacer);
      }),
    );

    // -- convert_mfx_to_pwr --
    this.mcpServer.registerTool(
      'convert_mfx_to_pwr',
      {
        description:
          'Convert MFX tokens to PWR tokens via the on-chain converter contract. Sends umfx and receives upwr at the current conversion rate. Use get_mfx_to_pwr_rate first to preview the expected output.',
        inputSchema: {
          amount: z
            .string()
            .describe('Amount of umfx to convert (e.g. "1000000" for 1 MFX)'),
        },
      },
      withErrorHandling('convert_mfx_to_pwr', async (args) => {
        if (args.amount === '0') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            'Conversion amount must be greater than zero.',
          );
        }

        // Query config for rate preview and paused status
        const config = await this.queryConverterConfig();
        if (config.paused) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `The converter contract (${this.converterAddress}) is currently paused. MFX-to-PWR conversion is not available.`,
          );
        }
        const expectedOutput = calculateConversion(args.amount, config.rate);

        // Execute conversion
        await this.clientManager.acquireRateLimit();
        const signingClient = await this.clientManager.getSigningClient();
        const senderAddress = await this.walletProvider.getAddress();

        const msg = {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: MsgExecuteContract.fromPartial({
            sender: senderAddress,
            contract: this.converterAddress,
            msg: toUtf8(JSON.stringify({ convert: {} })),
            funds: [{ denom: config.source_denom, amount: args.amount }],
          }),
        };

        const result = await signingClient.signAndBroadcast(
          senderAddress,
          [msg],
          'auto',
        );

        if (result.code !== 0) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `MFX-to-PWR conversion failed with code ${result.code}: ${result.rawLog || 'no details'}`,
            {
              transactionHash: result.transactionHash,
              code: result.code,
              rawLog: result.rawLog,
            },
          );
        }

        return jsonResponse(
          {
            transactionHash: result.transactionHash,
            code: result.code,
            height: String(result.height),
            gasUsed: String(result.gasUsed),
            gasWanted: String(result.gasWanted),
            input: {
              amount: args.amount,
              denom: config.source_denom,
            },
            expected_output: {
              amount: expectedOutput,
              denom: config.target_denom,
            },
            rate: config.rate,
          },
          bigIntReplacer,
        );
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

export async function createMnemonicCosmwasmServer(
  config: MnemonicServerConfig & { converterAddress: string },
): Promise<CosmwasmMCPServer> {
  const { converterAddress, mnemonic, ...mcpConfig } = config;
  const validatedConfig = createValidatedConfig(mcpConfig);
  const walletProvider = new MnemonicWalletProvider(validatedConfig, mnemonic);
  await walletProvider.connect();

  return new CosmwasmMCPServer({
    config: validatedConfig,
    walletProvider,
    converterAddress,
  });
}
