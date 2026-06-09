/**
 * Callback factories — bridge agent-core's typed callback contract onto
 * MCP elicitation + notification primitives.
 *
 * Each factory closes over:
 *   - `server: Server` — for `server.elicitInput(...)`.
 *   - `extra: RequestHandlerExtra<...>` — for `extra.sendNotification(...)`,
 *     which threads the emitted notification onto the in-flight tool
 *     call's stream so hosts can correlate it with the originating call.
 *
 * Translation rules (per PLAN.md §2):
 *   - `onProgress(event)`      → `notifications/progress` + best-effort
 *                                 `notifications/message` (level=`info`).
 *   - `onConfirm(block)`       → `elicitInput` with the yes/no schema,
 *                                 `message = block.text` (passed
 *                                 verbatim from agent-core's render).
 *   - `onPlan(plan)`           → `elicitInput` with the plan schema.
 *                                 `message` is the most recent
 *                                 `deployment_plan_rendered` progress
 *                                 event's `block.text` (captured by
 *                                 listening to our own outbound
 *                                 progress stream). Falls back to a
 *                                 plan-summary JSON when no block has
 *                                 been observed yet (defensive — the
 *                                 orchestrator always emits the event
 *                                 before invoking `onPlan` in
 *                                 deploy-app.ts:250).
 *   - `onFailure(env, opts)`   → `elicitInput` with the recovery picker.
 *                                 `message` concatenates `env.reason`
 *                                 with the agent-core-supplied option
 *                                 `label` / `description` strings
 *                                 (mechanical assembly of agent-core
 *                                 data, not prose composition — see
 *                                 PLAN.md §2.4 + the "no re-rendering"
 *                                 directive).
 *   - `onFailure(failure)`     → `notifications/message` (level=`error`).
 *     (simple-form)             No elicitation.
 *   - `onComplete(result)`     → no-op in the wrapper. The tool's
 *                                 return value is the structured success
 *                                 signal that hosts consume.
 */

import type {
  CloseLeaseCallbacks,
  CloseLeaseResult,
  DeployAppCallbacks,
  DeploymentPlanBlock,
  DeployResult,
  FailureEnvelope,
  ManageDomainCallbacks,
  ManageDomainResult,
  Plan,
  PlanEdit,
  ProgressEvent,
  RecoveryChoice,
  RecoveryOption,
  SkuCandidate,
  TroubleshootCallbacks,
  TroubleshootReport,
} from '@manifest-network/manifest-agent-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  RequestHandlerExtra,
  RequestOptions,
} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ErrorCode,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildConfirmSchema,
  buildPlanSchema,
  buildRecoverySchema,
  buildSkuPickSchema,
  parseConfirmVerdict,
  parsePlanVerdict,
  parseRecoveryChoice,
  parseSkuChoice,
} from './elicitation.js';

// ----------------------------------------------------------------------
// Shared factory context
// ----------------------------------------------------------------------

export interface CallbackFactoryArgs {
  readonly server: Server;
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
}

// ----------------------------------------------------------------------
// Elicitation request-options
// ----------------------------------------------------------------------

/**
 * Default elicitation timeout: 10 minutes. The SDK default
 * (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000` ms) is far too short for a
 * human reading a deployment-plan recap. Operators can override via
 * `MANIFEST_AGENT_ELICIT_TIMEOUT_MS` (positive integer, milliseconds);
 * malformed values fall back to the default.
 */
const ELICIT_TIMEOUT_MS = ((): number => {
  const raw = process.env.MANIFEST_AGENT_ELICIT_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return 10 * 60_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
})();

/**
 * Build the `RequestOptions` second-arg every `server.elicitInput()`
 * call passes. Two roles, both critical for an interactive flow:
 *
 *   1. `timeout` — long enough for a human to read the plan recap,
 *      open the partial-success prompt and pick a recovery option.
 *   2. `signal` — host cancellation must propagate to the in-flight
 *      `elicitation/create`. Without this, host cancel fires the abort
 *      but the SDK keeps the elicitation pending until its own request
 *      timeout, holding wallet / rate-limiter locks.
 */
