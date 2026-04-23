import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

/**
 * Wallet-bound builder for ADR-036 provider auth tokens.
 *
 * Owns the stateful pieces (timestamp serialization, signArbitrary binding) so
 * that `FredMCPServer` can depend on a single collaborator rather than hand-
 * rolling the flow at each tool call site. The underlying stateless builders
 * (`createSignMessage`, `createAuthToken`, etc.) remain in `./auth.ts` for
 * library callers who need them without our specific wallet wiring.
 *
 * The `signArbitrary` requirement is enforced lazily — a wallet without
 * ADR-036 support still lets the server boot and serve non-auth-gated paths;
 * only provider-auth tool calls throw `INVALID_CONFIG`.
 */
export class AuthTokenService {
  private readonly timestamps = new AuthTimestampTracker();

  constructor(private readonly walletProvider: WalletProvider) {}

  async providerToken(address: string, leaseUuid: string): Promise<string> {
    const signArbitrary = this.requireSignArbitrary();
    const timestamp = await this.timestamps.next();
    const message = createSignMessage(address, leaseUuid, timestamp);
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(
      address,
      leaseUuid,
      timestamp,
      pub_key.value,
      signature,
    );
  }

  async leaseDataToken(
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ): Promise<string> {
    const signArbitrary = this.requireSignArbitrary();
    const timestamp = await this.timestamps.next();
    const message = createLeaseDataSignMessage(
      leaseUuid,
      metaHashHex,
      timestamp,
    );
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(
      address,
      leaseUuid,
      timestamp,
      pub_key.value,
      signature,
      metaHashHex,
    );
  }

  private requireSignArbitrary(): NonNullable<WalletProvider['signArbitrary']> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication. Use a wallet provider that implements signArbitrary.',
      );
    }
    return this.walletProvider.signArbitrary.bind(this.walletProvider);
  }
}
