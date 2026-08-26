import { z } from 'zod';

// Validation metadata stays out-of-band so published SDK DTOs remain ordinary JSON values. Tool
// projections can still distinguish "the provider omitted this" from "the client rejected this"
// and report truncation instead of presenting a silently incomplete response as authoritative.
const validationDrops = new WeakSet<object>();

function markValidationDrops<T extends object>(value: T, dropped: boolean): T {
  if (dropped) validationDrops.add(value);
  return value;
}

function trackValidationDrops<T extends object>(value: T): T {
  return markValidationDrops(
    value,
    Object.values(value).some(
      (entry) => entry === undefined || hadValidationDrops(entry),
    ),
  );
}

/** Internal signal for AI-facing projections; it is intentionally not barrel-exported. */
export function hadValidationDrops(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && validationDrops.has(value)
  );
}

/** Carry validation-drop metadata across a sanitized copy without changing its JSON shape. */
export function inheritValidationDrops<T extends object>(
  target: T,
  source: unknown,
): T {
  return markValidationDrops(target, hadValidationDrops(source));
}

// Provider responses evolve independently of the SDK. Loose objects preserve new fields for
// forward compatibility, while every field the client already understands is validated here.
// Optional fields use validate-or-drop semantics: an older or faulty provider cannot smuggle a
// wrong runtime type into downstream code, but one malformed diagnostic field does not make an
// otherwise usable response disappear.
function optionalOrUndefined<T extends z.ZodType>(schema: T) {
  return z.catch(z.optional(schema), undefined);
}

function filteredArray<T extends z.ZodType>(elementSchema: T) {
  return z.array(z.unknown()).transform((values): Array<z.output<T>> => {
    const kept: Array<z.output<T>> = [];
    let dropped = false;

    for (const value of values) {
      const parsed = elementSchema.safeParse(value);
      if (!parsed.success) {
        dropped = true;
        continue;
      }
      kept.push(parsed.data);
      dropped ||= hadValidationDrops(parsed.data);
    }

    return markValidationDrops(kept, dropped);
  });
}

function nullableFilteredArray<T extends z.ZodType>(elementSchema: T) {
  const arraySchema = filteredArray(elementSchema);
  return z
    .union([z.null(), arraySchema])
    .transform((value): Array<z.output<T>> => value ?? []);
}

function filteredRecord<T extends z.ZodType>(valueSchema: T) {
  return z
    .record(z.string(), z.unknown())
    .transform((record): Record<string, z.output<T>> => {
      const kept: Array<[string, z.output<T>]> = [];
      let dropped = false;

      for (const [key, value] of Object.entries(record)) {
        const parsed = valueSchema.safeParse(value);
        if (!parsed.success) {
          dropped = true;
          continue;
        }
        kept.push([key, parsed.data]);
        dropped ||= hadValidationDrops(parsed.data);
      }

      return markValidationDrops(Object.fromEntries(kept), dropped);
    });
}

function nullableFilteredRecord<T extends z.ZodType>(valueSchema: T) {
  const recordSchema = filteredRecord(valueSchema);
  return z
    .union([z.null(), recordSchema])
    .transform((value): Record<string, z.output<T>> => value ?? {});
}

const NonNegativeIntegerSchema = z.int().check(z.nonnegative());
const OptionalStringSchema = optionalOrUndefined(z.string());
const OptionalBooleanSchema = optionalOrUndefined(z.boolean());
const OptionalNonNegativeIntegerSchema = optionalOrUndefined(
  NonNegativeIntegerSchema,
);
const StringRecordSchema = filteredRecord(z.string());
const OptionalStringRecordSchema = optionalOrUndefined(StringRecordSchema);

const PortMappingSchema = z
  .looseObject({
    host_ip: z.string(),
    host_port: NonNegativeIntegerSchema,
  })
  .transform(trackValidationDrops);
const OptionalPortRecordSchema = optionalOrUndefined(
  filteredRecord(PortMappingSchema),
);

