import { isTransactionHash } from './transaction-hash.js';

type Field = { ok: true; value: unknown } | { ok: false };

/** A diagnostic read cannot replace the error being inspected. */
export function guardedField(value: unknown, key: PropertyKey): Field {
  try {
    return {
      ok: true,
      value:
        value !== null &&
        (typeof value === 'object' || typeof value === 'function')
          ? Reflect.get(value, key)
          : undefined,
    };
  } catch {
    return { ok: false };
  }
}

/** Recover data without invoking accessors, even when enumeration is unavailable. */
export function ownData(value: unknown, key: PropertyKey): unknown {
  try {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function txEvidence(details: unknown): Record<string, unknown> {
  const sent = ownData(details, 'sent') === true;
  const partial = ownData(details, 'partial') === true;
  const transactionHash = ownData(details, 'transactionHash');
  const code = sent ? ownData(details, 'code') : undefined;
  const height = sent ? ownData(details, 'height') : undefined;
  const confirmed = sent ? ownData(details, 'confirmed') : undefined;
  const leaseUuid = ownData(details, 'lease_uuid');
  return {
    ...(sent ? { sent: true } : {}),
    ...(partial ? { partial: true } : {}),
    ...(isTransactionHash(transactionHash) ? { transactionHash } : {}),
    ...(typeof code === 'number' && Number.isSafeInteger(code) && code >= 0
      ? { code }
      : {}),
    ...(typeof height === 'string' &&
    height.length > 0 &&
    height.length <= 20 &&
    !height.match(/[^0-9]/)
      ? { height }
      : {}),
    ...(typeof confirmed === 'boolean' ? { confirmed } : {}),
    ...(typeof leaseUuid === 'string' ? { lease_uuid: leaseUuid } : {}),
  };
}

export function readableTxEvidence(error: unknown): Record<string, unknown> {
  return txEvidence(ownData(error, 'details'));
}

// Consumers read these by name even when they are absent from Object.keys/spread.
const DETAIL_KEYS = [
  'module',
  'partial',
  'sent',
  'httpStatus',
  'grpcCode',
  'transportCode',
] as const;

/** Validate consumer fields and spread fields once; salvage only machine facts on failure. */
export function snapshotErrorDetails(details: unknown): {
  value: Record<string, unknown>;
  readable: boolean;
  namedReadable: boolean;
  module: unknown;
} {
  const evidence = txEvidence(details);
  if (details == null)
    return {
      value: evidence,
      readable: true,
      namedReadable: true,
      module: undefined,
    };
  const fields = Object(details);
  const named = new Map<PropertyKey, Field>();
  let namedReadable = true;
  for (const key of DETAIL_KEYS) {
    const field = guardedField(fields, key);
    named.set(key, field);
    if (!field.ok) namedReadable = false;
  }
  // A safely observed positive veto stays terminal even when it came from a
  // getter or prototype. Retain that verdict without invoking its accessor again.
  for (const key of ['sent', 'partial'] as const) {
    const field = named.get(key);
    if (field?.ok && field.value === true) evidence[key] = true;
  }
  // Keep readable transport verdicts as well: discarding a 403 or permanent
  // gRPC status could make a generic transient message eligible for retry.
  for (const key of [
    'module',
    'httpStatus',
    'grpcCode',
    'transportCode',
  ] as const) {
    const field = named.get(key);
    const fieldValue = field?.ok ? field.value : ownData(details, key);
    if (
      key === 'httpStatus' || key === 'grpcCode'
        ? typeof fieldValue === 'number'
        : typeof fieldValue === 'string'
    ) {
      evidence[key] = fieldValue;
    }
  }
  // A complete read must preserve ordinary spread semantics: promoting hidden
  // or inherited statuses into a fresh envelope can change its retry verdict.
  const value: Record<string, unknown> = {};
  let readable = namedReadable;
  try {
    for (const key of Reflect.ownKeys(fields)) {
      // Unrelated hidden diagnostics are not part of spread. Only the named
      // consumer fields above need inspection regardless of enumerability.
      if (!Object.getOwnPropertyDescriptor(fields, key)?.enumerable) continue;
      const field = named.get(key) ?? guardedField(fields, key);
      if (!field.ok) {
        readable = false;
        continue;
      }
      Object.defineProperty(value, key, {
        value: field.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    readable = false;
  }
  const module = named.get('module');
  return {
    value: readable ? value : evidence,
    readable,
    namedReadable,
    module: module?.ok ? module.value : undefined,
  };
}
