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
  serverEntry?: string;
  /**
   * Converter contract address. Required for the cosmwasm server. Defaults
   * to `process.env.MANIFEST_CONVERTER_ADDRESS`, which `global-setup.ts`
   * populates from the chain container's `/shared/converter.env`.
   */
  converterAddress?: string;
  /**
   * Faucet URL. When set, the chain server registers the optional
   * `request_faucet` tool. Tests that need to verify the conditional
   * registration matrix pass this even if no faucet container is running.
   */
  faucetUrl?: string;
  /**
   * REST/LCD URL. When set, `COSMOS_REST_URL` is exported to the spawned
   * process. The CosmosClientManager prefers REST for queries when both
   * REST and RPC are configured. Set together with `disableRpc: true` to
   * test query-only mode where signing throws INVALID_CONFIG.
   */
  restUrl?: string;
  /**
   * If true, omit `COSMOS_RPC_URL` and `COSMOS_GAS_PRICE` from the
   * spawned process env so the server boots in query-only (REST) mode.
   * Pair with `restUrl`. Defaults to false.
   */
  disableRpc?: boolean;
  /**
   * When set, the spawned process receives `MANIFEST_KEY_FILE=<path>`,
   * overriding the default sentinel that forces the mnemonic branch.
   * Pair with `disableMnemonic: true` to drive the keyfile bootstrap
   * path exclusively (the file must already exist with a valid
   * encrypted-wallet or `{mnemonic: ...}` payload).
   */
  keyFile?: string;
  /**
   * When set, exports `MANIFEST_KEY_PASSWORD` to the spawned process
   * for decrypting an encrypted keyfile.
   */
  keyPassword?: string;
  /**
   * If true, omit `COSMOS_MNEMONIC` so the bootstrap can't fall back
   * to the mnemonic branch. Used together with `keyFile` to test the
   * encrypted/plaintext keyfile resolution paths.
   */
  disableMnemonic?: boolean;
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
    const serverEntry = resolve(
      process.cwd(),
      options.serverEntry ?? 'packages/node/dist/chain.js',
    );

    const converterAddress =
      options.converterAddress ?? process.env.MANIFEST_CONVERTER_ADDRESS;

    // Build env carefully:
    //   1. Inherit only entries with defined string values from process.env
    //      (NodeJS.ProcessEnv values are typed `string | undefined`).
    //   2. Explicitly delete the keys that any of our options can opt out
    //      of (RPC, mnemonic, REST, faucet, converter address). Otherwise
    //      a developer with one of these set in their shell would silently
    //      override the test's intent — e.g. a stray COSMOS_RPC_URL would
    //      defeat `disableRpc: true`, and a stray MANIFEST_FAUCET_URL
    //      would make the chain server register `request_faucet` even
    //      when the test wants the no-faucet branch.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }

    delete env.COSMOS_RPC_URL;
    delete env.COSMOS_GAS_PRICE;
    delete env.COSMOS_REST_URL;
    delete env.COSMOS_MNEMONIC;
    delete env.MANIFEST_FAUCET_URL;
    delete env.MANIFEST_CONVERTER_ADDRESS;
    delete env.MANIFEST_KEY_PASSWORD;

    // Force keyfile to a sentinel path so the server falls through to the
    // mnemonic wallet, regardless of host-local keyfiles. Caller can
    // override via options.keyFile to drive the keyfile path.
    env.MANIFEST_KEY_FILE = options.keyFile ?? '/dev/null/nonexistent';
    env.COSMOS_CHAIN_ID = options.chainId ?? 'manifest-localnet';

    if (!options.disableMnemonic) {
      env.COSMOS_MNEMONIC = options.mnemonic ?? DEFAULT_MNEMONIC;
    }
    if (options.keyPassword !== undefined) {
      env.MANIFEST_KEY_PASSWORD = options.keyPassword;
    }

    if (!options.disableRpc) {
      env.COSMOS_RPC_URL = options.rpcUrl ?? 'http://localhost:26657';
      env.COSMOS_GAS_PRICE = options.gasPrice ?? '0.01umfx';
    }
    if (options.restUrl) {
      env.COSMOS_REST_URL = options.restUrl;
    }
    if (process.env.E2E_TLS_CERT_PATH) {
      env.NODE_EXTRA_CA_CERTS = process.env.E2E_TLS_CERT_PATH;
    }
    if (converterAddress) {
      env.MANIFEST_CONVERTER_ADDRESS = converterAddress;
    }
    if (options.faucetUrl) {
      env.MANIFEST_FAUCET_URL = options.faucetUrl;
    }

    this.transport = new StdioClientTransport({
      command: 'node',
      args: [serverEntry],
      env,
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

  /**
   * Call a tool and return the parsed error response (NOT the success
   * payload). Throws if the tool returned successfully — useful for tests
   * that explicitly assert error paths and want to inspect the structured
   * error fields (`code`, `message`, `details`, `input`).
   */
  async callToolExpectError(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    error: true;
    tool: string;
    code?: string;
    message?: string;
    details?: unknown;
    input?: unknown;
  }> {
    const result = await this.client.callTool({ name, arguments: args });
    if (!result.isError) {
      throw new Error(
        `Expected tool "${name}" to return isError: true, got success`,
      );
    }
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content?.[0]?.text;
    if (!text) {
      throw new Error(`Tool "${name}" returned no text content`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Tool "${name}" returned non-JSON error body (raw): ${text}`,
      );
    }
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => t.name);
  }

  /**
   * Like `listTools()` but returns the full tool descriptors (annotations,
   * _meta, inputSchema, etc.). Used by tool-annotations.e2e.test.ts to
   * assert the annotation matrix over the live MCP transport.
   */
  async listToolsRaw(): Promise<
    Array<{
      name: string;
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
      _meta?: {
        manifest?: { v: number; broadcasts: boolean; estimable: boolean };
      };
    }>
  > {
    const result = await this.client.listTools();
    return result.tools as Array<{
      name: string;
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
      _meta?: {
        manifest?: { v: number; broadcasts: boolean; estimable: boolean };
      };
    }>;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Parse the `[CODE]` prefix out of an Error thrown by `callTool`.
 *
 * `callTool` formats failures as: `Tool "${name}" failed [${code}]: ${message}`.
 * Probes that swallow expected chain-side errors (e.g. "wasm migrate has no
 * migrate entry point", "distribution module disabled on POA") use this to
 * narrow their catch — anything that isn't one of the expected codes is a
 * routing/transport regression and gets re-thrown.
 *
 * Returns `null` if the error message doesn't match the callTool format
 * (e.g., a plain Error from MCPTestClient itself), in which case the caller
 * should treat it as unexpected and re-throw.
 */
export function parseToolErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/failed \[([A-Z_]+)\]:/);
  return match ? match[1] : null;
}
