// Override module resolution for @web3auth/node-sdk to avoid pulling in
// viem/ox raw .ts source files that fail our build target (ES2020).
// We only use dynamic imports with `as unknown` casts, so no real types are needed.
declare module '@web3auth/node-sdk' {
  export class Web3Auth {
    constructor(options: Record<string, unknown>);
    init(): Promise<void>;
    connect(params: Record<string, unknown>): Promise<{
      provider: { request(args: { method: string }): Promise<unknown> };
    }>;
  }
}
