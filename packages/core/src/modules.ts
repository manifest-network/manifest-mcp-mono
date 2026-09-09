import type { SigningStargateClient, StdFee } from '@cosmjs/stargate';
import type { ManifestQueryClient } from './client.js';
import { routeAuthQuery } from './queries/auth.js';
import { routeAuthzQuery } from './queries/authz.js';

// Import query handlers
import { routeBankQuery } from './queries/bank.js';
import { routeBillingQuery } from './queries/billing.js';
import { routeDistributionQuery } from './queries/distribution.js';
import { routeFeegrantQuery } from './queries/feegrant.js';
import { routeGovQuery } from './queries/gov.js';
import { routeGroupQuery } from './queries/group.js';
import { routeIbcTransferQuery } from './queries/ibc-transfer.js';
import { routeMintQuery } from './queries/mint.js';
import { routePoAQuery } from './queries/poa.js';
import { routeSkuQuery } from './queries/sku.js';
import { routeStakingQuery } from './queries/staking.js';
import { routeTokenfactoryQuery } from './queries/tokenfactory.js';
import { routeWasmQuery } from './queries/wasm.js';
// Import transaction handlers
import {
  buildAuthzMessages,
  routeAuthzTransaction,
} from './transactions/authz.js';
import {
  buildBankMessages,
  routeBankTransaction,
} from './transactions/bank.js';
import {
  buildBillingMessages,
  loadBillingUpdateParamsContext,
  routeBillingTransaction,
} from './transactions/billing.js';
import {
  buildDistributionMessages,
  routeDistributionTransaction,
} from './transactions/distribution.js';
import {
  buildFeegrantMessages,
  routeFeegrantTransaction,
} from './transactions/feegrant.js';
import { buildGovMessages, routeGovTransaction } from './transactions/gov.js';
import {
  buildGroupMessages,
  routeGroupTransaction,
} from './transactions/group.js';
import {
  buildIbcTransferMessages,
  routeIbcTransferTransaction,
} from './transactions/ibc-transfer.js';
import {
  buildManifestMessages,
  routeManifestTransaction,
} from './transactions/manifest.js';
import { buildPoAMessages, routePoATransaction } from './transactions/poa.js';
import { buildSkuMessages, routeSkuTransaction } from './transactions/sku.js';
import {
  buildStakingMessages,
  routeStakingTransaction,
} from './transactions/staking.js';
import {
  buildTokenfactoryMessages,
  routeTokenfactoryTransaction,
} from './transactions/tokenfactory.js';
import {
  buildWasmMessages,
  routeWasmTransaction,
} from './transactions/wasm.js';
import {
  type BuiltMessages,
  type CosmosTxResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type QueryResult,
  type TxBuildContext,
  type TxOptions,
} from './types.js';

/**
 * Handler function type for query modules
 */
export type QueryHandler = (
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
) => Promise<QueryResult>;

/**
 * Handler function type for transaction modules.
 *
 * `context` carries optional read-only chain state (currently the on-chain
 * billing Params) for handlers that must merge against existing values to
 * preserve fields the caller did not explicitly set. Most handlers ignore it.
 *
 * `txExtras` carries optional caller-supplied broadcast overrides — an explicit
 * `fee` (skips simulation; mutually exclusive with `options.gasMultiplier`) and
 * a `memo` fed to both the simulate and broadcast legs. The trailing param is
 * optional so the ~13 handlers that don't consume it stay assignable.
 */
export type TxHandler = (
  signingClient: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
  context?: TxBuildContext,
  txExtras?: { readonly fee?: StdFee; readonly memo?: string },
) => Promise<CosmosTxResult>;

/**
 * Pure synchronous function type for building transaction messages.
 * Used by `cosmosEstimateFee` to obtain `EncodeObject[]` without signing/broadcasting.
 *
 * `context` carries optional chain state for builders that need it (e.g.
 * billing `update-params` preserves on-chain `allowedList` /
 * `reservedDomainSuffixes` when not explicitly overridden). Builders that
 * don't need context simply ignore it.
 */
export type TxMsgBuilder = (
  senderAddress: string,
  subcommand: string,
  args: string[],
  context?: TxBuildContext,
) => BuiltMessages;

import type {
  QUERY_MODULES as QUERY_METADATA,
  TX_MODULES as TX_METADATA,
} from './module-metadata.js';

export {
  getAvailableModules,
  getModuleSubcommands,
  getSubcommandUsage,
  getSupportedModules,
  isSubcommandSupported,
  throwUnsupportedSubcommand,
} from './module-metadata.js';

export type TxBuildContextLoader = (
  queryClient: ManifestQueryClient,
) => Promise<TxBuildContext>;

