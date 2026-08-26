import { z } from 'zod';

// Provider responses evolve independently of the SDK. Loose objects preserve new fields for
// forward compatibility, while every field the client already understands is validated here.
// Optional fields use validate-or-drop semantics: an older or faulty provider cannot smuggle a
// wrong runtime type into downstream code, but one malformed diagnostic field does not make an
// otherwise usable response disappear.
function optionalOrUndefined<T extends z.ZodType>(schema: T) {
  return z.catch(z.optional(schema), undefined);
}

const NonNegativeIntegerSchema = z.int().check(z.nonnegative());
const OptionalStringSchema = optionalOrUndefined(z.string());
const OptionalBooleanSchema = optionalOrUndefined(z.boolean());
const OptionalNonNegativeIntegerSchema = optionalOrUndefined(
  NonNegativeIntegerSchema,
);
const StringRecordSchema = z.record(z.string(), z.string());
const OptionalStringRecordSchema = optionalOrUndefined(StringRecordSchema);
const UnknownRecordSchema = z.record(z.string(), z.unknown());
const OptionalUnknownRecordSchema = optionalOrUndefined(UnknownRecordSchema);

const FredInstanceInfoSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
  ports: optionalOrUndefined(z.record(z.string(), z.number())),
  fqdn: OptionalStringSchema,
});

const FredServiceStatusSchema = z.looseObject({
  instances: z.array(FredInstanceInfoSchema),
});

const FredLeaseItemSchema = z.looseObject({
  sku: z.string(),
  quantity: OptionalNonNegativeIntegerSchema,
  service_name: OptionalStringSchema,
  custom_domain: OptionalStringSchema,
});

/** Raw `/status` response before its string state is converted to `LeaseState`. */
export const RawLeaseStatusResponseSchema = z.looseObject({
  state: z.string(),
  provision_status: OptionalStringSchema,
  phase: OptionalStringSchema,
  steps: OptionalStringRecordSchema,
  instances: optionalOrUndefined(z.array(FredInstanceInfoSchema)),
  endpoints: OptionalStringRecordSchema,
  reason: OptionalStringSchema,
  message: OptionalStringSchema,
  last_error: OptionalStringSchema,
  fail_count: OptionalNonNegativeIntegerSchema,
  created_at: OptionalStringSchema,
  services: optionalOrUndefined(z.record(z.string(), FredServiceStatusSchema)),
  retained_until: OptionalStringSchema,
  items: optionalOrUndefined(z.array(FredLeaseItemSchema)),
  restore_hint: OptionalStringSchema,
  partition: OptionalStringSchema,
  // Current Fred metadata fields are not part of the published FredLeaseStatus type, but
  // validating them when present prevents a loose-object passthrough from weakening the seam.
  lease_uuid: OptionalStringSchema,
  tenant: OptionalStringSchema,
  provider_uuid: OptionalStringSchema,
  requires_payload: OptionalBooleanSchema,
  meta_hash_hex: OptionalStringSchema,
  payload_received: OptionalBooleanSchema,
  provisioning_started: OptionalBooleanSchema,
});

/**
 * Logs have a deliberately tolerant policy: null/missing/non-object maps become empty and
 * non-string entries are dropped. Keeping the valid siblings is more useful than rejecting the
 * whole call, and downstream budgeting still reports truncation when retained content is cut.
 */
const FredLogMapSchema = z.pipe(
  z.optional(z.unknown()),
  z.transform<unknown, Record<string, string>>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }),
);

export const FredLeaseLogsResponseSchema = z.looseObject({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  logs: FredLogMapSchema,
});

export const FredLeaseProvisionResponseSchema = z.looseObject({
  status: z.string(),
  fail_count: NonNegativeIntegerSchema,
  reason: OptionalStringSchema,
  message: OptionalStringSchema,
  last_error: OptionalStringSchema,
  retained_until: OptionalStringSchema,
  items: optionalOrUndefined(z.array(FredLeaseItemSchema)),
  restore_hint: OptionalStringSchema,
  partition: OptionalStringSchema,
  lease_uuid: OptionalStringSchema,
  tenant: OptionalStringSchema,
  provider_uuid: OptionalStringSchema,
});

export const FredActionResponseSchema = z.looseObject({
  status: z.string(),
});

const FredLeaseReleaseSchema = z.looseObject({
  version: NonNegativeIntegerSchema,
  image: z.string(),
  status: z.string(),
  created_at: z.string(),
  reason: OptionalStringSchema,
  message: OptionalStringSchema,
  error: OptionalStringSchema,
  // A nil Go []byte serializes as null. Validate-or-drop keeps that older/empty release usable.
  manifest: OptionalStringSchema,
});

export const FredLeaseReleasesResponseSchema = z.looseObject({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  releases: z.array(FredLeaseReleaseSchema),
});

const ProviderHealthCheckSchema = z.looseObject({
  status: z.string(),
  message: OptionalStringSchema,
});

export const ProviderHealthResponseSchema = z.looseObject({
  status: z.string(),
  provider_uuid: z.string(),
  checks: optionalOrUndefined(z.record(z.string(), ProviderHealthCheckSchema)),
  stats: optionalOrUndefined(
    z.looseObject({ in_flight_provisions: NonNegativeIntegerSchema }),
  ),
});

const ProviderInstanceInfoSchema = z.looseObject({
  instance_index: NonNegativeIntegerSchema,
  // Fred omits empty backend fields, while the published TypeScript DTO represents absence as
  // the empty string. Defaulting only omitted values preserves that established return contract;
  // a present value of the wrong type still fails validation.
  container_id: z._default(z.optional(z.string()), ''),
  image: z._default(z.optional(z.string()), ''),
  status: z._default(z.optional(z.string()), ''),
  ports: OptionalUnknownRecordSchema,
  fqdn: OptionalStringSchema,
});

const ProviderServiceConnectionDetailsSchema = z.looseObject({
  host: OptionalStringSchema,
  fqdn: OptionalStringSchema,
  ports: OptionalUnknownRecordSchema,
  instances: optionalOrUndefined(z.array(ProviderInstanceInfoSchema)),
});

const ProviderConnectionDetailsSchema = z.looseObject({
  host: z.string(),
  fqdn: OptionalStringSchema,
  ports: OptionalUnknownRecordSchema,
  instances: optionalOrUndefined(z.array(ProviderInstanceInfoSchema)),
  protocol: OptionalStringSchema,
  metadata: OptionalStringRecordSchema,
  services: optionalOrUndefined(
    z.record(z.string(), ProviderServiceConnectionDetailsSchema),
  ),
});

export const LeaseConnectionResponseSchema = z.looseObject({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  connection: ProviderConnectionDetailsSchema,
});
