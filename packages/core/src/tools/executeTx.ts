import type { EncodeObject } from '@cosmjs/proto-signing';
import type { TxCtx } from '../ctx.js';
import { withTxConfirmation } from '../internals/tx-confirmation.js';
import type { TxCallOptions } from '../options.js';
import { withRetry } from '../retry.js';
import {
  buildExecuteSyncTxResult,
  buildExecuteTxResult,
  buildGasFee,
  validateMemo,
} from '../transactions/utils.js';
import type { ExecuteTxResult, TxOptions } from '../types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Broadcast MULTIPLE messages as ONE atomic transaction (single sequence, single fee, all-or-nothing).
 * A direct signAndBroadcast path — it does NOT go through the per-module cosmos_tx router (there is no
 * module/subcommand for a raw heterogeneous batch). Threads TxCallOptions exactly like the 3 typed txs
 * (fee-wins / gasMultiplier-simulate / memo / signal) and serializes under the per-signer broadcast
 * mutex. The CALLER's messages must already carry the matching `sender`/`authority` field — executeTx
 * resolves the sender for signing (OI-SENDER: ctx.chain, no requireAuthSigner) but does NOT inject it
 * into message bodies. Typed-face only (no stringly equivalent; §9).
 */
export async function executeTx(
  ctx: TxCtx,
  messages: readonly EncodeObject[],
  opts?: TxCallOptions,
): Promise<ExecuteTxResult> {
  if (messages.length === 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'executeTx requires at least one message',
    );
  }
  // Re-apply the guards that live inside cosmosTx (bypassed by this direct path — OI-EXEC-GUARDS).
  if (opts?.fee !== undefined && opts?.gasMultiplier !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'passing both fee and gasMultiplier is a caller error; fee wins (it skips simulation), gasMultiplier applies only on the simulate path',
    );
  }
  let txOptions: TxOptions | undefined;
  if (opts?.gasMultiplier !== undefined) {
    if (!Number.isFinite(opts.gasMultiplier) || opts.gasMultiplier < 1) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${opts.gasMultiplier}`,
      );
    }
    const gasPrice = ctx.chain.getConfig().gasPrice;
    if (!gasPrice) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'gasMultiplier override requires gasPrice configuration',
      );
    }
    txOptions = { gasMultiplier: opts.gasMultiplier, gasPrice };
  }

  const typeUrls = messages.map((m) => m.typeUrl);
  const sender = await ctx.chain.getAddress();

  return withTxConfirmation(
    () =>
      ctx.chain.withBroadcastLock(sender, () =>
        withRetry(
          async () => {
            try {
              await ctx.chain.acquireRateLimit();
              const client = await ctx.chain.getSigningClient();
              const effectiveMemo = opts?.memo ?? '';
              validateMemo(effectiveMemo);
              const fee =
                opts?.fee !== undefined
                  ? opts.fee
                  : await buildGasFee(
                      client,
                      sender,
                      messages,
                      txOptions,
                      effectiveMemo,
                    );
              // Broadcast mode (default true = wait for inclusion). `false` → SYNC/CheckTx broadcast,
              // hash only (no DeliverTx) — the caller reconciles via the tx hash.
              if (opts?.waitForConfirmation === false) {
                const transactionHash = await client.signAndBroadcastSync(
                  sender,
                  messages,
                  fee,
                  effectiveMemo,
                );
                return buildExecuteSyncTxResult(transactionHash, typeUrls);
              }
              const result = await client.signAndBroadcast(
                sender,
                messages,
                fee,
                effectiveMemo,
              );
              return buildExecuteTxResult(result, typeUrls);
            } catch (error) {
              // M2 — MIRROR cosmosTx's broadcast-leg wrapping (cosmos.ts:251-269): a pre-broadcast
              // ManifestMCPError (e.g. a transient RPC_CONNECTION_FAILED from getSigningClient) passes
              // through and stays retryable; ANY raw/non-ManifestMCPError (a network error from
              // signAndBroadcast/simulate) becomes TX_FAILED → NON_RETRYABLE (retry.ts:35), so a
              // submitted-but-failed multi-msg batch is NEVER re-broadcast (no double-spend).
              if (error instanceof ManifestMCPError) throw error;
              throw new ManifestMCPError(
                ManifestMCPErrorCode.TX_FAILED,
                `executeTx (${typeUrls.join(', ') || 'no messages'}) failed: ${error instanceof Error ? error.message : String(error)}`,
                { msgTypeUrls: typeUrls },
              );
            }
          },
          {
            config: ctx.chain.getConfig().retry,
            operationName: `executeTx (${messages.length} msgs)`,
          },
        ),
      ),
    opts,
  );
}