interface QueryRegistration {
  handler: QueryHandler;
}
interface TxRegistration {
  handler: TxHandler;
  msgBuilder: TxMsgBuilder;
  contextLoaders?: Record<string, TxBuildContextLoader>;
}

const QUERY_MODULES: Record<string, QueryRegistration> = {
  bank: {
    handler: routeBankQuery,
  },
  staking: {
    handler: routeStakingQuery,
  },
  distribution: {
    handler: routeDistributionQuery,
  },
  gov: {
    handler: routeGovQuery,
  },
  authz: {
    handler: routeAuthzQuery,
  },
  feegrant: {
    handler: routeFeegrantQuery,
  },
  mint: {
    handler: routeMintQuery,
  },
  auth: {
    handler: routeAuthQuery,
  },
  billing: {
    handler: routeBillingQuery,
  },
  sku: {
    handler: routeSkuQuery,
  },
  group: {
    handler: routeGroupQuery,
  },
  poa: {
    handler: routePoAQuery,
  },
  tokenfactory: {
    handler: routeTokenfactoryQuery,
  },
  'ibc-transfer': {
    handler: routeIbcTransferQuery,
  },
  wasm: {
    handler: routeWasmQuery,
  },
} satisfies Record<keyof typeof QUERY_METADATA, QueryRegistration>;

const TX_MODULES: Record<string, TxRegistration> = {
  authz: {
    handler: routeAuthzTransaction,
    msgBuilder: buildAuthzMessages,
  },
  bank: {
    handler: routeBankTransaction,
    msgBuilder: buildBankMessages,
  },
  staking: {
    handler: routeStakingTransaction,
    msgBuilder: buildStakingMessages,
  },
  distribution: {
    handler: routeDistributionTransaction,
    msgBuilder: buildDistributionMessages,
  },
  feegrant: {
    handler: routeFeegrantTransaction,
    msgBuilder: buildFeegrantMessages,
  },
  gov: {
    handler: routeGovTransaction,
    msgBuilder: buildGovMessages,
  },
  billing: {
    handler: routeBillingTransaction,
    msgBuilder: buildBillingMessages,
    contextLoaders: {
      'update-params': loadBillingUpdateParamsContext,
    },
  },
  manifest: {
    handler: routeManifestTransaction,
    msgBuilder: buildManifestMessages,
  },
  sku: {
    handler: routeSkuTransaction,
    msgBuilder: buildSkuMessages,
  },
  group: {
    handler: routeGroupTransaction,
    msgBuilder: buildGroupMessages,
  },
  poa: {
    handler: routePoATransaction,
    msgBuilder: buildPoAMessages,
  },
  tokenfactory: {
    handler: routeTokenfactoryTransaction,
    msgBuilder: buildTokenfactoryMessages,
  },
  'ibc-transfer': {
    handler: routeIbcTransferTransaction,
    msgBuilder: buildIbcTransferMessages,
  },
  wasm: {
    handler: routeWasmTransaction,
    msgBuilder: buildWasmMessages,
  },
} satisfies Record<keyof typeof TX_METADATA, TxRegistration>;

/**
 * Get the handler function for a query module
 * @throws ManifestMCPError if module is not found
 */
export function getQueryHandler(module: string): QueryHandler {
  const moduleInfo = QUERY_MODULES[module];
  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown query module: ${module}`,
      { availableModules: Object.keys(QUERY_MODULES) },
    );
  }
  return moduleInfo.handler;
}

/**
 * Get the handler function for a transaction module
 * @throws ManifestMCPError if module is not found
 */
export function getTxHandler(module: string): TxHandler {
  const moduleInfo = TX_MODULES[module];
  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown tx module: ${module}`,
      { availableModules: Object.keys(TX_MODULES) },
    );
  }
  return moduleInfo.handler;
}

/**
 * Get the message builder function for a transaction module
 * @throws ManifestMCPError if module is not found
 */
export function getTxMsgBuilder(module: string): TxMsgBuilder {
  const moduleInfo = TX_MODULES[module];
  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown tx module: ${module}`,
      { availableModules: Object.keys(TX_MODULES) },
    );
  }
  return moduleInfo.msgBuilder;
}

/**
 * Look up the optional `TxBuildContext` loader for a (module, subcommand)
 * pair. Returns `undefined` when the module is unknown OR when the module
 * doesn't declare a loader for that subcommand — both are normal cases
 * (most txs need no context). Callers are expected to short-circuit on
 * `undefined` and skip the chain read.
 */
export function getTxContextLoader(
  module: string,
  subcommand: string,
): TxBuildContextLoader | undefined {
  return TX_MODULES[module]?.contextLoaders?.[subcommand];
}
