import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxOverrides,
} from '../types.js';

/**
 * Options accepted by `setItemCustomDomain`.
 *
 * - `serviceName` addresses a specific item inside a stack lease (RFC 1123
 *   DNS label). Omit for a 1-item legacy lease. The chain validates the
 *   label; the underlying CLI builder also rejects malformed values
 *   client-side before broadcast.
 * - `clear` is mutually exclusive with a non-empty `customDomain`. Setting
 *   it to `true` instructs the helper to broadcast a clear of the existing
 *   domain; passing `false` (or omitting it) instructs a set, which then
 *   requires `customDomain` to be non-empty.
 */
export interface SetItemCustomDomainOptions {
  readonly serviceName?: string;
  readonly clear?: boolean;
}

export interface SetItemCustomDomainResult {
  readonly lease_uuid: string;
  readonly service_name: string;
  readonly custom_domain: string;
  readonly transactionHash: string;
  readonly code: number;
}

/**
 * Set or clear the `custom_domain` on a billing lease item via
 * `MsgSetItemCustomDomain`. Mirrors the `set_item_custom_domain` MCP tool's
 * input contract so library consumers and MCP clients see consistent
 * validation:
 *
 * - `customDomain` is rejected (`TX_FAILED`) when non-empty and `options.clear`
 *   is also true (mutual exclusion), or when empty/whitespace-only and
 *   `options.clear` is not true (silent on-chain clear is what
 *   preserve-by-default exists to prevent).
 * - The chain validates FQDN format and reserved-suffix rules; the helper
 *   does not duplicate that check.
 *
 * Authorised signers per `MsgSetItemCustomDomain.ValidateBasic`: the lease
 * tenant, the module authority, or any address in `params.allowed_list`.
 */
export async function setItemCustomDomain(
  clientManager: CosmosClientManager,
  leaseUuid: string,
  customDomain: string,
  options?: SetItemCustomDomainOptions,
  overrides?: TxOverrides,
): Promise<SetItemCustomDomainResult> {
  const clearing = options?.clear === true;
  if (clearing && customDomain.trim() !== '') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'setItemCustomDomain: pass either customDomain to set, or options.clear = true to clear, not both.',
    );
  }
  if (!clearing && customDomain.trim() === '') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'setItemCustomDomain: customDomain cannot be empty when not clearing. ' +
        'Pass a non-empty FQDN, or set options.clear = true to remove the existing domain.',
    );
  }

  const args: string[] = [leaseUuid];
  if (clearing) {
    args.push('--clear');
  } else {
    args.push(customDomain);
  }
  if (options?.serviceName) {
    args.push('--service-name', options.serviceName);
  }

  const result = await cosmosTx(
    clientManager,
    'billing',
    'set-item-custom-domain',
    args,
    true,
    overrides,
  );

  return {
    lease_uuid: leaseUuid,
    service_name: options?.serviceName ?? '',
    custom_domain: clearing ? '' : customDomain,
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
