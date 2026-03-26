import {
  type Coin,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

export interface FaucetDistributor {
  readonly address: string;
  readonly balance: readonly Coin[];
}

export interface FaucetHolder {
  readonly address: string;
  readonly balance: readonly Coin[];
}

export interface FaucetStatusResponse {
  readonly status: string;
  readonly nodeUrl: string;
  readonly chainId: string;
  readonly chainTokens: readonly string[];
  readonly availableTokens: readonly string[];
  readonly holder: FaucetHolder;
  readonly distributors: readonly FaucetDistributor[];
}

export interface FaucetDripResult {
  readonly denom: string;
  readonly success: boolean;
  readonly transactionHash?: string;
  readonly error?: string;
}

export interface RequestFaucetResult {
  readonly address: string;
  readonly results: readonly FaucetDripResult[];
}

/**
 * Fetch faucet status including available tokens from the `/status` endpoint.
 */
export async function fetchFaucetStatus(
  faucetUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<FaucetStatusResponse> {
  const base = faucetUrl.replace(/\/+$/, '');
  const url = `${base}/status`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Faucet status request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Faucet status returned HTTP ${res.status}: ${text}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Faucet /status returned invalid JSON (HTTP ${res.status})`,
    );
  }

  const status = body as FaucetStatusResponse;
  if (!Array.isArray(status?.availableTokens)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'Faucet /status response missing "availableTokens" array',
    );
  }

  return status;
}

/**
 * Request a single denom from the faucet. Returns a result object rather than
 * throwing, so callers can collect partial successes.
 */
export async function requestFaucetCredit(
  faucetUrl: string,
  address: string,
  denom: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<FaucetDripResult> {
  const base = faucetUrl.replace(/\/+$/, '');
  const url = `${base}/credit`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, denom }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { denom, success: false, error: text || `HTTP ${res.status}` };
    }

    const body = (await res.json()) as { transactionHash?: string };
    return {
      denom,
      success: true,
      transactionHash: body.transactionHash,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { denom, success: false, error: message };
  }
}

/**
 * Request tokens from the faucet.
 *
 * If `denom` is provided, requests only that denom.
 * Otherwise, discovers available denoms via `/status` and requests all of them.
 */
export async function requestFaucet(
  faucetUrl: string,
  address: string,
  denom?: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<RequestFaucetResult> {
  if (denom) {
    const result = await requestFaucetCredit(
      faucetUrl,
      address,
      denom,
      fetchFn,
    );
    return { address, results: [result] };
  }

  const status = await fetchFaucetStatus(faucetUrl, fetchFn);
  const denoms = status.availableTokens.filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );

  if (denoms.length === 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'Faucet has no tokens configured',
    );
  }

  const results = await Promise.all(
    denoms.map((d) => requestFaucetCredit(faucetUrl, address, d, fetchFn)),
  );

  return { address, results };
}