function elicitOptions(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): RequestOptions {
  return { timeout: ELICIT_TIMEOUT_MS, signal: extra.signal };
}

/**
 * Classify why a `server.elicitInput(...)` promise REJECTED (as opposed
 * to resolving with a `decline` / `cancel` action). The SDK turns three
 * distinct conditions into a thrown `McpError`:
 *
 *   - the per-request `timeout` elapsed → `ErrorCode.RequestTimeout`
 *     (also the code the abort `signal` path surfaces — the SDK wraps the
 *     `AbortSignal` reason into a RequestTimeout `McpError`);
 *   - the transport closed mid-request → `ErrorCode.ConnectionClosed`.
 *
 * The returned tag is advisory only — it drives the human-readable
 * `dismissed_action` field on the warning notification. Every rejection
 * leads each call site to the SAME safe default (ENG-272); the tag never
 * changes which default is applied.
 *
 * The discriminator is the numeric `err.code`, deliberately NOT
 * `instanceof McpError`: under monorepo hoisting two copies of the SDK
 * can coexist, so a cross-module `instanceof McpError` is unreliable
 * (a thrown error from the other copy would fail the check). The numeric
 * `ErrorCode` constant is stable across instances, so comparing the raw
 * `.code` covers every `McpError` regardless of which SDK copy minted it.
 * Do NOT re-add an `instanceof McpError` branch here — it would be dead
 * code (the numeric check already matched any value it could catch).
 */
function classifyElicitReject(
  err: unknown,
): 'timeout' | 'connection_closed' | 'unknown' {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === ErrorCode.RequestTimeout) return 'timeout';
  if (code === ErrorCode.ConnectionClosed) return 'connection_closed';
  return 'unknown';
}

/**
 * Best-effort message extraction for the warning notification `reason`
 * field. Never throws — falls back to a constant when `err` is not an
 * `Error`.
 */
function elicitRejectMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'elicitation rejected';
}

// ----------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------

/**
 * Resolve a `progressToken` for the in-flight request. MCP requires
 * tokens to be string or number; if the client did not include one
 * in the original request's `_meta`, we synthesize a string from the
 * request ID so notifications still correlate to *some* identifier
 * the host can group on.
 */
function resolveProgressToken(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): string | number {
  const fromMeta = extra._meta?.progressToken;
  if (typeof fromMeta === 'string' || typeof fromMeta === 'number') {
    return fromMeta;
  }
  return `agent-${String(extra.requestId)}`;
}

/**
 * Best-effort notification sender. `sendNotification` can reject (closed
 * transport, validation, etc.); a failed notification must never escape
 * a tool handler because that would abort the whole orchestration mid-
 * flow. Mirrors agent-core's tolerance of a missing `onProgress` —
 * progress is informational, never load-bearing.
 */
async function safeNotify(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  notification: ServerNotification,
): Promise<void> {
  try {
    await extra.sendNotification(notification);
  } catch {
    // swallow — progress is best-effort by contract
  }
}

/**
 * Emit one `notifications/progress` and one `notifications/message`
 * (level `info`) per agent-core `ProgressEvent`. The full typed event
 * is JSON-stringified into the `progress.message` field so hosts that
 * only render progress see the kind + payload, and the same payload
 * lands in the log stream for hosts that subscribe to logs.
 */
async function emitProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  event: ProgressEvent,
  progressIndex: number,
): Promise<void> {
  const token = resolveProgressToken(extra);
  const message = JSON.stringify(event);
  await safeNotify(extra, {
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress: progressIndex,
      message,
    },
  });
  await safeNotify(extra, {
    method: 'notifications/message',
    params: {
      level: 'info',
      logger: '@manifest-network/manifest-mcp-agent',
      data: { kind: 'progress', event },
    },
  });
}

/**
 * Emit a `notifications/message` (level `error`) for the simple-form
 * `onFailure({ reason })`. No elicitation.
 */
async function emitFailure(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  reason: string,
): Promise<void> {
  await safeNotify(extra, {
    method: 'notifications/message',
    params: {
      level: 'error',
      logger: '@manifest-network/manifest-mcp-agent',
      data: { kind: 'failure', reason },
    },
  });
}

