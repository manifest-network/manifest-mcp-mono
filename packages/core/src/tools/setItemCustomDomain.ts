import { asFqdn, type Fqdn, type LeaseUuid } from '../brands.js';
import { cosmosTx } from '../cosmos.js';
import type { TxCtx } from '../ctx.js';
import { withTxConfirmation } from '../internals/tx-confirmation.js';
import { txExtrasFrom, txOverridesFrom } from '../internals/tx-opts.js';
import type { TxCallOptions } from '../options.js';

/**
 * Discriminated-union input for {@link setItemCustomDomain}. The two arms are
 * structurally mutually exclusive — you CANNOT construct a set arm without a
 * `customDomain`, nor a clear arm carrying one — so the old runtime
 * mutual-exclusion / empty-domain guards are gone (unreachable). The set arm
 * carries an already-branded, boundary-validated `Fqdn` (validated/normalized
 * once at the MCP boundary via `parseFqdn`); this fn does NOT re-trim or
 * re-validate (parse-once, ENG-258).
 *
 * - `serviceName` addresses a specific item inside a stack lease; omit for a
 *   1-item legacy lease. The chain validates the label.
 */
export type SetItemCustomDomainInput =
  | { leaseUuid: LeaseUuid; customDomain: Fqdn; serviceName?: string }
  | { leaseUuid: LeaseUuid; clear: true; serviceName?: string };

export interface SetItemCustomDomainResult {
  readonly lease_uuid: LeaseUuid;
  readonly service_name: string;
  readonly custom_domain: Fqdn;
  readonly transactionHash: string;
  readonly code: number;
}

/**
 * Set or clear the `custom_domain` on a billing lease item via
 * `MsgSetItemCustomDomain`.
 *
 * - The SET arm forwards the already-branded `Fqdn` verbatim (no re-trim /
 *   re-validate). The chain remains the authoritative validator (FQDN format,
 *   reserved-suffix rules).
 * - The CLEAR arm passes `--clear` and echoes `asFqdn('')` (a trust-cast: it
 *   does NOT throw or lowercase — see 4c-reads-B OI-ASFQDN), since the chain
 *   accepts `custom_domain == ""` as the canonical clear form.
 * - NO `requireAuthSigner`: the wallet is on `ctx.chain` (not `ctx.signer`,
 *   which is intentionally unset here); the query-only `INVALID_CONFIG` guard
 *   comes downstream from `cosmosTx → ctx.chain.getSigningClient()`. See
 *   OI-SENDER.
 * - `opts.signal` bounds the AWAIT of the confirmation only — a submitted tx
 *   cannot be un-broadcast; on abort the tx may still commit (re-query the
 *   chain). See {@link withTxConfirmation}.
 *
 * Authorised signers per `MsgSetItemCustomDomain.ValidateBasic`: the lease
 * tenant, the module authority, or any address in `params.allowed_list`.
 */
export async function setItemCustomDomain(
  ctx: TxCtx,
  input: SetItemCustomDomainInput,
  opts?: TxCallOptions,
): Promise<SetItemCustomDomainResult> {
  const clearing = 'clear' in input;
  const args: string[] = [input.leaseUuid];
  if (clearing) {
    args.push('--clear');
  } else {
    args.push(input.customDomain); // already a branded, boundary-validated Fqdn — no re-trim
  }
  if (input.serviceName) {
    args.push('--service-name', input.serviceName);
  }

  const result = await withTxConfirmation(
    () =>
      cosmosTx(
        ctx.chain,
        'billing',
        'set-item-custom-domain',
        args,
        true,
        txOverridesFrom(opts),
        txExtrasFrom(opts),
      ),
    opts,
  );

  return {
    lease_uuid: input.leaseUuid,
    service_name: input.serviceName ?? '',
    custom_domain: clearing ? asFqdn('') : input.customDomain, // clear echoes asFqdn('') (trust-cast, no throw)
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