const FredInstanceInfoSchema = z
  .looseObject({
    name: z.string(),
    status: z.string(),
    ports: OptionalPortRecordSchema,
    fqdn: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

const FredServiceStatusSchema = z
  .looseObject({
    // A nil Go slice has no `omitempty` and therefore serializes as null.
    instances: nullableFilteredArray(FredInstanceInfoSchema),
  })
  .transform(trackValidationDrops);

const FredLeaseItemSchema = z
  .looseObject({
    sku: z.string(),
    quantity: OptionalNonNegativeIntegerSchema,
    service_name: OptionalStringSchema,
    custom_domain: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

/** Raw `/status` response before its string state is converted to `LeaseState`. */
export const RawLeaseStatusResponseSchema = z
  .looseObject({
    state: z.string(),
    provision_status: OptionalStringSchema,
    phase: OptionalStringSchema,
    steps: OptionalStringRecordSchema,
    instances: optionalOrUndefined(filteredArray(FredInstanceInfoSchema)),
    endpoints: OptionalStringRecordSchema,
    reason: OptionalStringSchema,
    message: OptionalStringSchema,
    last_error: OptionalStringSchema,
    fail_count: OptionalNonNegativeIntegerSchema,
    created_at: OptionalStringSchema,
    services: optionalOrUndefined(filteredRecord(FredServiceStatusSchema)),
    retained_until: OptionalStringSchema,
    items: optionalOrUndefined(filteredArray(FredLeaseItemSchema)),
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
  })
  .transform(trackValidationDrops);

/**
 * Logs have a deliberately tolerant policy: null/missing/non-object maps become empty and
 * non-string entries are dropped. Keeping the valid siblings is more useful than rejecting the
 * whole call, and downstream budgeting still reports truncation when retained content is cut.
 */
const FredLogMapSchema = z.pipe(
  z.optional(z.unknown()),
  z.transform<unknown, Record<string, string>>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return markValidationDrops({}, value !== undefined && value !== null);
    }
    const entries = Object.entries(value);
    return markValidationDrops(
      Object.fromEntries(
        entries.filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      entries.some((entry) => typeof entry[1] !== 'string'),
    );
  }),
);

export const FredLeaseLogsResponseSchema = z
  .looseObject({
    lease_uuid: z.string(),
    tenant: z.string(),
    provider_uuid: z.string(),
    logs: FredLogMapSchema,
  })
  .transform(trackValidationDrops);

export const FredLeaseProvisionResponseSchema = z
  .looseObject({
    status: z.string(),
    fail_count: NonNegativeIntegerSchema,
    reason: OptionalStringSchema,
    message: OptionalStringSchema,
    last_error: OptionalStringSchema,
    retained_until: OptionalStringSchema,
    items: optionalOrUndefined(filteredArray(FredLeaseItemSchema)),
    restore_hint: OptionalStringSchema,
    partition: OptionalStringSchema,
    lease_uuid: OptionalStringSchema,
    tenant: OptionalStringSchema,
    provider_uuid: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

export const FredActionResponseSchema = z.looseObject({
  status: z.string(),
});

const FredLeaseReleaseSchema = z
  .looseObject({
    version: NonNegativeIntegerSchema,
    image: z.string(),
    status: z.string(),
    created_at: z.string(),
    reason: OptionalStringSchema,
    message: OptionalStringSchema,
    error: OptionalStringSchema,
    // A nil Go []byte serializes as null. Validate-or-drop keeps that older/empty release usable.
    manifest: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

export const FredLeaseReleasesResponseSchema = z.looseObject({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  // A configured backend may legitimately return a nil slice, serialized by Go as null.
  releases: z
    .nullable(z.array(FredLeaseReleaseSchema))
    .transform((releases) => releases ?? []),
});

const ProviderHealthCheckSchema = z
  .looseObject({
    status: z.string(),
    message: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

export const ProviderHealthResponseSchema = z
  .looseObject({
    status: z.string(),
    provider_uuid: z.string(),
    // The Go field lacks `omitempty`; a nil map is a legitimate null zero value.
    checks: optionalOrUndefined(
      nullableFilteredRecord(ProviderHealthCheckSchema),
    ),
    stats: optionalOrUndefined(
      z.looseObject({ in_flight_provisions: NonNegativeIntegerSchema }),
    ),
  })
  .transform(trackValidationDrops);

const ProviderInstanceInfoSchema = z
  .looseObject({
    instance_index: NonNegativeIntegerSchema,
    // Fred omits empty backend fields, while the published TypeScript DTO represents absence as
    // the empty string. Defaulting only omitted values preserves that established return contract;
    // a present value of the wrong type still fails validation.
    container_id: z._default(z.optional(z.string()), ''),
    image: z._default(z.optional(z.string()), ''),
    status: z._default(z.optional(z.string()), ''),
    ports: OptionalPortRecordSchema,
    fqdn: OptionalStringSchema,
  })
  .transform(trackValidationDrops);

const ProviderServiceConnectionDetailsSchema = z
  .looseObject({
    host: OptionalStringSchema,
    fqdn: OptionalStringSchema,
    ports: OptionalPortRecordSchema,
    instances: optionalOrUndefined(
      nullableFilteredArray(ProviderInstanceInfoSchema),
    ),
  })
  .transform(trackValidationDrops);

const ProviderConnectionDetailsSchema = z
  .looseObject({
    host: z.string(),
    fqdn: OptionalStringSchema,
    ports: OptionalPortRecordSchema,
    instances: optionalOrUndefined(filteredArray(ProviderInstanceInfoSchema)),
    protocol: OptionalStringSchema,
    metadata: OptionalStringRecordSchema,
    services: optionalOrUndefined(
      filteredRecord(ProviderServiceConnectionDetailsSchema),
    ),
  })
  .transform(trackValidationDrops);

export const LeaseConnectionResponseSchema = z.looseObject({
  lease_uuid: z.string(),
  tenant: z.string(),
  provider_uuid: z.string(),
  connection: ProviderConnectionDetailsSchema,
});