/**
 * Assemble the recovery elicitation `message` from agent-core-supplied
 * strings only (PLAN.md §2.4 + "no re-rendering" directive — the
 * wrapper sequences agent-core data, it does not compose new prose).
 * The `reason` comes from `FailureEnvelope` (which agent-core derives
 * from `classifyDeployError`); the option `label` / `description`
 * strings come from agent-core's `recoveryOptionLabel` /
 * `recoveryOptionDescription` helpers in `deploy-app.ts`.
 */
function renderRecoveryMessage(
  envelope: FailureEnvelope,
  options: readonly RecoveryOption[],
): string {
  const lines: string[] = [envelope.reason];
  if (options.length > 0) {
    lines.push('');
    lines.push('Available recovery actions:');
    for (const opt of options) {
      lines.push(`  - ${opt.label}: ${opt.description}`);
    }
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------
// makeDeployCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `deployApp`. The deploy path is the
 * only one with `onPlan` and rich `onFailure(env, options)` callbacks.
 */
export function makeDeployCallbacks(
  args: CallbackFactoryArgs,
): DeployAppCallbacks {
  const { server, extra } = args;
  let progressIndex = 0;
  // Capture the most recent rendered plan block so `onPlan` can pass
  // it as the elicitation `message` verbatim. Set by `onProgress` when
  // a `deployment_plan_rendered` event arrives — which agent-core
  // emits BEFORE invoking `onPlan` (deploy-app.ts:250).
  let latestPlanBlock: DeploymentPlanBlock | null = null;

  return {
    onProgress: (event: ProgressEvent): void => {
      if (event.kind === 'deployment_plan_rendered') {
        latestPlanBlock = event.block;
      }
      const idx = progressIndex++;
      // Fire-and-forget. `safeNotify` swallows transport errors;
      // we do NOT await because `onProgress` is sync-by-contract
      // (`DeployAppCallbacks.onProgress: (event) => void`).
      void emitProgress(extra, event, idx);
    },
    onPlan: async (plan: Plan): Promise<PlanEdit | 'confirm' | 'cancel'> => {
      const message =
        latestPlanBlock?.text ??
        `Deployment plan (no rendered block captured):\n${JSON.stringify(plan.summary, null, 2)}`;
      let result: Awaited<ReturnType<typeof server.elicitInput>>;
      try {
        result = await server.elicitInput(
          { message, requestedSchema: buildPlanSchema() },
          elicitOptions(extra),
        );
      } catch (err) {
        // ENG-272: a REJECTED plan elicitation (timeout / host abort /
        // transport close) is NOT an approval. Apply the safe default —
        // `'cancel'` — so the deployment never proceeds. No on-chain
        // state exists at plan time, so cancelling is fully safe.
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'elicit_timeout',
              callback: 'onPlan',
              dismissed_action: classifyElicitReject(err),
              applied_default: 'cancel',
              reason: elicitRejectMessage(err),
            },
          },
        });
        return 'cancel';
      }
      return parsePlanVerdict(result);
    },
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      let result: Awaited<ReturnType<typeof server.elicitInput>>;
      try {
        result = await server.elicitInput(
          { message: block.text, requestedSchema: buildConfirmSchema() },
          elicitOptions(extra),
        );
      } catch (err) {
        // ENG-272: a REJECTED intent-recap confirmation is NOT a "yes".
        // The fred broadcast has not fired yet (no on-chain state), so the
        // safe default is `'no'` — agent-core then throws
        // OPERATION_CANCELLED and nothing is broadcast.
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'elicit_timeout',
              callback: 'onConfirm',
              dismissed_action: classifyElicitReject(err),
              applied_default: 'no',
              reason: elicitRejectMessage(err),
            },
          },
        });
        return 'no';
      }
      return parseConfirmVerdict(result);
    },
    onFailure: async (
      failure: FailureEnvelope,
      options: RecoveryOption[],
    ): Promise<RecoveryChoice> => {
      const message = renderRecoveryMessage(failure, options);
      let result: Awaited<ReturnType<typeof server.elicitInput>>;
      try {
        result = await server.elicitInput(
          { message, requestedSchema: buildRecoverySchema(options) },
          elicitOptions(extra),
        );
      } catch (err) {
        // ENG-272 (highest-risk site): a lease has ALREADY been paid for
        // on-chain by the time `onFailure` fires. A REJECTED recovery
        // picker (timeout / host abort / transport close) must NOT
        // destroy that lease. Synthesize a `{ action: 'cancel' }` result
        // and route it through the existing `parseRecoveryChoice` so the
        // lone lease-preserving default (`salvage_without_domain`) is
        // applied — it never calls `stopApp`. (`parseRecoveryChoice`'s
        // own defensive INVALID_CONFIG guard still covers an empty
        // `options[]`, which agent-core never produces.)
        const dismissedAction = classifyElicitReject(err);
        const choice = parseRecoveryChoice({ action: 'cancel' }, options);
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'recovery_dismissed',
              dismissed_action: dismissedAction,
              applied_default: choice.id,
              reason:
                'Recovery prompt rejected (timeout/abort/transport close); ' +
                'applied lease-preserving default. The lease still exists — ' +
                'manually invoke close_lease_orchestrated or ' +
                'manage_domain_orchestrated if you wanted a different outcome.',
            },
          },
        });
        return choice;
      }
      const choice = parseRecoveryChoice(result, options);
      // Phase 2 (finding #1): when the user dismissed the prompt,
      // `parseRecoveryChoice` synthesized the lease-preserving default
      // (`salvage_without_domain`). Surface that decision to the user
      // via a `notifications/message` (warning) so they aren't
      // surprised — the lease still exists; they can manually invoke
      // `close_lease_orchestrated` or `manage_domain_orchestrated` if
      // they wanted a different outcome.
      if (result.action !== 'accept') {
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'recovery_dismissed',
              dismissed_action: result.action,
              applied_default: choice.id,
              reason:
                'User dismissed the recovery prompt; applied lease-preserving default. ' +
                'Manually invoke close_lease_orchestrated or manage_domain_orchestrated if needed.',
            },
          },
        });
      }
      return choice;
    },
    onComplete: (_result: DeployResult): void => {
      // Tool return value carries the structured success signal.
    },
    onResolveSku: async (
      candidates: SkuCandidate[],
    ): Promise<{ skuUuid: string; providerUuid: string }> => {
      const message =
        `The requested SKU name maps to ${candidates.length} SKUs across providers. ` +
        'Choose which to deploy to:';
      const result = await server.elicitInput(
        { message, requestedSchema: buildSkuPickSchema(candidates) },
        elicitOptions(extra),
      );
      // Dismiss/timeout → parseSkuChoice throws OPERATION_CANCELLED (safe: no
      // on-chain state at resolution time). Let it propagate; deployApp aborts.
      return parseSkuChoice(result, candidates);
    },
  };
}

