/**
 * Elicitation glue for `@manifest-network/manifest-mcp-agent`.
 *
 * Owns:
 *   1. `assertElicitationCapability(server)` — per-call check that the
 *      connected MCP client advertised `capabilities.elicitation` during
 *      `initialize`. Capability negotiation completes AFTER the
 *      `McpServer` constructor, so we cannot guard at startup; calling
 *      the guard at the top of each tool handler is the correct shape
 *      per the MCP spec.
 *   2. The five `requestedSchema` builders (one per agent-core callback
 *      that requires user input):
 *        - `buildConfirmSchema()`               — yes/no
 *        - `buildPlanSchema()`                  — confirm/edit_env/replace_spec/cancel
 *        - `buildRecoverySchema(options)`       — enum dynamically built
 *                                                 from `RecoveryOption[]`
 *        - `buildEditEnvSchema()` / `buildReplaceSpecSchema()` — not used
 *          directly today (the plan schema is a single flat form per the
 *          MCP elicitation spec's primitive-properties restriction), but
 *          exported for symmetry / future field-level recomposition.
 *   3. Three parsers that narrow `ElicitResult` (`action` + optional
 *      `content`) back to the typed return shapes agent-core expects:
 *        - `parseConfirmVerdict(result)`        → `'yes' | 'no'`
 *        - `parsePlanVerdict(result)`           → `PlanEdit | 'confirm' | 'cancel'`
 *        - `parseRecoveryChoice(result, opts)`  → `RecoveryChoice`
 *
 * All elicitation `message` bodies are passed verbatim from agent-core's
 * `internals/render-*.ts` outputs — see PLAN.md §2 and CLAUDE.md's
 * "no re-rendering inside the wrapper package" directive.
 */

import type {
  AppDeploySpec,
  PlanEdit,
  RecoveryChoice,
  RecoveryOption,
  RecoveryOptionId,
  SkuCandidate,
} from '@manifest-network/manifest-agent-core';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  sanitizeForDisplay,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';

// ----------------------------------------------------------------------
// Capability guard
// ----------------------------------------------------------------------

/**
 * Throw `ManifestMCPError(INVALID_CONFIG)` if the connected MCP client
 * did NOT advertise `capabilities.elicitation` at initialize. Must be
 * called from inside a tool handler (post-`initialize`) — capability
 * negotiation hasn't completed at construction time.
 *
 * @throws ManifestMCPError(INVALID_CONFIG) — diagnostic message names
 *   Claude Code ≥ 2.1.76 as the canonical reference for an elicitation-
 *   capable host.
 */
export function assertElicitationCapability(server: Server): void {
  const caps = server.getClientCapabilities();
  if (!caps?.elicitation) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'This host does not advertise the MCP elicitation capability. ' +
        '@manifest-network/manifest-mcp-agent requires elicitation to translate ' +
        'agent-core callbacks (onPlan / onConfirm / onFailure) into interactive prompts. ' +
        'Use Claude Code ≥ 2.1.76, or another elicitation-capable MCP host.',
    );
  }
}

// ----------------------------------------------------------------------
// requestedSchema builders
// ----------------------------------------------------------------------

type RequestedSchema = ElicitRequestFormParams['requestedSchema'];

/**
 * yes/no confirm schema (used by the deploy / manage-domain / close-lease
 * `onConfirm` callbacks — the read-only lookup + troubleshoot paths don't
 * elicit). The recap block's `text` is passed verbatim as the elicitation
 * `message` (not part of the schema).
 */
export function buildConfirmSchema(): RequestedSchema {
  return {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['yes', 'no'],
        enumNames: ['Proceed', 'Cancel'],
        description: 'Confirm or cancel.',
      },
    },
    required: ['verdict'],
  };
}

/**
 * Plan-step schema (deploy only). MCP elicitation forbids nested object
 * properties (only primitives + flat enum/array-of-enum), so structured
 * `edit_env` / `replace_spec` payloads ship as JSON strings and are
 * parsed by `parsePlanVerdict`. Same pattern `cosmos_tx` uses for its
 * `args` field.
 */
export function buildPlanSchema(): RequestedSchema {
  return {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['confirm', 'edit_env', 'replace_spec', 'cancel'],
        enumNames: ['Approve plan', 'Edit env vars', 'Replace spec', 'Cancel'],
        description: 'How to proceed with the rendered deployment plan.',
      },
      env_json: {
        type: 'string',
        description:
          'JSON object of env keys → string values. Used when verdict=edit_env.',
      },
      edit_service: {
        type: 'string',
        description:
          'Stack-spec service name to edit (omit for single-service spec). Used when verdict=edit_env.',
      },
      spec_json: {
        type: 'string',
        description:
          'Replacement AppDeploySpec as JSON. Used when verdict=replace_spec.',
      },
    },
    required: ['verdict'],
  };
}

