import { z } from 'zod';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Schemas for validating user-supplied JSON that is passed directly into
 * protobuf message builders. The underlying `fromPartial` helpers accept any
 * `DeepPartial<T>` and silently drop unknown keys, so a typo like
 * `"unbondingTim"` would be broadcast as a zero-valued field. `.strict()` on
 * every object rejects unknown keys; coerce helpers handle bigint/int parsing
 * from JSON-safe primitives (JSON has no bigint).
 */

/**
 * Parse a decimal-integer string into a bigint.
 *
 * Strings-only deliberately. Cosmos-sdk proto JSON always serializes int64 /
 * uint64 as decimal strings — accepting JS numbers would silently truncate
 * values above 2^53 and accepting arbitrary strings would let surprises
 * through: `BigInt("")` returns `0n`, `BigInt("0x10")` returns `16n`, and
 * `BigInt("  10  ")` returns `10n`. A strict `/^-?\d+$/` matches the on-wire
 * convention exactly and makes `BigInt(v)` total.
 */
const bigintFromJson = z
  .string()
  .regex(/^-?\d+$/, 'must be a decimal integer string (e.g. "1209600")')
  .transform((v) => BigInt(v));

/** google.protobuf.Duration ({ seconds: bigint, nanos: int32 }) */
const DurationSchema = z
  .object({
    seconds: bigintFromJson,
    nanos: z.number().int().optional(),
  })
  .strict();

/** cosmos.bank.v1beta1.DenomUnit */
const DenomUnitSchema = z
  .object({
    denom: z.string().min(1),
    exponent: z.number().int().min(0),
    aliases: z.array(z.string()).default([]),
  })
  .strict();

/**
 * cosmos.bank.v1beta1.Metadata — used for tokenfactory set-denom-metadata.
 *
 * Fields are string-typed in the proto; empty strings are legal (protobuf
 * doesn't distinguish absent from empty). `uri` / `uriHash` / `description`
 * are commonly omitted by callers, so they default to empty string.
 */
export const BankMetadataSchema = z
  .object({
    description: z.string().default(''),
    denomUnits: z.array(DenomUnitSchema).min(1),
    base: z.string().min(1),
    display: z.string().min(1),
    name: z.string().default(''),
    symbol: z.string().default(''),
    uri: z.string().default(''),
    uriHash: z.string().default(''),
  })
  .strict();

/**
 * strangelove_ventures.poa.v1.StakingParams — used by poa update-staking-params.
 * All fields are required by the proto (no defaults applied server-side).
 */
export const PoAStakingParamsSchema = z
  .object({
    unbondingTime: DurationSchema,
    maxValidators: z.number().int().min(1),
    maxEntries: z.number().int().min(1),
    historicalEntries: z.number().int().min(0),
    bondDenom: z.string().min(1),
    minCommissionRate: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'minCommissionRate must be a decimal string'),
  })
  .strict();

/** cosmos.Dec on the wire — non-negative decimal, fractional part optional. */
const DecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a decimal string (e.g. "0.05")');

/** strangelove_ventures.poa.v1.Description */
const PoADescriptionSchema = z
  .object({
    moniker: z.string().min(1),
    identity: z.string().default(''),
    website: z.string().default(''),
    securityContact: z.string().default(''),
    details: z.string().default(''),
  })
  .strict();

/** strangelove_ventures.poa.v1.CommissionRates */
const PoACommissionRatesSchema = z
  .object({
    rate: DecimalString,
    maxRate: DecimalString,
    maxChangeRate: DecimalString,
  })
  .strict();

/** google.protobuf.Any — pubkey on MsgCreateValidator. */
const AnySchema = z
  .object({
    typeUrl: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

/**
 * strangelove_ventures.poa.v1.MsgCreateValidator — used by poa create-validator.
 *
 * `validatorAddress` is required (must be valoper-prefixed). `delegatorAddress`
 * is deprecated upstream — when omitted, the route handler derives it from the
 * validator address bytes using the wallet's bech32 prefix. `pubkey` is a
 * `google.protobuf.Any` with a `typeUrl` (e.g. `/cosmos.crypto.ed25519.PubKey`)
 * and a base64 `value`.
 */
export const MsgCreateValidatorSchema = z
  .object({
    description: PoADescriptionSchema,
    commission: PoACommissionRatesSchema,
    minSelfDelegation: z
      .string()
      .regex(
        /^\d+$/,
        'minSelfDelegation must be a non-negative integer string',
      ),
    delegatorAddress: z.string().min(1).optional(),
    validatorAddress: z.string().min(1),
    pubkey: AnySchema,
  })
  .strict();

/**
 * Parse a JSON-encoded string and validate it against a zod schema. Wraps all
 * failures in `ManifestMCPError(TX_FAILED)` with a `context` prefix so callers
 * see which subcommand rejected the input.
 */
export function parseJsonWithSchema<T extends z.ZodType>(
  input: string,
  schema: T,
  context: string,
): z.infer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `${context}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `${context}: ${issues}`,
    );
  }

  return result.data;
}
