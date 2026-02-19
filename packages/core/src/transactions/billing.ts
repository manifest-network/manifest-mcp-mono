import { SigningStargateClient } from '@cosmjs/stargate';
import { liftedinit } from '@manifest-network/manifestjs';
import { CosmosTxResult, ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { parseAmount, buildTxResult, parseBigInt, validateAddress, validateArgsLength, extractFlag, filterConsumedArgs, parseLeaseItem, requireArgs, parseHexBytes, MAX_META_HASH_BYTES } from './utils.js';
import { getSubcommandUsage, throwUnsupportedSubcommand } from '../modules.js';

const {
  MsgFundCredit, MsgCreateLease, MsgCloseLease, MsgWithdraw,
  MsgCreateLeaseForTenant, MsgAcknowledgeLease, MsgRejectLease, MsgCancelLease,
  MsgUpdateParams,
} = liftedinit.billing.v1;

/**
 * Route billing transaction to appropriate handler
 */
export async function routeBillingTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'billing transaction');

  switch (subcommand) {
    case 'fund-credit': {
      requireArgs(args, 2, ['tenant-address', 'amount'], 'billing fund-credit');
      const [tenant, amountStr] = args;
      validateAddress(tenant, 'tenant address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgFundCredit',
        value: MsgFundCredit.fromPartial({
          sender: senderAddress,
          tenant,
          amount: { denom, amount },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'fund-credit', result, waitForConfirmation);
    }

    case 'create-lease': {
      // Parse optional --meta-hash flag (can appear anywhere in args)
      const { value: metaHashHex, consumedIndices } = extractFlag(args, '--meta-hash', 'billing create-lease');
      const metaHash = metaHashHex ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES) : undefined;

      // Filter out --meta-hash and its value to get item args
      const itemArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(itemArgs, 1, ['sku-uuid:quantity[:service-name]'], 'billing create-lease');

      // Parse items (format: sku-uuid:quantity or sku-uuid:quantity:service-name)
      const items = itemArgs.map((arg) => parseLeaseItem(arg));

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgCreateLease',
        value: MsgCreateLease.fromPartial({
          tenant: senderAddress,
          items,
          metaHash: metaHash ?? new Uint8Array(),
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'create-lease', result, waitForConfirmation);
    }

    case 'close-lease': {
      // Parse optional --reason flag
      const { value: reason, consumedIndices } = extractFlag(args, '--reason', 'billing close-lease');
      const leaseArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(leaseArgs, 1, ['lease-uuid'], 'billing close-lease');

      // MsgCloseLease can close multiple leases at once
      const leaseUuids = leaseArgs;

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgCloseLease',
        value: MsgCloseLease.fromPartial({
          sender: senderAddress,
          leaseUuids,
          reason: reason ?? '',
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'close-lease', result, waitForConfirmation);
    }

    case 'withdraw': {
      requireArgs(args, 1, ['lease-uuid or --provider'], 'billing withdraw');

      // Extract flags
      const providerFlag = extractFlag(args, '--provider', 'billing withdraw');
      const limitFlag = extractFlag(args, '--limit', 'billing withdraw');

      let leaseUuids: string[] = [];
      let providerUuid = '';
      let limit = BigInt(0); // 0 means use default (50)

      if (providerFlag.value) {
        // Provider-wide withdrawal mode
        providerUuid = providerFlag.value;

        // Parse optional --limit flag (only valid with --provider)
        if (limitFlag.value) {
          limit = parseBigInt(limitFlag.value, 'limit');
          if (limit < BigInt(1) || limit > BigInt(100)) {
            throw new ManifestMCPError(
              ManifestMCPErrorCode.TX_FAILED,
              `Invalid limit: ${limit}. Must be between 1 and 100.`
            );
          }
        }

        // Check for any extra arguments that weren't consumed
        const allConsumed = [...providerFlag.consumedIndices, ...limitFlag.consumedIndices];
        const extraArgs = filterConsumedArgs(args, allConsumed);
        if (extraArgs.length > 0) {
          const usage = getSubcommandUsage('tx', 'billing', 'withdraw');
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Provider-wide withdrawal does not accept additional arguments. ` +
            `Got unexpected: ${extraArgs.map(a => `"${a}"`).join(', ')}. ` +
            `For lease-specific withdrawal, omit --provider flag. Usage: withdraw ${usage ?? '<args>'}`
          );
        }
      } else {
        // Lease-specific withdrawal mode
        // Check for unexpected flags (--limit without --provider is invalid)
        const unexpectedFlags = args.filter(arg => arg.startsWith('--'));
        if (unexpectedFlags.length > 0) {
          const usage = getSubcommandUsage('tx', 'billing', 'withdraw');
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Unexpected flag(s) in lease-specific withdrawal mode: ${unexpectedFlags.join(', ')}. ` +
            `Use --provider for provider-wide withdrawal. Usage: withdraw ${usage ?? '<args>'}`
          );
        }

        leaseUuids = args;
      }

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgWithdraw',
        value: MsgWithdraw.fromPartial({
          sender: senderAddress,
          leaseUuids,
          providerUuid,
          limit,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'withdraw', result, waitForConfirmation);
    }

    case 'create-lease-for-tenant': {
      // Parse optional --meta-hash flag
      const { value: metaHashHex, consumedIndices } = extractFlag(args, '--meta-hash', 'billing create-lease-for-tenant');
      const metaHash = metaHashHex ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES) : undefined;

      // Filter out --meta-hash and its value to get remaining args
      const remainingArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(remainingArgs, 2, ['tenant-address', 'sku-uuid:quantity[:service-name]'], 'billing create-lease-for-tenant');

      const [tenant, ...itemArgs] = remainingArgs;
      validateAddress(tenant, 'tenant address');

      // Parse items (format: sku-uuid:quantity or sku-uuid:quantity:service-name)
      const items = itemArgs.map((arg) => parseLeaseItem(arg));

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgCreateLeaseForTenant',
        value: MsgCreateLeaseForTenant.fromPartial({
          authority: senderAddress,
          tenant,
          items,
          metaHash: metaHash ?? new Uint8Array(),
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'create-lease-for-tenant', result, waitForConfirmation);
    }

    case 'acknowledge-lease': {
      requireArgs(args, 1, ['lease-uuid'], 'billing acknowledge-lease');
      const leaseUuids = args;

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgAcknowledgeLease',
        value: MsgAcknowledgeLease.fromPartial({
          sender: senderAddress,
          leaseUuids,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'acknowledge-lease', result, waitForConfirmation);
    }

    case 'reject-lease': {
      // Parse optional --reason flag
      const { value: reason, consumedIndices } = extractFlag(args, '--reason', 'billing reject-lease');
      const leaseArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(leaseArgs, 1, ['lease-uuid'], 'billing reject-lease');

      const leaseUuids = leaseArgs;

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgRejectLease',
        value: MsgRejectLease.fromPartial({
          sender: senderAddress,
          leaseUuids,
          reason: reason ?? '',
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'reject-lease', result, waitForConfirmation);
    }

    case 'cancel-lease': {
      requireArgs(args, 1, ['lease-uuid'], 'billing cancel-lease');
      const leaseUuids = args;

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgCancelLease',
        value: MsgCancelLease.fromPartial({
          tenant: senderAddress,
          leaseUuids,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'cancel-lease', result, waitForConfirmation);
    }

    case 'update-params': {
      requireArgs(args, 5, [
        'max-leases-per-tenant', 'max-items-per-lease', 'min-lease-duration',
        'max-pending-leases-per-tenant', 'pending-timeout',
      ], 'billing update-params');

      const [
        maxLeasesPerTenantStr, maxItemsPerLeaseStr, minLeaseDurationStr,
        maxPendingLeasesPerTenantStr, pendingTimeoutStr,
        ...allowedAddresses
      ] = args;

      for (const addr of allowedAddresses) {
        validateAddress(addr, 'allowed address');
      }

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgUpdateParams',
        value: MsgUpdateParams.fromPartial({
          authority: senderAddress,
          params: {
            maxLeasesPerTenant: parseBigInt(maxLeasesPerTenantStr, 'max-leases-per-tenant'),
            maxItemsPerLease: parseBigInt(maxItemsPerLeaseStr, 'max-items-per-lease'),
            minLeaseDuration: parseBigInt(minLeaseDurationStr, 'min-lease-duration'),
            maxPendingLeasesPerTenant: parseBigInt(maxPendingLeasesPerTenantStr, 'max-pending-leases-per-tenant'),
            pendingTimeout: parseBigInt(pendingTimeoutStr, 'pending-timeout'),
            allowedList: allowedAddresses,
          },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('billing', 'update-params', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'billing', subcommand);
  }
}
