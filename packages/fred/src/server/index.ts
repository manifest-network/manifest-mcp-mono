// MCP-server entry for fred, exported at the Node-only
// `@manifest-network/manifest-mcp-fred/server` subpath. Kept OUT of the main
// barrel (`../index.ts`) so browser consumers of fred's capability functions
// (`deployManifest`, `restartApp`, …) don't drag in the MCP server machinery
// (`McpServer`, `register-*`, the SSRF `fetch-gate` → core's Node-only
// `/guarded-fetch`). Same barrel-hygiene split ENG-281 applied to core. (ENG-287)
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  parseBooleanEnv,
  VERSION,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthTokenService } from '../http/auth-token-service.js';
import { FRED_FETCH_GUARDED_ENV, resolveGuardedFetch } from './fetch-gate.js';
import { registerPrompts } from './register-prompts.js';
import { registerResources } from './register-resources.js';
import { registerTools } from './register-tools.js';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

export class FredMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private authTokens: AuthTokenService;

  constructor(options: ManifestMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );
    this.authTokens = new AuthTokenService(this.walletProvider);

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-fred',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    // SSRF guard (ENG-268). Fred fetches provider/Fred APIs at URLs sourced
    // from on-chain SKU records, so a malicious provider could point them at
    // an internal host. Route all outbound HTTP through an SSRF-guarded fetch
    // by default; operators opt out with MANIFEST_FRED_FETCH_GUARDED=0.
    const guardEnvValue =
      typeof process !== 'undefined'
        ? process.env.MANIFEST_FRED_FETCH_GUARDED
        : undefined;
    const fetchFn = resolveGuardedFetch(
      guardEnvValue,
      typeof process !== 'undefined' && !!process.versions?.node,
    );
    // Same switch drives the provider-URL SSRF string check: when the guard is
    // disabled the server relaxes loopback so both SSRF layers stay in sync
    // (needed for e2e's loopback providerd). Parses the SAME env value with the
    // SAME parser as resolveGuardedFetch, so the two layers never diverge.
    // resolveGuardedFetch already threw on an unrecognized value above.
    // Note: when disabled the string check relaxes ONLY loopback (not RFC1918 /
    // metadata), so it stays intentionally stricter than the fully-off connect
    // guard — e2e needs only loopback, and relaxing the full private range adds
    // risk for no benefit.
    const guarded = parseBooleanEnv(
      guardEnvValue,
      true,
      FRED_FETCH_GUARDED_ENV,
    );

    registerTools({
      mcpServer: this.mcpServer,
      clientManager: this.clientManager,
      walletProvider: this.walletProvider,
      authTokens: this.authTokens,
      fetchFn,
      allowLoopback: !guarded,
    });
    registerResources({
      mcpServer: this.mcpServer,
      clientManager: this.clientManager,
      walletProvider: this.walletProvider,
    });
    registerPrompts(this.mcpServer);
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

export function createMnemonicFredServer(
  config: MnemonicServerConfig,
): Promise<FredMCPServer> {
  return createMnemonicServer(config, FredMCPServer);
}
