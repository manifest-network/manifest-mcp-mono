import { z } from 'zod';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const nodeInfoSchema = z.object({
  default_node_info: z.object({ network: z.string().min(1).max(256) }),
});

/** Fail closed before exposing queries from a REST endpoint belonging to another chain. */
export async function verifyRestChainIdentity(
  restUrl: string,
  expectedChainId: string,
  fetchFn: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetchFn(
    `${restUrl.replace(/\/+$/, '')}/cosmos/base/tendermint/v1beta1/node_info`,
    { signal: AbortSignal.timeout(10_000), redirect: 'error' },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      `REST chain identity verification failed: HTTP ${response.status}.`,
      { restUrl },
    );
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'REST node-info response exceeds the 64 KiB verification limit.',
            { restUrl },
          );
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'REST endpoint did not return JSON node-info.',
      { restUrl },
    );
  }
  const parsed = nodeInfoSchema.safeParse(json);
  if (!parsed.success) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'REST endpoint did not return a valid node-info chain identity.',
      { restUrl },
    );
  }
  const actualChainId = parsed.data.default_node_info.network;
  if (actualChainId !== expectedChainId) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'REST chain identity does not match the configured chainId.',
      { expectedChainId, actualChainId, restUrl },
    );
  }
}
