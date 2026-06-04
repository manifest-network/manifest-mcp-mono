import type {
  CosmosClientManager,
  CosmosTxResult,
  LeaseState,
  ManifestQueryClient,
} from '@manifest-network/manifest-mcp-core';
import {
  cosmosTx,
  createPagination,
  logger,
  MAX_PAGE_LIMIT,
  ManifestMCPError,
  ManifestMCPErrorCode,
  requireUuid,
  sanitizeForLogging,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import type { FredLeaseStatus, PollOptions } from '../http/fred.js';
import { pollLeaseUntilReady, TerminalChainStateError } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
  uploadLeaseData,
} from '../http/provider.js';
import { getServiceNames, metaHashHex, validateManifest } from '../manifest.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export function extractLeaseUuid(txResult: CosmosTxResult): string {
  if (!txResult.events) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'No events in transaction result; cannot extract lease UUID',
    );
  }

  for (const event of txResult.events) {
    if (!event.type.includes('lease') && !event.type.includes('Lease'))
      continue;
    for (const attr of event.attributes) {
      if (attr.key === 'lease_uuid' || attr.key === 'uuid') {
        const raw = attr.value.replace(/^"|"$/g, '');
        // Validate the extracted value is a proper UUID
        requireUuid(
          { lease_uuid: raw },
          'lease_uuid',
          ManifestMCPErrorCode.TX_FAILED,
        );
        return raw;
      }
    }
  }

  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    'Could not find lease UUID in transaction events',
    { events: txResult.events as unknown as Record<string, unknown>[] },
  );
}

export async function findSkuUuid(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string,
): Promise<{ skuUuid: string; providerUuid: string }> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({
    activeOnly: true,
    pagination,
  });

  const named = result.skus.filter((s) => s.name === size);
  if (named.length > 0) {
    if (providerUuid === undefined) {
      return { skuUuid: named[0].uuid, providerUuid: named[0].providerUuid };
    }
    const onProvider = named.find((s) => s.providerUuid === providerUuid);
    if (onProvider) {
      return {
        skuUuid: onProvider.uuid,
        providerUuid: onProvider.providerUuid,
      };
    }
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `SKU tier "${size}" is not offered by provider ${providerUuid} (the provider selected for the compute tier). ` +
        `Provider(s) offering "${size}": ${named.map((s) => s.providerUuid).join(', ')}.`,
    );
  }

  const available = result.skus.map((s) => s.name);
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    `SKU tier "${size}" not found on any provider. Available: ${available.join(', ')}`,
  );
}

export interface DeployAppResult {
  readonly lease_uuid: string;
  readonly provider_uuid: string;
  readonly provider_url: string;
  readonly state: LeaseState;
  readonly url?: string;
  readonly connection?: ConnectionDetails;
  readonly connectionError?: string;
  /** Set when a `customDomain` was supplied AND the set-domain tx succeeded. */
  readonly custom_domain?: string;
  /** Set when a `serviceName` was supplied alongside a successful `customDomain` set. */
  readonly service_name?: string;
}

export type SkuSelector =
  | { kind: 'byName'; size: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };

export interface DeployManifestInput {
  manifest: string;
  sku: SkuSelector;
  storage?: string;
  customDomain?: string;
  serviceName?: string;
  gasMultiplier?: number;
  onLeaseCreated?: (
    leaseUuid: string,
    providerUrl: string,
  ) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

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
  input: DeployManifestInput,
  opts: DeployManifestOptions,
): Promise<DeployAppResult> {
  const { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn } = opts;

  const manifestBytes = new TextEncoder().encode(input.manifest);
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
    parsed = JSON.parse(input.manifest);
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
  if (input.customDomain !== undefined) {
    normalizedCustomDomain = input.customDomain.trim();
    if (normalizedCustomDomain === '') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'customDomain cannot be empty or whitespace-only',
      );
    }
    if (isStack) {
      if (!input.serviceName) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'serviceName is required when setting customDomain on a stack lease; pick one of the service keys',
        );
      }
      if (!serviceNames.includes(input.serviceName)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `serviceName "${input.serviceName}" does not match any service. Available: ${serviceNames.join(', ')}`,
        );
      }
    } else if (input.serviceName) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'serviceName must not be set on a single-service deployment (image+port or a single-service manifest); omit it — the custom domain attaches to the sole item',
      );
    }
  } else if (input.serviceName !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'serviceName is only meaningful when customDomain is set',
    );
  }

  const address = await clientManager.getAddress();
  await clientManager.acquireRateLimit();
  const queryClient = await clientManager.getQueryClient();

  const manifestMetaHash = await metaHashHex(input.manifest);

  // SKU resolution (ENG-258 #1).
  let skuUuid: string;
  let providerUuid: string;
  switch (input.sku.kind) {
    case 'resolved':
      // Pre-resolved IDs are trusted verbatim, so validate them at the boundary:
      // an empty skuUuid would build a malformed `:1` lease item and reach
      // create-lease, and an empty providerUuid fails later with a misleading
      // QUERY_FAILED. Reject early with an actionable INVALID_CONFIG instead.
      if (
        input.sku.skuUuid.trim() === '' ||
        input.sku.providerUuid.trim() === ''
      ) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'sku.skuUuid and sku.providerUuid must both be non-empty for a pre-resolved (kind: "resolved") SKU selector',
        );
      }
      skuUuid = input.sku.skuUuid;
      providerUuid = input.sku.providerUuid;
      break;
    case 'byName': {
      const r = await findSkuUuid(queryClient, input.sku.size);
      skuUuid = r.skuUuid;
      providerUuid = r.providerUuid;
      break;
    }
    default: {
      const _exhaustive: never = input.sku;
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
  if (input.storage) {
    const { skuUuid: storageSkuUuid } = await findSkuUuid(
      queryClient,
      input.storage,
      providerUuid,
    );
    leaseItems.push(`${storageSkuUuid}:1`);
  }

  const providerUrl = await resolveProviderUrl(queryClient, providerUuid);

  const overrides =
    input.gasMultiplier !== undefined
      ? { gasMultiplier: input.gasMultiplier }
      : undefined;
  logger.info(
    `[deploy] creating lease (meta_hash=${manifestMetaHash}, items=${leaseItems.length})`,
  );
  const txResult = await cosmosTx(
    clientManager,
    'billing',
    'create-lease',
    ['--meta-hash', manifestMetaHash, ...leaseItems],
    true,
    overrides,
  );
  const leaseUuid = extractLeaseUuid(txResult);
  logger.info(
    `[deploy] lease ${leaseUuid} created on provider ${providerUuid}`,
  );

  await input.onLeaseCreated?.(leaseUuid, providerUrl);

  let step: 'set_domain' | 'upload' | 'poll' | undefined;
  let status: FredLeaseStatus;
  try {
    input.abortSignal?.throwIfAborted();
    if (normalizedCustomDomain !== undefined) {
      step = 'set_domain';
      await setItemCustomDomain(
        clientManager,
        leaseUuid,
        normalizedCustomDomain,
        { serviceName: input.serviceName },
        overrides,
      );
    }
    step = 'upload';
    const leaseDataToken = await getLeaseDataAuthToken(
      address,
      leaseUuid,
      manifestMetaHash,
    );
    await uploadLeaseData(
      providerUrl,
      leaseUuid,
      // Reuse the bytes computed for the size cap — same deterministic
      // UTF-8 encoding of the (immutable) input string, one fewer allocation.
      manifestBytes,
      leaseDataToken,
      fetchFn,
      input.abortSignal,
    );
    step = 'poll';
    status = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => getAuthToken(address, leaseUuid),
      { ...input.pollOptions, abortSignal: input.abortSignal },
      fetchFn,
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
    const code = input.abortSignal?.aborted
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
    const authToken = await getAuthToken(address, leaseUuid);
    const connResp = await getLeaseConnectionInfo(
      providerUrl,
      leaseUuid,
      authToken,
      fetchFn,
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
    lease_uuid: leaseUuid,
    provider_uuid: providerUuid,
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
      input.serviceName && { service_name: input.serviceName }),
  };
}