// ----------------------------------------------------------------------
// makeManageDomainCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `manageDomain` (set / clear only —
 * the read-only lookup path now lives behind
 * `lookup_custom_domain_orchestrated`, see ENG-212 +
 * `makeLookupDomainCallbacks`). Simple-form `onFailure({ reason })`;
 * exactly one elicitation per call (the `onConfirm` block).
 */
export function makeManageDomainCallbacks(
  args: CallbackFactoryArgs,
): ManageDomainCallbacks {
  const { server, extra } = args;
  let progressIndex = 0;
  return {
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      let result: Awaited<ReturnType<typeof server.elicitInput>>;
      try {
        result = await server.elicitInput(
          { message: block.text, requestedSchema: buildConfirmSchema() },
          elicitOptions(extra),
        );
      } catch (err) {
        // ENG-272: a REJECTED confirmation must NOT broadcast the
        // set/clear-domain transaction. The safe default is `'no'`;
        // agent-core then throws OPERATION_CANCELLED and no on-chain
        // state is modified.
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'elicit_timeout',
              callback: 'onConfirm',
              dismissed_action: classifyElicitReject(err),
              applied_default: 'no',
              reason: elicitRejectMessage(err),
            },
          },
        });
        return 'no';
      }
      return parseConfirmVerdict(result);
    },
    onProgress: (event: ProgressEvent): void => {
      const idx = progressIndex++;
      void emitProgress(extra, event, idx);
    },
    onComplete: (_result: ManageDomainResult): void => {
      // Tool return value carries the structured success signal.
    },
    onFailure: async (failure: { reason: string }): Promise<void> => {
      await emitFailure(extra, failure.reason);
    },
  };
}

