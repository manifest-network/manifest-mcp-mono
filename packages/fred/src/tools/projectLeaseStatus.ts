import {
  bigIntReplacer,
  type FredLeaseStatus,
} from '@manifest-network/manifest-mcp-core';
import { sanitizeFailureFields } from '../failure-reason.js';
import {
  hadValidationDrops,
  inheritValidationDrops,
} from '../http/response-schemas.js';
import { sanitizeRetentionFields } from './sanitizeRetention.js';

/** Serialized character budget for provider status copied into MCP model context. */
export const MAX_LEASE_STATUS_CHARS = 16_000;

/**
 * Fields with direct operational value survive before diagnostic bulk and future extension keys.
 * The source is JSON-derived, so preserving an unknown field remains safe when it fits the budget;
 * prioritization only decides which entries survive an over-budget response.
 */
const PRIORITY_FIELDS = [
  'state',
  'provision_status',
  'phase',
  'reason',
  'message',
  'last_error',
  'fail_count',
  'created_at',
  'retained_until',
  'items',
  'restore_hint',
  'requires_payload',
  'payload_received',
  'provisioning_started',
  'endpoints',
  'services',
  'instances',
  'steps',
] as const;

export interface LeaseStatusProjection {
  readonly status: Record<string, unknown>;
  readonly truncated: boolean;
}

/**
 * Build the tenant-safe status view shared by both status MCP tools.
 *
 * `partition` is owner-only provider metadata and never enters model context. Failure and
 * retention text is normalized and control/format characters are removed before budgeting. The
 * validation-drop marker is inherited out-of-band so the projection can report an incomplete
 * provider response without adding an internal field to the published JSON DTO.
 */
export function sanitizeLeaseStatusForDisplay(
  status: FredLeaseStatus,
): FredLeaseStatus & Record<string, unknown> {
  const source = status as FredLeaseStatus & Record<string, unknown>;
  const {
    partition: _partitionOmitted,
    retained_until: _retainedUntilRaw,
    items: _itemsRaw,
    restore_hint: _restoreHintRaw,
    reason: _reasonRaw,
    message: _messageRaw,
    last_error: _lastErrorRaw,
    ...rest
  } = source;
  const sanitized = {
    ...rest,
    ...sanitizeFailureFields(status),
    ...sanitizeRetentionFields(status),
  };
  return inheritValidationDrops(
    sanitized as FredLeaseStatus & Record<string, unknown>,
    status,
  );
}

/**
 * Bound a provider status object by its actual JSON serialization size.
 *
 * Entries are atomic: an oversized nested value is omitted instead of structurally edited into a
 * shape that no longer matches its endpoint contract. Smaller later entries may still fit. Using
 * `Object.fromEntries` also makes provider keys such as `__proto__` ordinary own properties rather
 * than invoking the legacy prototype setter.
 */
export function projectLeaseStatus(status: object): LeaseStatusProjection {
  const sourceEntries = Object.entries(status);
  const byKey = new Map(sourceEntries);
  const ordered: Array<[string, unknown]> = [];

  for (const key of PRIORITY_FIELDS) {
    if (!byKey.has(key)) continue;
    ordered.push([key, byKey.get(key)]);
    byKey.delete(key);
  }
  ordered.push(...byKey.entries());

  const kept: Array<[string, unknown]> = [];
  // Opening and closing braces are always present.
  let serializedChars = 2;
  let truncated = hadValidationDrops(status);

  for (const [key, value] of ordered) {
    // JSON input cannot contain `undefined`; an own undefined field is the schema's validate-or-
    // drop fallback and therefore represents information the provider sent but we rejected.
    if (value === undefined) {
      truncated = true;
      continue;
    }
    if (hadValidationDrops(value)) truncated = true;

    // A provider body may be up to 10 MiB. Avoid allocating another equally large escaped copy
    // merely to prove a single string cannot fit this 16k model-context budget.
    if (typeof value === 'string' && value.length > MAX_LEASE_STATUS_CHARS) {
      truncated = true;
      continue;
    }

    const encoded = JSON.stringify({ [key]: value }, bigIntReplacer);
    const contribution = encoded.length - 2 + (kept.length === 0 ? 0 : 1);
    if (serializedChars + contribution > MAX_LEASE_STATUS_CHARS) {
      truncated = true;
      continue;
    }

    kept.push([key, value]);
    serializedChars += contribution;
  }

  return { status: Object.fromEntries(kept), truncated };
}
