import type { RecoveryOptionId } from '../types.js';

/**
 * Render the prompt body + recovery-option set for `deployApp`'s
 * partial-success recovery branch. Mirrors the structural template
 * pinned in `manifest-agent-plugin/scripts/render-partial-success-prompt.cjs`
 * (plugin git-hash `3a33e80`) — wording stays consistent across runs
 * regardless of LLM paraphrase tendencies.
 *
 * **Conditional inserts:** wording differs by whether a `customDomain`
 * was requested. When absent, the failure description shifts to a
 * generic "manifest upload or readiness poll failed" framing and the
 * `retry_set_domain` recovery option is omitted (it's meaningless
 * without a domain request to retry).
 *
 * The CJS emits a single-line JSON object on stdout
 * (`{ prompt, options: string[] }`). The TS port returns a structured
 * `PartialSuccessPrompt` with typed `RecoveryOptionId`s, so the
 * `deployApp` orchestrator can route directly into the inline-closure
 * recovery dispatch (per gate-2 verdict) without intermediate
 * stringification.
 *
 * **Note on `decodedState`:** the caller is expected to have already
 * decoded the chain integer / `LEASE_STATE_*` string via
 * `lease-state.ts:decode` and pass the canonical name (or a
 * `UNKNOWN(<raw>)` sentinel for unrecognized values). This module does
 * not re-decode — the canonical name is shown verbatim in the lease
 * status line so an explicit `LEASE_STATE_` prefix is preserved (the
 * partial-success path surfaces the raw lease state for diagnostic
 * fidelity, unlike `formatSuccess` which strips the prefix for display).
 */

/** RFC 4122 UUID — 36 chars, hex + 4 hyphens, lowercase or upper. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RenderPartialSuccessPromptInput {
  /** The lease UUID created on-chain (validated RFC 4122). */
  leaseUuid: string;
  /** Canonical lease state name (e.g. `LEASE_STATE_PENDING`) — pre-decoded. */
  decodedState: string;
  /** Failure reason from the MCP error envelope or `classifyDeployError`. */
  reason: string;
  /** Optional: FQDN the user requested. Presence drives wording + retry option. */
  requestedCustomDomain?: string;
}

export interface PartialSuccessPrompt {
  /** Multi-line prompt body to pass to AskUserQuestion. */
  prompt: string;
  /**
   * Recovery options offered to the user. `retry_set_domain` is omitted
   * when no domain was requested. Order matches the CJS's option list.
   */
  options: RecoveryOptionId[];
}

export function renderPartialSuccessPrompt(
  input: RenderPartialSuccessPromptInput,
): PartialSuccessPrompt {
  if (!UUID_RE.test(input.leaseUuid)) {
    throw new TypeError(
      `renderPartialSuccessPrompt: leaseUuid must be a UUID; got "${input.leaseUuid}"`,
    );
  }
  if (
    typeof input.decodedState !== 'string' ||
    input.decodedState.length === 0
  ) {
    throw new TypeError(
      'renderPartialSuccessPrompt: decodedState must be a non-empty string',
    );
  }
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    throw new TypeError(
      'renderPartialSuccessPrompt: reason must be a non-empty string',
    );
  }

  const hasDomain =
    typeof input.requestedCustomDomain === 'string' &&
    input.requestedCustomDomain.length > 0;

  const lines: string[] = [
    'Deploy partially succeeded:',
    `  - Lease ${input.leaseUuid} was created on-chain (state: ${input.decodedState}).`,
  ];
  if (hasDomain) {
    lines.push(
      `  - The set-domain step for ${input.requestedCustomDomain} did NOT complete: ${input.reason}.`,
      '    The manifest was therefore NEVER uploaded to the provider — no app is running on this lease.',
    );
  } else {
    lines.push(
      `  - The manifest upload or readiness poll failed: ${input.reason}.`,
      '    The provider may or may not have started the app.',
    );
  }
  lines.push('', 'What do you want to do?');

  const options: RecoveryOptionId[] = [];
  if (hasDomain) {
    options.push('retry_set_domain');
  }
  options.push('salvage_without_domain');
  // CJS emits "Cancel or close the lease" as a single user-facing option
  // (3 total when hasDomain, 2 when not). The typed `RecoveryOptionId`
  // vocabulary splits this into two discrete IDs (`cancel_lease`,
  // `close_lease`) for the orchestrator's typed dispatch — `cancel_lease`
  // applies pre-active (abort without on-chain close); `close_lease`
  // applies post-active (on-chain close-lease tx). To preserve the CJS's
  // observable user-option count, we surface the more-general
  // `close_lease` here as the unified terminal choice; the orchestrator's
  // inline-closure dispatch (see `deploy-app.ts`, gate-2 verdict) inspects
  // the lease state at recovery time and routes to the precise terminal
  // tx. `cancel_lease` remains reachable from verify-recover-driven
  // non-user-prompted paths (e.g. terminal lease detected before user
  // input is solicited).
  options.push('close_lease');

  return { prompt: lines.join('\n'), options };
}
