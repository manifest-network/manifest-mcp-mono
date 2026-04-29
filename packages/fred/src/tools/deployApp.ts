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
} from '@manifest-network/manifest-mcp-core';
import type { FredLeaseStatus, PollOptions } from '../http/fred.js';
import { pollLeaseUntilReady, TerminalChainStateError } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
  uploadLeaseData,
} from '../http/provider.js';
import {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  metaHashHex,
  validateServiceName,
} from '../manifest.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

function extractLeaseUuid(txResult: CosmosTxResult): string {
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

async function findSkuUuid(
  queryClient: ManifestQueryClient,
  size: string,
): Promise<{ skuUuid: string; providerUuid: string }> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({
    activeOnly: true,
    pagination,
  });

  for (const sku of result.skus) {
    if (sku.name === size) {
      return { skuUuid: sku.uuid, providerUuid: sku.providerUuid };
    }
  }

  const available = result.skus.map((s) => s.name);
  throw new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `SKU tier "${size}" not found. Available: ${available.join(', ')}`,
  );
}

export interface ServiceConfig {
  image: string;
  ports?: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  depends_on?: Record<string, { condition: string }>;
  expose?: string[];
  labels?: Record<string, string>;
}

export interface DeployAppInput {
  image?: string;
  port?: number;
  size: string;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  storage?: string;
  depends_on?: Record<string, { condition: string }>;
  services?: Record<string, ServiceConfig>;
  gasMultiplier?: number;
  /** Fires once after the create-lease TX confirms, before upload/poll. Awaited. Errors propagate. */
  onLeaseCreated?: (
    leaseUuid: string,
    providerUrl: string,
  ) => void | Promise<void>;
  /** Aborts upload and poll (not the already-submitted chain TX). */
  abortSignal?: AbortSignal;
  /** Forwarded to the internal pollLeaseUntilReady call. abortSignal is the top-level field above. */
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

export interface DeployAppResult {
  readonly lease_uuid: string;
  readonly provider_uuid: string;
  readonly provider_url: string;
  readonly state: LeaseState;
  readonly url?: string;
  readonly connection?: ConnectionDetails;
  readonly connectionError?: string;
}

export async function deployApp(
  clientManager: CosmosClientManager,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ) => Promise<string>,
  input: DeployAppInput,
  fetchFn?: typeof globalThis.fetch,
): Promise<DeployAppResult> {
  // Validate mutually exclusive inputs
  if (input.image && input.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'image and services are mutually exclusive',
    );
  }
  if (!input.image && !input.services) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'either image or services is required',
    );
  }
  if (input.image && !input.port) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'port is required when using image',
    );
  }

  const address = await clientManager.getAddress();
  await clientManager.acquireRateLimit();
  const queryClient = await clientManager.getQueryClient();

  // 1. Build manifest
  let manifestJson: string;
  if (input.services) {
    for (const name of Object.keys(input.services)) {
      if (!validateServiceName(name)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid service name: "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`,
        );
      }
    }

    const services: Record<string, BuildManifestOptions> = {};
    for (const [name, svc] of Object.entries(input.services)) {
      services[name] = {
        image: svc.image,
        ports: svc.ports ?? {},
        env: svc.env,
        command: svc.command,
        args: svc.args,
        user: svc.user,
        tmpfs: svc.tmpfs,
        health_check: svc.health_check,
        stop_grace_period: svc.stop_grace_period,
        depends_on: svc.depends_on,
        expose: svc.expose,
        labels: svc.labels,
      };
    }
    manifestJson = JSON.stringify(buildStackManifest({ services }));
  } else {
    // image is guaranteed defined here: the guard above ensures !image && !services is false,
    // and the if-branch handles the services case. TypeScript can't narrow across if/else.
    const image = input.image as string;
    manifestJson = JSON.stringify(
      buildManifest({
        image,
        ports: { [`${input.port}/tcp`]: {} },
        env: input.env,
        command: input.command,
        args: input.args,
        user: input.user,
        tmpfs: input.tmpfs,
        health_check: input.health_check,
        stop_grace_period: input.stop_grace_period,
        init: input.init,
        expose: input.expose,
        labels: input.labels,
        depends_on: input.depends_on,
      }),
    );
  }

  // 2. SHA-256 hash of manifest (must match `meta_hash` recorded on-chain).
  const manifestMetaHash = await metaHashHex(manifestJson);

  // 3. Find matching SKU(s)
  const { skuUuid, providerUuid } = await findSkuUuid(queryClient, input.size);

  let leaseItems: string[];
  if (input.services) {
    const serviceNames = Object.keys(input.services);
    leaseItems = serviceNames.map((name) => `${skuUuid}:1:${name}`);
  } else {
    leaseItems = [`${skuUuid}:1`];
  }

  if (input.storage) {
    const { skuUuid: storageSkuUuid } = await findSkuUuid(
      queryClient,
      input.storage,
    );
    leaseItems.push(`${storageSkuUuid}:1`);
  }

  // 4. Get provider URL
  const providerUrl = await resolveProviderUrl(queryClient, providerUuid);

  // 5. Create lease
  const overrides =
    input.gasMultiplier !== undefined
      ? { gasMultiplier: input.gasMultiplier }
      : undefined;
  const txResult = await cosmosTx(
    clientManager,
    'billing',
    'create-lease',
    ['--meta-hash', manifestMetaHash, ...leaseItems],
    true,
    overrides,
  );

  // 6. Extract lease UUID
  const leaseUuid = extractLeaseUuid(txResult);

  // Outside the partial-success try: callback errors surface raw, not wrapped.
  // The lease exists on-chain regardless of abortSignal state — always notify.
  await input.onLeaseCreated?.(leaseUuid, providerUrl);

  let status: FredLeaseStatus;
  try {
    input.abortSignal?.throwIfAborted();

    // 7. Upload manifest with lease-data auth token
    const leaseDataToken = await getLeaseDataAuthToken(
      address,
      leaseUuid,
      manifestMetaHash,
    );
    await uploadLeaseData(
      providerUrl,
      leaseUuid,
      new TextEncoder().encode(manifestJson),
      leaseDataToken,
      fetchFn,
      input.abortSignal,
    );

    // 8. Poll until ready
    status = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => getAuthToken(address, leaseUuid),
      { ...input.pollOptions, abortSignal: input.abortSignal },
      fetchFn,
    );
  } catch (err) {
    // Chain-terminal states are self-explanatory and need no "close this lease"
    // advice (the lease is already terminal on-chain). Let Barney & friends
    // observe the typed error directly via `instanceof` / `err.chainState`.
    // withContext preserves the original stack (debugging points at the poll,
    // not at this catch) while attaching deployApp's provider context so
    // callers don't need to re-query the chain to recover it.
    if (err instanceof TerminalChainStateError) {
      throw err.withContext({ providerUuid, providerUrl });
    }
    const code =
      err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.QUERY_FAILED;
    const details =
      err instanceof ManifestMCPError
        ? {
            ...err.details,
            lease_uuid: leaseUuid,
            provider_uuid: providerUuid,
            provider_url: providerUrl,
          }
        : {
            lease_uuid: leaseUuid,
            provider_uuid: providerUuid,
            provider_url: providerUrl,
          };
    throw new ManifestMCPError(
      code,
      `Deploy partially succeeded: lease ${leaseUuid} was created but subsequent steps failed. ` +
        `Close this lease with close_lease if needed. Error: ${err instanceof Error ? err.message : String(err)}`,
      details,
    );
  }

  // 9. Get connection info (best-effort)
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
      `[deploy_app] Failed to fetch connection info for lease ${leaseUuid}: ${rawMsg}`,
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
  };
}
