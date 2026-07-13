import type { SigningStargateClient, StdFee } from '@cosmjs/stargate';
import { liftedinit } from '@manifest-network/manifestjs';
import type { ManifestQueryClient } from '../client.js';
import { getSubcommandUsage, throwUnsupportedSubcommand } from '../modules.js';
import {
  type BuiltMessages,
  type CosmosTxResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxBuildContext,
  type TxOptions,
} from '../types.js';
import { DNS_LABEL_RE } from '../validation.js';
import {
  broadcastAndBuildTxResult,
  buildGasFee,
  extractBooleanFlag,
  extractFlag,
  extractRepeatedFlag,
  filterConsumedArgs,
  MAX_META_HASH_BYTES,
  parseAmount,
  parseBigInt,
  parseHexBytes,
  parseLeaseItem,
  requireArgs,
  validateAddress,
  validateArgsLength,
  validateMemo,
} from './utils.js';

const {
  MsgFundCredit,
  MsgCreateLease,
  MsgCloseLease,
  MsgWithdraw,
  MsgCreateLeaseForTenant,
  MsgAcknowledgeLease,
  MsgRejectLease,
  MsgCancelLease,
  MsgSetItemCustomDomain,
  MsgUpdateParams,
} = liftedinit.billing.v1;

/**
 * Build messages for a billing transaction subcommand (no signing/broadcasting).
 *
 * `context.currentBillingParams` is consulted by `update-params` so omitted
 * `allowedList` and `reservedDomainSuffixes` preserve their on-chain values
 * instead of being silently cleared. The public broadcast and estimate paths
 * (`cosmosTx`, `cosmosEstimateFee`) always fetch and supply this context for
 * `update-params` and fail fast with `QUERY_FAILED` if the params query
 * returns nothing — so the no-context branch below is only exercised by
 * direct callers of this builder (typically tests). Those callers see
 * explicit-only behaviour: any list field they did not supply is sent as
 * `[]`, which would clear the on-chain value.
 */
