import { z } from 'zod';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const chainIdSchema = z.string().min(1).max(256);
const nodeInfoSchema = z
  .object({ default_node_info: z.object({ network: chainIdSchema }) })
  .transform((info) => info.default_node_info.network);
const rpcRequestId = 'manifest-chain-identity';
const rpcStatusSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.literal(rpcRequestId),
    result: z.object({ node_info: z.object({ network: chainIdSchema }) }),
    error: z.never().optional(),
  })
  .transform((status) => status.result.node_info.network);

/** Fail closed before exposing queries from a REST endpoint belonging to another chain. */
export async function verifyRestChainIdentity(
  restUrl: string,
  expectedChainId: string,
  fetchFn: typeof globalThis.fetch,
): Promise<void> {
  return verifyChainIdentity(restUrl, expectedChainId, fetchFn, 'REST');
}

/** Verify RPC reads independently of the lazily acquired signing connection. */
export async function verifyRpcChainIdentity(
  rpcUrl: string,
  expectedChainId: string,
  fetchFn: typeof globalThis.fetch,
): Promise<void> {
  return verifyChainIdentity(rpcUrl, expectedChainId, fetchFn, 'RPC');
}

async function verifyChainIdentity(
  endpoint: string,
  expectedChainId: string,
  fetchFn: typeof globalThis.fetch,
  protocol: 'REST' | 'RPC',
): Promise<void> {
  const rest = protocol === 'REST';
  const document = rest ? 'node-info' : 'status';
  const details = rest ? { restUrl: endpoint } : { rpcUrl: endpoint };
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetchFn(
      rest
        ? `${endpoint.replace(/\/+$/, '')}/cosmos/base/tendermint/v1beta1/node_info`
        : endpoint,
      {
        signal,
        redirect: 'error',
        // Match CosmJS's JSON-RPC POST rather than assuming gateways expose a /status path.
        ...(!rest && {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequestId,
            method: 'status',
            params: {},
          }),
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        `${protocol} chain identity verification failed: HTTP ${response.status}.`,
        details,
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
              `${protocol} ${document} response exceeds the 64 KiB verification limit.`,
              details,
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
        `${protocol} endpoint did not return JSON ${document}.`,
        details,
      );
    }
    const parsed = (rest ? nodeInfoSchema : rpcStatusSchema).safeParse(json);
    if (!parsed.success) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `${protocol} endpoint did not return a valid ${document} chain identity.`,
        details,
      );
    }
    const actualChainId = parsed.data;
    if (actualChainId !== expectedChainId) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `${protocol} chain identity does not match the configured chainId.`,
        { expectedChainId, actualChainId, ...details },
      );
    }
  } catch (error) {
    if (signal.aborted) {
      // Native timeout/AbortError prose differs across fetch and body reads. Normalize the
      // helper's own deadline so the existing connection retry policy handles both phases.
      throw new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        `${protocol} chain identity verification timed out.`,
        details,
      );
    }
    throw error;
  }
}
