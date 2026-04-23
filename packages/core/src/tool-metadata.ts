import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Manifest-namespaced tool metadata, attached to every tool via `_meta.manifest`.
 *
 * The standard MCP `ToolAnnotations` (readOnlyHint, destructiveHint,
 * idempotentHint, openWorldHint) cover generic UX hints. These flags carry
 * Manifest-specific signals the standard fields can't express precisely:
 *
 * - `broadcasts` — true when the agent's wallet signs and broadcasts a Cosmos
 *   tx. Broader than `destructiveHint` (covers additive broadcasts like
 *   fund_credit and deploy_app), narrower than `readOnlyHint: false` (excludes
 *   request_faucet, where an external service signs on the user's behalf).
 *   This is what the manifest-agent plugin's permission policy is keyed on.
 *
 * - `estimable` — true when `cosmos_estimate_fee` can be called for this tool's
 *   action to surface a precise fee before the user confirms. Currently only
 *   `cosmos_tx`. The plugin's policy uses this to decide between "show fee"
 *   vs "show balance + describe action" pre-broadcast UX.
 *
 * Like `ToolAnnotations`, these are advisory hints. The plugin enforces gating
 * via a static PreToolUse hook regex; this metadata is the source of truth for
 * generating policy text and documentation, not a security boundary.
 *
 * The leading `v` field versions the schema. Plugin readers should branch on
 * it before reading the rest. Bumping `v` is the contract for renaming or
 * removing a field; additive changes can stay at the current version.
 */
export const MANIFEST_TOOL_META_VERSION = 1;
export type ManifestToolMetaVersion = typeof MANIFEST_TOOL_META_VERSION;

export interface ManifestToolMeta {
  readonly v: ManifestToolMetaVersion;
  readonly broadcasts: boolean;
  readonly estimable: boolean;
}

/**
 * Shape of the `_meta` object passed to `registerTool`. The `manifest` key is
 * our namespace; future versions can add sibling keys without breaking existing
 * consumers.
 */
export interface ManifestToolMetaContainer {
  readonly manifest: ManifestToolMeta;
}

/**
 * Build a `_meta` container for a tool. The version field is injected here so
 * call sites only specify the semantic flags.
 *
 * Returns `Record<string, unknown>` (rather than `ManifestToolMetaContainer`)
 * because the SDK's `registerTool` config types `_meta` as a string-indexed
 * record; named interfaces with a single literal key aren't structurally
 * assignable to that. The `ManifestToolMetaContainer` type is exported for
 * consumers that want to type-check `_meta` at the read site.
 */
export function manifestMeta(
  meta: Omit<ManifestToolMeta, 'v'>,
): Record<string, unknown> {
  const full: ManifestToolMeta = { v: MANIFEST_TOOL_META_VERSION, ...meta };
  return { manifest: full } satisfies ManifestToolMetaContainer;
}

/**
 * Standard annotations for a read-only tool (queries, listings, simulations).
 * Pairs with `manifestMeta({ broadcasts: false, estimable: false })`.
 *
 * `openWorldHint` defaults to true for tools that talk to the chain or
 * external services; pass `{ openWorld: false }` for tools backed by a local
 * static registry (e.g., list_modules).
 */
export function readOnlyAnnotations(
  title: string,
  options: { openWorld?: boolean } = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: options.openWorld ?? true,
  };
}

/**
 * Standard annotations for a tool that broadcasts a transaction.
 *
 * `destructive` distinguishes additive broadcasts (deploy_app, fund_credit —
 * adding state) from destructive ones (close_lease, update_app, convert —
 * removing or replacing state). Per spec, `destructiveHint` is only meaningful
 * when `readOnlyHint=false`, which is always the case here.
 *
 * `idempotent` defaults to false; pass true only for tools where calling
 * twice with the same args has no extra effect (e.g., restart_app converges
 * to the same running state — debatable, see test for the rationale).
 */
export function broadcastAnnotations(
  title: string,
  options: { destructive: boolean; idempotent?: boolean },
): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: options.destructive,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: true,
  };
}
