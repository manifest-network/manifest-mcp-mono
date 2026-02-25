export interface SessionData {
  readonly idToken: string;
  readonly oauthProvider: string;
  readonly verifierId: string;
  readonly createdAt: string;
  readonly privateKeyHex: string;
  readonly address: string;
}

export interface OAuthConfig {
  readonly provider: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface Web3AuthConfig {
  readonly clientId: string;
  readonly network: string;
  readonly verifier: string;
}

export interface OAuthResult {
  readonly idToken: string;
  readonly verifierId: string;
}
