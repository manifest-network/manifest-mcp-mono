import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import {
  asProviderUuid,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  parseFqdn,
  resolveSku,
  sanitizeForLogging,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import { createLease } from './createLease.js';
import type { FredAuthCtx } from '../ctx.js';
import type { FredLeaseStatus, PollOptions } from '../http/fred.js';
import { pollLeaseUntilReady, TerminalChainStateError } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
  uploadLeaseData,
} from '../http/provider.js';
import { getServiceNames, metaHashHex, validateManifest } from '../manifest.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

import type {
  DeployResult,
  ManifestDeploySpec,
  SkuIntent,
} from '@manifest-network/manifest-mcp-core';

export type { DeployResult as DeployAppResult };

/** @deprecated Use `SkuIntent` from `@manifest-network/manifest-mcp-core`. Byte-compatible alias kept for the public fred API. */
export type SkuSelector = SkuIntent;

/** Data-only deploy spec for a raw manifest string (spec §5.1). Public name kept for compatibility. */
export type DeployManifestInput = ManifestDeploySpec;

/** Per-call runtime orchestration for a deploy (fred layer). Split off the data specs per §5.1. */
export interface DeployCallOptions {
  gasMultiplier?: number;
  onLeaseCreated?: (
    leaseUuid: string,
    providerUrl: string,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

/**
 * @deprecated Legacy positional-DI options. `deployManifest` now takes a
 * `FredAuthCtx` as its first argument; this interface is no longer the param
 * type but is kept exported as published sdk surface (`@manifest-network/manifest-sdk`'s
 * `deploy.ts` re-exports it).
 */
export interface DeployManifestOptions {
  clientManager: CosmosClientManager;
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHash: string,
  ) => Promise<string>;
  fetchFn?: typeof globalThis.fetch;
}

const MAX_MANIFEST_BYTES = 256 * 1024;

export async function deployManifest(
  ctx: FredAuthCtx,
  spec: ManifestDeploySpec,
  callOptions: DeployCallOptions = {},
): Promise<DeployResult> {
  const manifestBytes = new TextEncoder().encode(spec.manifest);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest is ${manifestBytes.length} bytes; the maximum is ${MAX_MANIFEST_BYTES}.`,
    );
  }

  // Parse + validate at the boundary, before any tx (size cap above;
  // __proto__/constructor reject below; provider re-validates server-side).
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec.manifest);
  } catch (err) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed !== null && typeof parsed === 'object') {
    const topKeys = Object.keys(parsed as Record<string, unknown>);
    if (topKeys.includes('__proto__') || topKeys.includes('constructor')) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Manifest must not contain a top-level "__proto__" or "constructor" key.',
      );
    }
  }
  const result = validateManifest(parsed);
  if (!result.valid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Invalid manifest: ${result.errors.join('; ')}`,
      { errors: result.errors },
    );
  }
  const isStack = result.format === 'stack';
  const serviceNames = isStack ? getServiceNames(parsed) : [];

  // customDomain / serviceName coherence (manifest-derived).
  let normalizedCustomDomain: string | undefined;
  if (spec.customDomain !== undefined) {
    normalizedCustomDomain = spec.customDomain.trim();
    if (normalizedCustomDomain === '') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'customDomain cannot be empty or whitespace-only',
      );
    }
    if (isStack) {
      if (!spec.serviceName) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'serviceName is required when setting customDomain on a stack lease; pick one of the service keys',
        );
      }
      if (!serviceNames.includes(spec.serviceName)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `serviceName "${spec.serviceName}" does not match any service. Available: ${serviceNames.join(', ')}`,
        );
      }
    } else if (spec.serviceName) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'serviceName must not be set on a single-service deployment (image+port or a single-service manifest); omit it — the custom domain attaches to the sole item',
      );
    }
  } else if (spec.serviceName !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'serviceName is only meaningful when customDomain is set',
    );
  }

  const address = await ctx.chain.getAddress();
  await ctx.chain.acquireRateLimit();
  // The passed `ctx` already satisfies ReadCtx (query/chain/logger), so the SKU
  // reads below consume it directly. The explicit acquireRateLimit above is
  // RETAINED for the still-positional resolveProviderUrl + LCD reads (P2).

  const manifestMetaHash = await metaHashHex(spec.manifest);

  // SKU resolution (ENG-258 #1).
  let skuUuid: string;
  let providerUuid: string;
  switch (spec.sku.kind) {
    case 'resolved':
      // Pre-resolved IDs are trusted verbatim: the chain's create-lease is the
      // authoritative validation (existence/active/provider) — re-querying here
      // would reject momentarily-inactive-but-valid pins and still not close the
      // TOCTOU window (design §4.3 + §6). Only guard against empty strings, which
      // would build a malformed `:1` lease item / misleading downstream error.
      if (
        spec.sku.skuUuid.trim() === '' ||
        spec.sku.providerUuid.trim() === ''
      ) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'sku.skuUuid and sku.providerUuid must both be non-empty for a pre-resolved (kind: "resolved") SKU selector',
        );
      }
      skuUuid = spec.sku.skuUuid;
      providerUuid = spec.sku.providerUuid;
      break;
    case 'byName': {
      const r = await resolveSku(ctx, {
        size: spec.sku.size,
        ...(spec.sku.providerUuid !== undefined
          ? { providerUuid: spec.sku.providerUuid }
          : {}),
        ...(spec.sku.skuUuid !== undefined
          ? { skuUuid: spec.sku.skuUuid }
          : {}),
      });
      skuUuid = r.skuUuid;
      providerUuid = r.providerUuid;
      break;
    }
    default: {
      const _exhaustive: never = spec.sku;
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Unknown sku selector: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }

  const leaseItems: string[] = isStack
    ? serviceNames.map((n) => `${skuUuid}:1:${n}`)
    : [`${skuUuid}:1`];

  // Storage on the SAME provider (ENG-258 #2).
  if (spec.storage) {
    const storage = await resolveSku(ctx, {
      size: spec.storage,
      providerUuid,
    });
    leaseItems.push(`${storage.skuUuid}:1`);
  }

  const providerUrl = await resolveProviderUrl(ctx, providerUuid);

  const overrides =
    callOptions.gasMultiplier !== undefined
      ? { gasMultiplier: callOptions.gasMultiplier }
      : undefined;
  logger.info(
    `[deploy] creating lease (meta_hash=${manifestMetaHash}, items=${leaseItems.length})`,
  );
  const leaseUuid = await createLease(
    ctx,
    { metaHashHex: manifestMetaHash, leaseItems },
    overrides,
  );
  logger.info(
    `[deploy] lease ${leaseUuid} created on provider ${providerUuid}`,
  );

  await callOptions.onLeaseCreated?.(leaseUuid, providerUrl);

  let step: 'set_domain' | 'upload' | 'poll' | undefined;
  let status: FredLeaseStatus;
  try {
    callOptions.abortSignal?.throwIfAborted();
    if (normalizedCustomDomain !== undefined) {
      step = 'set_domain';
      await setItemCustomDomain(
        { chain: ctx.chain, logger: ctx.logger },
        // leaseUuid is already a branded LeaseUuid (extractLeaseUuid → asLeaseUuid);
        // do NOT re-parse (parse-once, ENG-258). normalizedCustomDomain is trim-only
        // (genuinely unbranded), so parseFqdn brands + validates it here.
        {
          leaseUuid,
          customDomain: parseFqdn(normalizedCustomDomain),
          serviceName: spec.serviceName,
        },
        overrides,
      );
    }
    step = 'upload';
    const leaseDataToken = await ctx.providerAuth.leaseDataToken({
      address,
      leaseUuid,
      metaHashHex: manifestMetaHash,
    });
    await uploadLeaseData(
      providerUrl,
      leaseUuid,
      // Reuse the bytes computed for the size cap — same deterministic
      // UTF-8 encoding of the (immutable) input string, one fewer allocation.
      manifestBytes,
      leaseDataToken,
      ctx.fetch,
      callOptions.abortSignal,
      ctx.allowLoopback,
    );
    step = 'poll';
    status = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => ctx.providerAuth.providerToken({ address, leaseUuid }),
      { ...callOptions.pollOptions, abortSignal: callOptions.abortSignal },
      ctx.fetch,
      ctx.allowLoopback,
    );
  } catch (err) {
    // A chain-terminal state (rejected / closed / expired) is self-explanatory
    // and the chain has already cleared the lease, so `close_lease` is NOT the
    // remedy — re-throw with lease context and an honest breadcrumb rather than
    // the partial-success "close_lease" advice below.
    if (err instanceof TerminalChainStateError) {
      logger.warn(
        `[deploy] lease ${leaseUuid} reached a terminal chain state during deploy`,
      );
      throw err.withContext({
        lease_uuid: leaseUuid,
        providerUuid,
        providerUrl,
      });
    }
    // Wrap a post-create-lease failure as a partial-success error so callers
    // know the lease exists and must be cleaned up.
    logger.warn(
      `[deploy] lease ${leaseUuid} created but a subsequent step${step ? ` ('${step}')` : ''} failed; close_lease to clean up`,
    );
    // A deliberate cancellation (throwIfAborted, or an aborted upload/poll) is
    // a user action, not an infra fault — code it OPERATION_CANCELLED (which is
    // non-retryable by code, so a partial-success cancellation is never
    // blind-retried into a second lease). `abortSignal.aborted` is true in both
    // the pre-step throwIfAborted and the mid-flight-abort cases.
    const code = callOptions.abortSignal?.aborted
      ? ManifestMCPErrorCode.OPERATION_CANCELLED
      : err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.QUERY_FAILED;
    const base = err instanceof ManifestMCPError ? err.details : undefined;
    throw new ManifestMCPError(
      code,
      `Deploy partially succeeded: lease ${leaseUuid} was created but subsequent steps failed. ` +
        `Close this lease with close_lease if needed. Error: ${err instanceof Error ? err.message : String(err)}`,
      {
        ...base,
        partial: true,
        ...(step !== undefined && { failedStep: step }),
        lease_uuid: leaseUuid,
        provider_uuid: providerUuid,
        provider_url: providerUrl,
      },
    );
  }

  // Fetch connection info (best-effort) and assemble the success result. A
  // failure here is non-fatal: the lease is already active, so we surface the
  // error in `connectionError` rather than throwing.
  let connection: ConnectionDetails | undefined;
  let url: string | undefined;
  let connectionError: string | undefined;
  try {
    const authToken = await ctx.providerAuth.providerToken({
      address,
      leaseUuid,
    });
    const connResp = await getLeaseConnectionInfo(
      providerUrl,
      leaseUuid,
      authToken,
      ctx.fetch,
      ctx.allowLoopback,
    );
    connection = connResp.connection;
    if (connection.host && connection.ports) {
      const firstPort = Object.values(connection.ports)[0];
      if (typeof firstPort === 'number' || typeof firstPort === 'string') {
        url = `${connection.host}:${firstPort}`;
      }
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Log raw message to stderr for debugging; sanitize only the user-facing return value
    logger.error(
      `[deploy] Failed to fetch connection info for lease ${leaseUuid}: ${rawMsg}`,
    );
    connectionError = sanitizeForLogging(rawMsg) as string;
  }

  return {
    lease_uuid: leaseUuid, // already LeaseUuid — extractLeaseUuid brands it (requireUuid + asLeaseUuid)
    provider_uuid: asProviderUuid(providerUuid),
    provider_url: providerUrl,
    state: status.state,
    ...(url && { url }),
    ...(connection && { connection }),
    ...(connectionError && { connectionError }),
    // Reaching this return implies the set-domain tx (if requested)
    // succeeded — failures earlier in the try block throw and never
    // get here. Echo the trimmed canonical form, matching what the
    // chain stored.
    ...(normalizedCustomDomain && { custom_domain: normalizedCustomDomain }),
    ...(normalizedCustomDomain &&
      spec.serviceName && { service_name: spec.serviceName }),
  };
}
