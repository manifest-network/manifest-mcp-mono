import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

// Test tenant mnemonic (test-only, never used for real funds)
const DEFAULT_MNEMONIC =
  'wealth flavor believe regret funny network recall kiss grape useless pepper cram hint member few certain unveil rather brick bargain curious require crowd raise';

export interface MCPTestClientOptions {
  mnemonic?: string;
  chainId?: string;
  rpcUrl?: string;
  gasPrice?: string;
}

/**
 * Wraps the MCP SDK Client + StdioClientTransport for E2E testing.
 * Spawns the node MCP server as a child process and communicates via stdio.
 */
export class MCPTestClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;

  constructor() {
    this.client = new Client({ name: 'e2e-test', version: '1.0.0' });
  }

  async connect(options: MCPTestClientOptions = {}): Promise<void> {
    const serverEntry = resolve(process.cwd(), 'packages/node/dist/index.js');

    this.transport = new StdioClientTransport({
      command: 'node',
      args: [serverEntry],
      env: {
        ...process.env,
        // Force keyfile to a nonexistent path so the server always falls
        // through to the mnemonic wallet, regardless of host-local keyfiles.
        MANIFEST_KEY_FILE: '/dev/null/nonexistent',
        COSMOS_CHAIN_ID: options.chainId ?? 'manifest-localnet',
        COSMOS_RPC_URL: options.rpcUrl ?? 'http://localhost:26657',
        COSMOS_GAS_PRICE: options.gasPrice ?? '0.01umfx',
        COSMOS_MNEMONIC: options.mnemonic ?? DEFAULT_MNEMONIC,
      },
    });

    await this.client.connect(this.transport);
  }

  /**
   * Call an MCP tool and return the parsed JSON response.
   * Throws if the tool returns isError: true.
   */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });

    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content?.[0]?.text;
    if (!text) {
      throw new Error(`Tool "${name}" returned no text content`);
    }

    if (result.isError) {
      let code = 'UNKNOWN';
      let message = text;
      try {
        const errParsed = JSON.parse(text);
        code = errParsed.code ?? code;
        message = errParsed.message ?? message;
      } catch {
        // error response is not JSON — use raw text
      }
      throw new Error(`Tool "${name}" failed [${code}]: ${message}`);
    }

    return JSON.parse(text) as T;
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => t.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
