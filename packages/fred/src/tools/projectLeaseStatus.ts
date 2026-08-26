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
  let truncated = false;

  for (const [key, value] of ordered) {
    // Schema validate-or-drop fields can exist as `undefined`; JSON omits them, so the projection
    // should do the same without claiming user-visible truncation.
    if (value === undefined) continue;

    const encoded = JSON.stringify({ [key]: value });
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
