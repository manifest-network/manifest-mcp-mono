import { SigningStargateClient } from '@cosmjs/stargate';
import { liftedinit } from '@manifest-network/manifestjs';
import { CosmosTxResult, ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { parseAmount, buildTxResult, validateAddress, validateArgsLength, extractFlag, filterConsumedArgs, requireArgs, parseHexBytes, MAX_META_HASH_BYTES } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

const {
  MsgCreateProvider, MsgUpdateProvider, MsgDeactivateProvider,
  MsgCreateSKU, MsgUpdateSKU, MsgDeactivateSKU,
  MsgUpdateParams,
  Unit,
} = liftedinit.sku.v1;

/**
 * Parse a unit string to the Unit enum value.
 * Accepts 'per-hour' or 'per-day'.
 */
function parseUnit(value: string): number {
  switch (value.toLowerCase()) {
    case 'per-hour':
      return Unit.UNIT_PER_HOUR;
    case 'per-day':
      return Unit.UNIT_PER_DAY;
    default:
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid unit: "${value}". Expected "per-hour" or "per-day".`
      );
  }
}

/**
 * Parse a boolean string ('true' or 'false').
 */
function parseBooleanString(value: string, fieldName: string): boolean {
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `Invalid ${fieldName}: "${value}". Expected "true" or "false".`
  );
}

/**
 * Route SKU transaction to appropriate handler
 */
export async function routeSkuTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'sku transaction');

  switch (subcommand) {
    case 'create-provider': {
      // Parse optional --meta-hash flag
      const { value: metaHashHex, consumedIndices } = extractFlag(args, '--meta-hash', 'sku create-provider');
      const metaHash = metaHashHex ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES) : new Uint8Array();
      const positionalArgs = filterConsumedArgs(args, consumedIndices);

      requireArgs(positionalArgs, 3, ['address', 'payout-address', 'api-url'], 'sku create-provider');
      const [address, payoutAddress, apiUrl] = positionalArgs;
      validateAddress(address, 'address');
      validateAddress(payoutAddress, 'payout address');

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgCreateProvider',
        value: MsgCreateProvider.fromPartial({
          authority: senderAddress,
          address,
          payoutAddress,
          metaHash,
          apiUrl,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'create-provider', result, waitForConfirmation);
    }

    case 'update-provider': {
      // Parse optional flags
      const metaHashFlag = extractFlag(args, '--meta-hash', 'sku update-provider');
      const activeFlag = extractFlag(args, '--active', 'sku update-provider');
      const allConsumed = [...metaHashFlag.consumedIndices, ...activeFlag.consumedIndices];
      const positionalArgs = filterConsumedArgs(args, allConsumed);

      requireArgs(positionalArgs, 4, ['provider-uuid', 'address', 'payout-address', 'api-url'], 'sku update-provider');
      const [uuid, address, payoutAddress, apiUrl] = positionalArgs;
      validateAddress(address, 'address');
      validateAddress(payoutAddress, 'payout address');

      const metaHash = metaHashFlag.value ? parseHexBytes(metaHashFlag.value, 'meta-hash', MAX_META_HASH_BYTES) : new Uint8Array();
      const active = activeFlag.value ? parseBooleanString(activeFlag.value, 'active') : true;

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgUpdateProvider',
        value: MsgUpdateProvider.fromPartial({
          authority: senderAddress,
          uuid,
          address,
          payoutAddress,
          metaHash,
          active,
          apiUrl,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'update-provider', result, waitForConfirmation);
    }

    case 'deactivate-provider': {
      requireArgs(args, 1, ['provider-uuid'], 'sku deactivate-provider');
      const [uuid] = args;

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgDeactivateProvider',
        value: MsgDeactivateProvider.fromPartial({
          authority: senderAddress,
          uuid,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'deactivate-provider', result, waitForConfirmation);
    }

    case 'create-sku': {
      // Parse optional --meta-hash flag
      const { value: metaHashHex, consumedIndices } = extractFlag(args, '--meta-hash', 'sku create-sku');
      const metaHash = metaHashHex ? parseHexBytes(metaHashHex, 'meta-hash', MAX_META_HASH_BYTES) : new Uint8Array();
      const positionalArgs = filterConsumedArgs(args, consumedIndices);

      requireArgs(positionalArgs, 4, ['provider-uuid', 'name', 'unit', 'base-price'], 'sku create-sku');
      const [providerUuid, name, unitStr, basePriceStr] = positionalArgs;

      const unit = parseUnit(unitStr);
      const { amount, denom } = parseAmount(basePriceStr);

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgCreateSKU',
        value: MsgCreateSKU.fromPartial({
          authority: senderAddress,
          providerUuid,
          name,
          unit,
          basePrice: { denom, amount },
          metaHash,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'create-sku', result, waitForConfirmation);
    }

    case 'update-sku': {
      // Parse optional flags
      const metaHashFlag = extractFlag(args, '--meta-hash', 'sku update-sku');
      const activeFlag = extractFlag(args, '--active', 'sku update-sku');
      const allConsumed = [...metaHashFlag.consumedIndices, ...activeFlag.consumedIndices];
      const positionalArgs = filterConsumedArgs(args, allConsumed);

      requireArgs(positionalArgs, 5, ['sku-uuid', 'provider-uuid', 'name', 'unit', 'base-price'], 'sku update-sku');
      const [uuid, providerUuid, name, unitStr, basePriceStr] = positionalArgs;

      const unit = parseUnit(unitStr);
      const { amount, denom } = parseAmount(basePriceStr);
      const metaHash = metaHashFlag.value ? parseHexBytes(metaHashFlag.value, 'meta-hash', MAX_META_HASH_BYTES) : new Uint8Array();
      const active = activeFlag.value ? parseBooleanString(activeFlag.value, 'active') : true;

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgUpdateSKU',
        value: MsgUpdateSKU.fromPartial({
          authority: senderAddress,
          uuid,
          providerUuid,
          name,
          unit,
          basePrice: { denom, amount },
          metaHash,
          active,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'update-sku', result, waitForConfirmation);
    }

    case 'deactivate-sku': {
      requireArgs(args, 1, ['sku-uuid'], 'sku deactivate-sku');
      const [uuid] = args;

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgDeactivateSKU',
        value: MsgDeactivateSKU.fromPartial({
          authority: senderAddress,
          uuid,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'deactivate-sku', result, waitForConfirmation);
    }

    case 'update-params': {
      requireArgs(args, 1, ['allowed-address'], 'sku update-params');
      for (const addr of args) {
        validateAddress(addr, 'allowed address');
      }

      const msg = {
        typeUrl: '/liftedinit.sku.v1.MsgUpdateParams',
        value: MsgUpdateParams.fromPartial({
          authority: senderAddress,
          params: {
            allowedList: args,
          },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('sku', 'update-params', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'sku', subcommand);
  }
}