export function buildBillingMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
  context?: TxBuildContext,
): BuiltMessages {
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

      return { messages: [msg], memo: '' };
    }

    case 'create-lease': {
      // Parse optional --meta-hash flag (can appear anywhere in args)
      const { value: metaHashHex, consumedIndices } = extractFlag(
        args,
        '--meta-hash',
        'billing create-lease',
      );
      const metaHash = metaHashHex
        ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES)
        : undefined;

      // Filter out --meta-hash and its value to get item args
      const itemArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(
        itemArgs,
        1,
        ['sku-uuid:quantity[:service-name]'],
        'billing create-lease',
      );

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

      return { messages: [msg], memo: '' };
    }

    case 'close-lease': {
      // Parse optional --reason flag
      const { value: reason, consumedIndices } = extractFlag(
        args,
        '--reason',
        'billing close-lease',
      );
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

      return { messages: [msg], memo: '' };
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
              `Invalid limit: ${limit}. Must be between 1 and 100.`,
            );
          }
        }

        // Check for any extra arguments that weren't consumed
        const allConsumed = [
          ...providerFlag.consumedIndices,
          ...limitFlag.consumedIndices,
        ];
        const extraArgs = filterConsumedArgs(args, allConsumed);
        if (extraArgs.length > 0) {
          const usage = getSubcommandUsage('tx', 'billing', 'withdraw');
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Provider-wide withdrawal does not accept additional arguments. ` +
              `Got unexpected: ${extraArgs.map((a) => `"${a}"`).join(', ')}. ` +
              `For lease-specific withdrawal, omit --provider flag. Usage: withdraw ${usage ?? '<args>'}`,
          );
        }
      } else {
        // Lease-specific withdrawal mode
        // Check for unexpected flags (--limit without --provider is invalid)
        const unexpectedFlags = args.filter((arg) => arg.startsWith('--'));
        if (unexpectedFlags.length > 0) {
          const usage = getSubcommandUsage('tx', 'billing', 'withdraw');
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Unexpected flag(s) in lease-specific withdrawal mode: ${unexpectedFlags.join(', ')}. ` +
              `Use --provider for provider-wide withdrawal. Usage: withdraw ${usage ?? '<args>'}`,
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

      return { messages: [msg], memo: '' };
    }

    case 'create-lease-for-tenant': {
      // Parse optional --meta-hash flag
      const { value: metaHashHex, consumedIndices } = extractFlag(
        args,
        '--meta-hash',
        'billing create-lease-for-tenant',
      );
      const metaHash = metaHashHex
        ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES)
        : undefined;

      // Filter out --meta-hash and its value to get remaining args
      const remainingArgs = filterConsumedArgs(args, consumedIndices);
      requireArgs(
        remainingArgs,
        2,
        ['tenant-address', 'sku-uuid:quantity[:service-name]'],
        'billing create-lease-for-tenant',
      );

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

      return { messages: [msg], memo: '' };
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

      return { messages: [msg], memo: '' };
    }

    case 'reject-lease': {
      // Parse optional --reason flag
      const { value: reason, consumedIndices } = extractFlag(
        args,
        '--reason',
        'billing reject-lease',
      );
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

      return { messages: [msg], memo: '' };
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

      return { messages: [msg], memo: '' };
    }

    case 'update-params': {
      // List-typed Params fields default to "preserve" so that callers who
      // only want to bump the numeric fields don't accidentally wipe the
      // on-chain allowed_list or reserved_domain_suffixes (MsgUpdateParams
      // overwrites the full Params struct). Explicit `--clear-*` flags opt
      // out of preservation; passing values opts in to overwrite.
      const reservedSuffixFlag = extractRepeatedFlag(
        args,
        '--reserved-suffix',
        'billing update-params',
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      const clearReserved = extractBooleanFlag(
        filterConsumedArgs(args, reservedSuffixFlag.consumedIndices),
        '--clear-reserved-suffixes',
      );
      const clearAllowed = extractBooleanFlag(
        clearReserved.remainingArgs,
        '--clear-allowed-list',
      );
      const positional = clearAllowed.remainingArgs;

      requireArgs(
        positional,
        5,
        [
          'max-leases-per-tenant',
          'max-items-per-lease',
          'min-lease-duration',
          'max-pending-leases-per-tenant',
          'pending-timeout',
        ],
        'billing update-params',
      );

      const [
        maxLeasesPerTenantStr,
        maxItemsPerLeaseStr,
        minLeaseDurationStr,
        maxPendingLeasesPerTenantStr,
        pendingTimeoutStr,
        ...allowedAddresses
      ] = positional;

      for (const addr of allowedAddresses) {
        validateAddress(addr, 'allowed address');
      }

      if (reservedSuffixFlag.values.length > 0 && clearReserved.value) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'billing update-params: --reserved-suffix and --clear-reserved-suffixes are mutually exclusive.',
        );
      }
      if (allowedAddresses.length > 0 && clearAllowed.value) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'billing update-params: positional <allowed-address> values and --clear-allowed-list are mutually exclusive.',
        );
      }

      // Resolve list fields with preserve-by-default semantics.
      const currentParams = context?.currentBillingParams;
      let reservedDomainSuffixes: string[];
      if (reservedSuffixFlag.values.length > 0) {
        reservedDomainSuffixes = reservedSuffixFlag.values;
      } else if (clearReserved.value) {
        reservedDomainSuffixes = [];
      } else {
        reservedDomainSuffixes = currentParams?.reservedDomainSuffixes
          ? [...currentParams.reservedDomainSuffixes]
          : [];
      }

      let allowedList: string[];
      if (allowedAddresses.length > 0) {
        allowedList = allowedAddresses;
      } else if (clearAllowed.value) {
        allowedList = [];
      } else {
        allowedList = currentParams?.allowedList
          ? [...currentParams.allowedList]
          : [];
      }

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgUpdateParams',
        value: MsgUpdateParams.fromPartial({
          authority: senderAddress,
          // Spread `currentParams` first so any future Params field the
          // codegen and chain agree on is preserved by default; explicit
          // overrides win. Note: `fromPartial` only copies fields the
          // codegen knows about, so this defends the version-aligned case
          // (manifestjs upgraded ahead of new chain fields) but cannot help
          // a stale client whose codegen lacks the new field — keep
          // manifestjs in sync with manifest-ledger to stay safe.
          params: {
            ...(currentParams ?? {}),
            maxLeasesPerTenant: parseBigInt(
              maxLeasesPerTenantStr,
              'max-leases-per-tenant',
            ),
            maxItemsPerLease: parseBigInt(
              maxItemsPerLeaseStr,
              'max-items-per-lease',
            ),
            minLeaseDuration: parseBigInt(
              minLeaseDurationStr,
              'min-lease-duration',
            ),
            maxPendingLeasesPerTenant: parseBigInt(
              maxPendingLeasesPerTenantStr,
              'max-pending-leases-per-tenant',
            ),
            pendingTimeout: parseBigInt(pendingTimeoutStr, 'pending-timeout'),
            allowedList,
            reservedDomainSuffixes,
          },
        }),
      };

      return { messages: [msg], memo: '' };
    }

    case 'set-item-custom-domain': {
      const serviceNameFlag = extractFlag(
        args,
        '--service-name',
        'billing set-item-custom-domain',
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      const afterServiceName = filterConsumedArgs(
        args,
        serviceNameFlag.consumedIndices,
      );
      const clearFlag = extractBooleanFlag(afterServiceName, '--clear');
      const clearing = clearFlag.value;
      const positional = clearFlag.remainingArgs;

      const expected = clearing ? 1 : 2;
      requireArgs(
        positional,
        expected,
        clearing ? ['lease-uuid'] : ['lease-uuid', 'custom-domain'],
        'billing set-item-custom-domain',
      );
      if (positional.length > expected) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          clearing
            ? `Cannot combine --clear with a positional <custom-domain> in billing set-item-custom-domain. ` +
                `Pass either <lease-uuid> <custom-domain> to set, or <lease-uuid> --clear to clear. ` +
                `Got unexpected positional arg(s): ${positional
                  .slice(expected)
                  .map((a) => `"${a}"`)
                  .join(', ')}.`
            : `billing set-item-custom-domain accepts at most 2 positional arguments. ` +
                `Got unexpected positional arg(s): ${positional
                  .slice(expected)
                  .map((a) => `"${a}"`)
                  .join(', ')}.`,
        );
      }

      const [leaseUuid, customDomainArg] = positional;
      if (
        !clearing &&
        (customDomainArg === undefined || customDomainArg.trim() === '')
      ) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'billing set-item-custom-domain: <custom-domain> cannot be empty. ' +
            'Pass a non-empty FQDN to set, or use --clear to remove the existing domain.',
        );
      }
      // Canonicalize: trim before assigning to MsgSetItemCustomDomain so a
      // direct `cosmos_tx` caller (`<uuid> ' app.example.com '`) ships
      // trimmed bytes to the chain. This stringly transport path is its own
      // validation boundary, so it normalizes here. The typed
      // `setItemCustomDomain` helper does NOT re-trim — it receives an
      // already-normalized branded `Fqdn` (parse-once via `parseFqdn` at the
      // typed boundary).
      const customDomain = clearing ? '' : customDomainArg.trim();

      const serviceName = serviceNameFlag.value ?? '';
      if (serviceName !== '' && !DNS_LABEL_RE.test(serviceName)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid service name: "${serviceName}". Must be a valid RFC 1123 DNS label: ` +
            `1-63 lowercase alphanumeric characters or hyphens, must not start or end with a hyphen.`,
        );
      }

      const msg = {
        typeUrl: '/liftedinit.billing.v1.MsgSetItemCustomDomain',
        value: MsgSetItemCustomDomain.fromPartial({
          sender: senderAddress,
          leaseUuid,
          serviceName,
          customDomain,
        }),
      };

      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'billing', subcommand);
  }
}

/**
 * Route billing transaction to appropriate handler
 */
export async function routeBillingTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
  context?: TxBuildContext,
  txExtras?: { readonly fee?: StdFee; readonly memo?: string },
): Promise<CosmosTxResult> {
  const built = buildBillingMessages(senderAddress, subcommand, args, context);
  const effectiveMemo = txExtras?.memo ?? built.memo;
  validateMemo(effectiveMemo); // utils.ts (MAX_MEMO_LENGTH=256 → TX_FAILED)
  // FEE-WINS: an explicit fee skips buildGasFee/simulate entirely (the only no-gasPrice-valid path).
  const fee =
    txExtras?.fee !== undefined
      ? txExtras.fee
      : await buildGasFee(
          client,
          senderAddress,
          built.messages,
          options,
          effectiveMemo,
        );
  return broadcastAndBuildTxResult(
    client,
    'billing',
    built.canonicalSubcommand ?? subcommand,
    senderAddress,
    built.messages,
    fee,
    effectiveMemo, // SAME memo bytes the simulate leg used
    waitForConfirmation,
  );
}

/**
 * Load the on-chain `Params` required to build a `MsgUpdateParams` that
 * preserves un-overridden list fields. Registered as the `update-params`
 * context loader on `TX_MODULES.billing`.
 *
 * Throws `QUERY_FAILED` when the chain returns an empty `params` field —
 * silently falling back to defaults would let the builder send `[]` for
 * `allowedList` / `reservedDomainSuffixes` and clear the on-chain state,
 * which is exactly the bug preserve-by-default exists to prevent.
 */
export async function loadBillingUpdateParamsContext(
  queryClient: ManifestQueryClient,
): Promise<TxBuildContext> {
  const result = await queryClient.liftedinit.billing.v1.params({});
  if (!result.params) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'Failed to load current billing params: response.params was empty.',
    );
  }
  return { currentBillingParams: result.params };
}