// ----------------------------------------------------------------------
// makeLookupDomainCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for the read-only custom-domain lookup
 * (`lookup_custom_domain_orchestrated`, ENG-212). Although it reuses
 * agent-core's unified `manageDomain` (with `{ action: 'lookup' }`),
 * the `lookupDomain` branch is a pure chain query — it never invokes
 * `onConfirm`. Supplying one would be dead code, so this factory omits
 * it entirely (mirrors `makeTroubleshootCallbacks`). The wrapper also
 * skips `assertElicitationCapability` for this tool — see `index.ts`.
 */
export function makeLookupDomainCallbacks(
  args: CallbackFactoryArgs,
): ManageDomainCallbacks {
  const { extra } = args;
  let progressIndex = 0;
  return {
    onProgress: (event: ProgressEvent): void => {
      const idx = progressIndex++;
      void emitProgress(extra, event, idx);
    },
    onComplete: (_result: ManageDomainResult): void => {
      // Tool return value carries the structured lookup result.
    },
    onFailure: async (failure: { reason: string }): Promise<void> => {
      await emitFailure(extra, failure.reason);
    },
  };
}

// ----------------------------------------------------------------------
// makeTroubleshootCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `troubleshootDeployment`. Read-only
 * chain query — no `onConfirm` (agent-core's `troubleshoot.ts` never
 * invokes that callback; supplying one was dead code, finding #11).
 * The wrapper also skips `assertElicitationCapability` for this tool —
 * see `index.ts`.
 */
export function makeTroubleshootCallbacks(
  args: CallbackFactoryArgs,
): TroubleshootCallbacks {
  const { extra } = args;
  let progressIndex = 0;
  return {
    onProgress: (event: ProgressEvent): void => {
      const idx = progressIndex++;
      void emitProgress(extra, event, idx);
    },
    onComplete: (_result: TroubleshootReport): void => {
      // Tool return value carries the structured report.
    },
    onFailure: async (failure: { reason: string }): Promise<void> => {
      await emitFailure(extra, failure.reason);
    },
  };
}

// ----------------------------------------------------------------------
// makeCloseLeaseCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `closeLease`. Same shape as
 * manage-domain / troubleshoot — one `onConfirm` elicitation, simple-
 * form `onFailure`.
 */
export function makeCloseLeaseCallbacks(
  args: CallbackFactoryArgs,
): CloseLeaseCallbacks {
  const { server, extra } = args;
  let progressIndex = 0;
  return {
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      let result: Awaited<ReturnType<typeof server.elicitInput>>;
      try {
        result = await server.elicitInput(
          { message: block.text, requestedSchema: buildConfirmSchema() },
          elicitOptions(extra),
        );
      } catch (err) {
        // ENG-272: `onConfirm` gates the destructive close-lease
        // (MsgCloseLease) broadcast. A REJECTED confirmation must leave
        // the lease OPEN — the maximally conservative outcome. The safe
        // default is `'no'`; agent-core then throws OPERATION_CANCELLED
        // and `stopApp` is never called.
        await safeNotify(extra, {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: '@manifest-network/manifest-mcp-agent',
            data: {
              kind: 'elicit_timeout',
              callback: 'onConfirm',
              dismissed_action: classifyElicitReject(err),
              applied_default: 'no',
              reason: elicitRejectMessage(err),
            },
          },
        });
        return 'no';
      }
      return parseConfirmVerdict(result);
    },
    onProgress: (event: ProgressEvent): void => {
      const idx = progressIndex++;
      void emitProgress(extra, event, idx);
    },
    onComplete: (_result: CloseLeaseResult): void => {
      // Tool return value carries the structured success signal.
    },
    onFailure: async (failure: { reason: string }): Promise<void> => {
      await emitFailure(extra, failure.reason);
    },
  };
}