/**
 * Recovery picker schema (deploy only, `onFailure(env, options)`). The
 * `enum` is built dynamically from the agent-core-supplied `options[]`
 * so the displayed choices exactly match what `dispatchRecovery` can
 * handle. `enumNames` carries the human labels.
 */
export function buildRecoverySchema(
  options: readonly RecoveryOption[],
): RequestedSchema {
  return {
    type: 'object',
    properties: {
      choice: {
        type: 'string',
        enum: options.map((o) => o.id),
        enumNames: options.map((o) => o.label),
        description:
          'Choose recovery action for the partially-succeeded deploy.',
      },
    },
    required: ['choice'],
  };
}

/**
 * Field-level helpers exported for symmetry / future composition. Not
 * referenced by the current plan-schema (the plan ships as one flat
 * form per the MCP elicitation primitive-only restriction).
 */
export function buildEditEnvSchema(): RequestedSchema {
  return {
    type: 'object',
    properties: {
      env_json: {
        type: 'string',
        description: 'JSON object of env keys → string values.',
      },
      edit_service: {
        type: 'string',
        description:
          'Stack-spec service name to edit (omit for single-service spec).',
      },
    },
    required: ['env_json'],
  };
}

export function buildReplaceSpecSchema(): RequestedSchema {
  return {
    type: 'object',
    properties: {
      spec_json: {
        type: 'string',
        description: 'Replacement AppDeploySpec as JSON.',
      },
    },
    required: ['spec_json'],
  };
}

/**
 * Build the SKU-pick elicitation schema. `enum` is sku uuids; `enumNames`
 * are human labels of the form "<name> @ <providerUuid> (<amount><denom>)".
 * The price suffix is omitted when no price is available.
 */
export function buildSkuPickSchema(
  candidates: readonly SkuCandidate[],
): RequestedSchema {
  return {
    type: 'object',
    properties: {
      sku_uuid: {
        type: 'string',
        enum: candidates.map((c) => c.skuUuid),
        // name / providerUuid / price are provider-controlled on-chain strings
        // rendered as labels by the host — sanitize each component so a hostile
        // SKU cannot inject newlines/control chars into the pick list (ENG-555).
        // Structure chars (@, parens) stay literal so the label shape is intact.
        enumNames: candidates.map((c) => {
          const name = sanitizeForDisplay(c.name, 64, '(unnamed SKU)');
          const provider = sanitizeForDisplay(
            c.providerUuid,
            64,
            '(unknown provider)',
          );
          const price = c.price
            ? ` (${sanitizeForDisplay(`${c.price.amount}${c.price.denom}`, 48)})`
            : '';
          return `${name} @ ${provider}${price}`;
        }),
        description: 'Which SKU (and therefore which provider) to deploy to.',
      },
    },
    required: ['sku_uuid'],
  };
}

/**
 * Parse the SKU-pick elicitation result into the chosen pin. Dismiss/timeout →
 * OPERATION_CANCELLED: no on-chain state exists at resolution time, so
 * cancelling is the safe default (mirrors the onPlan reject path).
 */
export function parseSkuChoice(
  result: ElicitResult,
  candidates: readonly SkuCandidate[],
): { skuUuid: string; providerUuid: string } {
  if (result.action !== 'accept') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
      'User dismissed the SKU disambiguation prompt; deployment cancelled.',
    );
  }
  const skuUuid = readContentString(result, 'sku_uuid');
  const hit = candidates.find((c) => c.skuUuid === skuUuid);
  if (!hit) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `parseSkuChoice: "${skuUuid ?? '<none>'}" is not one of the offered SKU uuids.`,
    );
  }
  return { skuUuid: hit.skuUuid, providerUuid: hit.providerUuid };
}

// ----------------------------------------------------------------------
// ElicitResult parsers
// ----------------------------------------------------------------------

/**
 * Per `@modelcontextprotocol/sdk@1.27.1` (`types.d.ts:5372-5377`):
 *   - `accept`  — user filled the form; `content` carries the answers
 *   - `decline` — user explicitly declined the prompt
 *   - `cancel`  — user cancelled (e.g. host timeout / dismiss)
 *
 * For the binary yes/no callbacks both `decline` and `cancel` collapse
 * to `'no'`. For the plan picker both collapse to `'cancel'`. For the
 * recovery picker (post Phase-2 finding #1) we synthesize the
 * lease-preserving `salvage_without_domain` default — guaranteed by
 * agent-core's `render-partial-success-prompt.ts` to be present in the
 * supplied options[] — and only throw `INVALID_CONFIG` defensively if
 * that option is unexpectedly missing. Callers should also surface a
 * warning notification (see `callbacks.ts`) so the user knows the
 * prompt was dismissed and which default was applied.
 */

