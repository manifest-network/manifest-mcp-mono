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

/** Accept string | number | bigint and coerce to bigint; rejects other types. */
const bigintFromJson = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v, ctx) => {
    try {
      return BigInt(v);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `Cannot coerce ${JSON.stringify(v)} to bigint`,
      });
      return z.NEVER;
    }
  });

/** google.protobuf.Duration ({ seconds: bigint, nanos: int32 }) */
const DurationSchema = z
  .object({
    seconds: bigintFromJson,
    nanos: z.number().int().optional(),
  })
  .strict();

/** cosmos.base.v1beta1.Coin ({ denom: string, amount: string }) */
const CoinSchema = z
  .object({
    denom: z.string().min(1),
    amount: z
      .string()
      .regex(/^\d+$/, 'amount must be a non-negative integer string'),
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

/**
 * osmosis.tokenfactory.v1beta1.Params — used by tokenfactory update-params.
 * `denomCreationGasConsume` is optional per proto; `denomCreationFee` may be
 * empty (module uses gas consumption instead when fee is empty).
 */
export const TokenfactoryParamsSchema = z
  .object({
    denomCreationFee: z.array(CoinSchema).default([]),
    denomCreationGasConsume: bigintFromJson.optional(),
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
