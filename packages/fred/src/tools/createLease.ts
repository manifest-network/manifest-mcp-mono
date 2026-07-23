import {
  asLeaseUuid,
  type CosmosClientManager,
  type CosmosTxResult,
  cosmosTx,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
  requireUuid,
  type TxOverrides,
} from '@manifest-network/manifest-mcp-core';

/**
 * Extract the (branded) lease UUID from a create-lease tx result's events.
 * Moved here from deployManifest so both deploy and restore share one path.
 */
export function extractLeaseUuid(txResult: CosmosTxResult): LeaseUuid {
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
        return asLeaseUuid(raw);
      }
    }
  }

  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    'Could not find lease UUID in transaction events',
    { events: txResult.events as unknown as Record<string, unknown>[] },
  );
}

/**
 * Broadcast a `billing create-lease` tx and return the new lease's branded UUID.
 * The single create-lease path shared by deployManifest (ENG-599) and restoreApp.
 * `leaseItems` are `skuUuid:quantity[:serviceName]` args; `metaHashHex` is the
 * hex-encoded manifest meta hash (a fresh hash for deploy, the source lease's
 * on-chain metaHash for restore).
 */
export async function createLease(
  ctx: { chain: CosmosClientManager },
  args: { metaHashHex: string; leaseItems: string[] },
  overrides?: TxOverrides,
): Promise<LeaseUuid> {
  const txResult = await cosmosTx(
    ctx.chain,
    'billing',
    'create-lease',
    ['--meta-hash', args.metaHashHex, ...args.leaseItems],
    true,
    overrides,
  );
  return extractLeaseUuid(txResult);
}
