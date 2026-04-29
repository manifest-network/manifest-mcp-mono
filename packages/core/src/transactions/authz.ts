import type { GeneratedType } from '@cosmjs/proto-signing';
import type { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos, cosmosProtoRegistry } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import {
  type BuiltMessages,
  type CosmosTxResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxOptions,
} from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  extractFlag,
  filterConsumedArgs,
  parseUnixSecondsToDate,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const { MsgGrant, MsgRevoke, MsgExec } = cosmos.authz.v1beta1;

const GENERIC_AUTHORIZATION_TYPE_URL =
  '/cosmos.authz.v1beta1.GenericAuthorization';

const MSG_TYPE_URL_RE = /^\/[A-Za-z0-9_.]+$/;

function validateMsgTypeUrl(msgTypeUrl: string, context: string): void {
  if (!MSG_TYPE_URL_RE.test(msgTypeUrl)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid msg-type-url for ${context}: "${msgTypeUrl}". Expected a fully-qualified protobuf type URL (e.g., "/cosmos.bank.v1beta1.MsgSend").`,
    );
  }
}

/**
 * Encode an inner message JSON for MsgExec into an Any-shaped object.
 *
 * The user passes JSON in cosmos-sdk convention: `{"@type": "/<typeUrl>", ...fields}`.
 * We look the type up in the manifestjs proto registry, fromPartial the rest, and
 * pre-encode to bytes. The resulting `{ typeUrl, value: Uint8Array }` is recognised
 * by `Any.is` so MsgExec.encode passes it through without re-wrapping.
 */
function encodeInnerExecMsg(json: unknown): {
  typeUrl: string;
  value: Uint8Array;
} {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'authz exec inner message must be a JSON object with an "@type" field',
    );
  }
  const obj = json as Record<string, unknown>;
  const typeUrl = obj['@type'];
  if (typeof typeUrl !== 'string' || !typeUrl.startsWith('/')) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'authz exec inner message is missing a valid "@type" field (e.g., "/cosmos.bank.v1beta1.MsgSend")',
    );
  }
  const entry = (
    cosmosProtoRegistry as ReadonlyArray<[string, GeneratedType]>
  ).find(([url]) => url === typeUrl);
  if (!entry) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `authz exec: unknown inner message type "${typeUrl}". Type must be in the cosmos proto registry.`,
    );
  }
  const [, generated] = entry;
  const { '@type': _typeKey, ...rest } = obj;
  const partial = (
    generated as { fromPartial: (input: unknown) => unknown }
  ).fromPartial(rest);
  const value = (
    generated as { encode: (input: unknown) => { finish: () => Uint8Array } }
  )
    .encode(partial)
    .finish();
  return { typeUrl, value };
}

/**
 * Build messages for an authz transaction subcommand (no signing/broadcasting).
 */
export function buildAuthzMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'authz transaction');

  switch (subcommand) {
    case 'grant': {
      const expirationFlag = extractFlag(args, '--expiration', 'authz grant');
      const positionalArgs = filterConsumedArgs(
        args,
        expirationFlag.consumedIndices,
      );
      requireArgs(
        positionalArgs,
        2,
        ['grantee-address', 'msg-type-url'],
        'authz grant',
      );
      const [granteeAddress, msgTypeUrl] = positionalArgs;
      validateAddress(granteeAddress, 'grantee address');
      validateMsgTypeUrl(msgTypeUrl, 'authz grant');

      const expiration = expirationFlag.value
        ? parseUnixSecondsToDate(expirationFlag.value, 'expiration')
        : undefined;

      const msg = {
        typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
        value: MsgGrant.fromPartial({
          granter: senderAddress,
          grantee: granteeAddress,
          grant: {
            authorization: {
              $typeUrl: GENERIC_AUTHORIZATION_TYPE_URL,
              msg: msgTypeUrl,
            },
            expiration,
          },
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'revoke': {
      requireArgs(args, 2, ['grantee-address', 'msg-type-url'], 'authz revoke');
      const [granteeAddress, msgTypeUrl] = args;
      validateAddress(granteeAddress, 'grantee address');
      validateMsgTypeUrl(msgTypeUrl, 'authz revoke');

      const msg = {
        typeUrl: '/cosmos.authz.v1beta1.MsgRevoke',
        value: MsgRevoke.fromPartial({
          granter: senderAddress,
          grantee: granteeAddress,
          msgTypeUrl,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'exec': {
      requireArgs(args, 1, ['inner-msg-json'], 'authz exec');
      const innerJsonStrings = args;

      const innerMsgs = innerJsonStrings.map((raw, idx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `authz exec: inner message #${idx + 1} is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return encodeInnerExecMsg(parsed);
      });

      const msg = {
        typeUrl: '/cosmos.authz.v1beta1.MsgExec',
        value: MsgExec.fromPartial({
          grantee: senderAddress,
          msgs: innerMsgs,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'authz', subcommand);
  }
}

/**
 * Route authz transaction to appropriate handler
 */
export async function routeAuthzTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildAuthzMessages(senderAddress, subcommand, args);
  const fee = await buildGasFee(
    client,
    senderAddress,
    built.messages,
    options,
    built.memo,
  );
  const result = await client.signAndBroadcast(
    senderAddress,
    built.messages,
    fee,
    built.memo,
  );
  return buildTxResult(
    'authz',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
