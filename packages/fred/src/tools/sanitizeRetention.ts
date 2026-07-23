import {
  type FredLeaseItem,
  sanitizeForDisplay,
} from '@manifest-network/manifest-mcp-core';

/**
 * Project + sanitize the provider-controlled retention fields for AI-facing
 * output (ENG-600, ENG-555 precedent). `restore_hint` + item strings are
 * provider-controlled (provider records come from untrusted on-chain SKUs) and
 * flow into model/human context, so they are run through `sanitizeForDisplay`
 * (NFC-normalize, strip control/format/separator chars, collapse whitespace).
 * `retained_until` is an RFC3339 timestamp — passed through, not stripped.
 * `partition` is deliberately NOT a parameter: it is owner-only and omitted from
 * the AI-facing projection (spec Decision 6). Returns only the keys present.
 */
export function sanitizeRetentionFields(src: {
  retained_until?: string;
  items?: readonly FredLeaseItem[];
  restore_hint?: string;
}): { retained_until?: string; items?: FredLeaseItem[]; restore_hint?: string } {
  const s = (v?: string) =>
    v === undefined ? undefined : (sanitizeForDisplay(v) as string);
  const out: {
    retained_until?: string;
    items?: FredLeaseItem[];
    restore_hint?: string;
  } = {};
  if (src.retained_until !== undefined) out.retained_until = src.retained_until;
  if (src.restore_hint !== undefined) out.restore_hint = s(src.restore_hint);
  if (src.items !== undefined) {
    out.items = src.items.map((i) => ({
      sku: s(i.sku) ?? '',
      ...(i.quantity !== undefined ? { quantity: i.quantity } : {}),
      ...(i.service_name !== undefined ? { service_name: s(i.service_name) } : {}),
      ...(i.custom_domain !== undefined ? { custom_domain: s(i.custom_domain) } : {}),
    }));
  }
  return out;
}
