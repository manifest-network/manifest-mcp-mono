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
  TroubleshootCallbacks,
  TroubleshootReport,
} from '@manifest-network/manifest-agent-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildConfirmSchema,
  buildPlanSchema,
  buildRecoverySchema,
  parseConfirmVerdict,
  parsePlanVerdict,
  parseRecoveryChoice,
} from './elicitation.js';

// ----------------------------------------------------------------------
// Shared factory context
// ----------------------------------------------------------------------

export interface CallbackFactoryArgs {
  readonly server: Server;
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
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
      const result = await server.elicitInput({
        message,
        requestedSchema: buildPlanSchema(),
      });
      return parsePlanVerdict(result);
    },
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      const result = await server.elicitInput({
        message: block.text,
        requestedSchema: buildConfirmSchema(),
      });
      return parseConfirmVerdict(result);
    },
    onFailure: async (
      failure: FailureEnvelope,
      options: RecoveryOption[],
    ): Promise<RecoveryChoice> => {
      const message = renderRecoveryMessage(failure, options);
      const result = await server.elicitInput({
        message,
        requestedSchema: buildRecoverySchema(options),
      });
      return parseRecoveryChoice(result, options);
    },
    onComplete: (_result: DeployResult): void => {
      // Tool return value carries the structured success signal.
    },
  };
}

// ----------------------------------------------------------------------
// makeManageDomainCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `manageDomain`. Simple-form
 * `onFailure({ reason })`; one elicitation max per call (the
 * `onConfirm` block on `set` / `clear` — `lookup` skips confirmation).
 */
export function makeManageDomainCallbacks(
  args: CallbackFactoryArgs,
): ManageDomainCallbacks {
  const { server, extra } = args;
  let progressIndex = 0;
  return {
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      const result = await server.elicitInput({
        message: block.text,
        requestedSchema: buildConfirmSchema(),
      });
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
// makeTroubleshootCallbacks
// ----------------------------------------------------------------------

/**
 * Build the callback object for `troubleshootDeployment`. Read-only
 * chain query; `onConfirm` is bidirectional but the result is purely
 * a diagnostic report (no broadcast).
 */
export function makeTroubleshootCallbacks(
  args: CallbackFactoryArgs,
): TroubleshootCallbacks {
  const { server, extra } = args;
  let progressIndex = 0;
  return {
    onConfirm: async (block: DeploymentPlanBlock): Promise<'yes' | 'no'> => {
      const result = await server.elicitInput({
        message: block.text,
        requestedSchema: buildConfirmSchema(),
      });
      return parseConfirmVerdict(result);
    },
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
      const result = await server.elicitInput({
        message: block.text,
        requestedSchema: buildConfirmSchema(),
      });
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
