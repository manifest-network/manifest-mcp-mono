/**
 * Unit tests for callback factories in `callbacks.ts`.
 *
 * Mock strategy: construct minimal `server` / `extra` stubs directly —
 * no MCP transport is needed for these unit tests. Only `server.elicitInput`
 * and `extra.sendNotification` are called by the factories.
 */

import type { SkuCandidate } from '@manifest-network/manifest-agent-core';
import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { makeDeployCallbacks } from './callbacks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExtra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn(),
    requestId: 'test-req-id',
    _meta: {},
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

// ---------------------------------------------------------------------------
// makeDeployCallbacks — onResolveSku
// ---------------------------------------------------------------------------

describe('makeDeployCallbacks', () => {
  it('ENG-258: onResolveSku elicits a pick and returns the pin', async () => {
    const elicitInput = vi
      .fn()
      .mockResolvedValue({ action: 'accept', content: { sku_uuid: 'b' } });
    const server = {
      elicitInput,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const extra = makeExtra();
    const cbs = makeDeployCallbacks({ server, extra });

    const candidates: SkuCandidate[] = [
      {
        skuUuid: 'a',
        providerUuid: 'p1',
        name: 'docker-micro',
        active: true,
      },
      {
        skuUuid: 'b',
        providerUuid: 'p2',
        name: 'docker-micro',
        active: true,
      },
    ];

    const pick = await cbs.onResolveSku!(candidates);
    expect(pick).toEqual({ skuUuid: 'b', providerUuid: 'p2' });
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });

  it('ENG-258: onResolveSku message mentions N SKUs', async () => {
    const elicitInput = vi
      .fn()
      .mockResolvedValue({ action: 'accept', content: { sku_uuid: 'a' } });
    const server = {
      elicitInput,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const extra = makeExtra();
    const cbs = makeDeployCallbacks({ server, extra });

    const candidates: SkuCandidate[] = [
      { skuUuid: 'a', providerUuid: 'p1', name: 'docker-micro', active: true },
      { skuUuid: 'b', providerUuid: 'p2', name: 'docker-micro', active: true },
    ];

    await cbs.onResolveSku!(candidates);

    const callArgs = elicitInput.mock.calls[0][0] as { message: string };
    expect(callArgs.message).toContain('2');
  });

  it('ENG-258: onResolveSku REJECTS with OPERATION_CANCELLED when the pick is dismissed', async () => {
    // Safety-critical: a dismissed SKU prompt must NOT silently default to a
    // pick or swallow the cancel — it must propagate OPERATION_CANCELLED so
    // deployApp aborts before any broadcast (no on-chain state exists yet).
    const elicitInput = vi.fn().mockResolvedValue({ action: 'cancel' });
    const server = {
      elicitInput,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const extra = makeExtra();
    const cbs = makeDeployCallbacks({ server, extra });

    const candidates: SkuCandidate[] = [
      { skuUuid: 'a', providerUuid: 'p1', name: 'docker-micro', active: true },
      { skuUuid: 'b', providerUuid: 'p2', name: 'docker-micro', active: true },
    ];

    await expect(cbs.onResolveSku!(candidates)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
  });

  it('ENG-272 parity: onResolveSku emits warning notification and throws OPERATION_CANCELLED when elicitInput REJECTS', async () => {
    // When the elicitation promise itself REJECTS (timeout / host abort /
    // transport close), onResolveSku must: (1) emit a warning
    // notifications/message for observability, (2) throw OPERATION_CANCELLED
    // so deployApp aborts. This is parity with onConfirm / onPlan (ENG-272).
    const rejectErr = Object.assign(new Error('Request timed out'), {
      code: -32001 /* ErrorCode.RequestTimeout */,
    });
    const elicitInput = vi.fn().mockRejectedValue(rejectErr);
    const server = {
      elicitInput,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const extra = makeExtra();
    const cbs = makeDeployCallbacks({ server, extra });

    const candidates: SkuCandidate[] = [
      { skuUuid: 'a', providerUuid: 'p1', name: 'docker-micro', active: true },
      { skuUuid: 'b', providerUuid: 'p2', name: 'docker-micro', active: true },
    ];

    await expect(cbs.onResolveSku!(candidates)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });

    // A warning notification should have been emitted.
    const sendNotification = extra.sendNotification as ReturnType<typeof vi.fn>;
    const warningCalls = sendNotification.mock.calls.filter(
      (call) =>
        (call[0] as { method: string }).method === 'notifications/message' &&
        (call[0] as { params: { level: string } }).params.level === 'warning',
    );
    expect(warningCalls).toHaveLength(1);
    const warningData = (
      warningCalls[0][0] as {
        params: {
          data: { kind: string; callback: string; applied_default: string };
        };
      }
    ).params.data;
    expect(warningData.kind).toBe('elicit_timeout');
    expect(warningData.callback).toBe('onResolveSku');
    expect(warningData.applied_default).toBe('cancel');
  });
});
