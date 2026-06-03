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
import type { PollOptions } from '../http/fred.js';
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