function readContentString(
  result: ElicitResult,
  key: string,
): string | undefined {
  const content = result.content;
  if (content === undefined || content === null) return undefined;
  const v = (content as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** Parse the `onConfirm` elicitation result. */
export function parseConfirmVerdict(result: ElicitResult): 'yes' | 'no' {
  if (result.action !== 'accept') return 'no';
  const verdict = readContentString(result, 'verdict');
  return verdict === 'yes' ? 'yes' : 'no';
}

/** Parse the `onPlan` elicitation result. */
export function parsePlanVerdict(
  result: ElicitResult,
): PlanEdit | 'confirm' | 'cancel' {
  if (result.action !== 'accept') return 'cancel';
  const verdict = readContentString(result, 'verdict');
  if (verdict === 'confirm') return 'confirm';
  if (verdict === 'cancel') return 'cancel';
  if (verdict === 'edit_env') {
    const envJson = readContentString(result, 'env_json') ?? '';
    let env: Record<string, string>;
    try {
      const parsed = JSON.parse(envJson) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error('env_json must parse to a JSON object.');
      }
      const entries: [string, string][] = [];
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          throw new Error(
            `env_json["${k}"] must be a string; got ${typeof v}.`,
          );
        }
        entries.push([k, v]);
      }
      env = Object.fromEntries(entries);
    } catch (err) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `parsePlanVerdict: failed to parse env_json as Record<string,string>: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const service = readContentString(result, 'edit_service');
    return service !== undefined && service.length > 0
      ? { kind: 'edit_env', service, env }
      : { kind: 'edit_env', env };
  }
  if (verdict === 'replace_spec') {
    const specJson = readContentString(result, 'spec_json') ?? '';
    let spec: AppDeploySpec;
    try {
      const parsed = JSON.parse(specJson) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error('spec_json must parse to a JSON object.');
      }
      // Structural validation is agent-core's responsibility — `applyPlanEdit`
      // re-runs `validateSpec` on the post-edit spec (deploy-app.ts:286-295).
      // We only assert the JSON-shape minimum here.
      spec = parsed as AppDeploySpec;
    } catch (err) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `parsePlanVerdict: failed to parse spec_json as AppDeploySpec: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { kind: 'replace_spec', spec };
  }
  // Unknown verdict — treat as cancel rather than fabricating a PlanEdit.
  return 'cancel';
}

/**
 * Parse the `onFailure(env, options)` recovery picker.
 *
 * Phase 2 (finding #1): when the user dismisses the prompt (action =
 * `decline` / `cancel`), default to `salvage_without_domain` rather
 * than throwing. agent-core unconditionally includes that option in
 * every recovery-options array (see
 * `agent-core/src/internals/render-partial-success-prompt.ts:104`); it
 * is the lease-preserving "do nothing destructive" branch — keeps the
 * lease intact and skips the failing set-domain step. The previous
 * throw left the partial-success lease orphaned on-chain and surfaced
 * a misleading `INVALID_CONFIG` to the user.
 *
 * The caller (`makeDeployCallbacks` in `callbacks.ts`) re-inspects
 * `result.action` after this returns and emits a `notifications/message`
 * (level `warning`) so the user knows the prompt was dismissed and
 * which default was applied.
 *
 * Defensive: if `salvage_without_domain` is somehow missing from
 * `options[]` — which would mean agent-core changed its invariant —
 * fall back to throwing `INVALID_CONFIG` so the wrapper fails loudly
 * rather than silently inventing a different recovery action.
 *
 * Accept path is unchanged: a non-enum `choice` still throws.
 */
export function parseRecoveryChoice(
  result: ElicitResult,
  options: readonly RecoveryOption[],
): RecoveryChoice {
  if (result.action !== 'accept') {
    const fallback = options.find((o) => o.id === 'salvage_without_domain');
    if (fallback === undefined) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `parseRecoveryChoice: user dismissed prompt (action=${result.action}) ` +
          'and no safe default ("salvage_without_domain") was offered in the options array.',
      );
    }
    return { id: fallback.id };
  }
  const choice = readContentString(result, 'choice');
  if (choice === undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'parseRecoveryChoice: elicitation result missing `content.choice`.',
    );
  }
  const allowed = new Set<RecoveryOptionId>(options.map((o) => o.id));
  if (!allowed.has(choice as RecoveryOptionId)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `parseRecoveryChoice: "${choice}" is not one of the offered options (${options
        .map((o) => o.id)
        .join(', ')}).`,
    );
  }
  return { id: choice as RecoveryOptionId };
}
