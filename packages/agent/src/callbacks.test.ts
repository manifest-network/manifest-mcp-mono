/**
 * Unit tests for callback factories in `callbacks.ts`.
 *
 * Mock strategy: construct minimal `server` / `extra` stubs directly —
 * no MCP transport is needed for these unit tests. Only `server.elicitInput`
 * and `extra.sendNotification` are called by the factories.
 */

import type {
  RecoveryOption,
  SkuCandidate,
} from '@manifest-network/manifest-agent-core';
import {
  asProviderUuid,
  asSkuUuid,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeployCallbacks } from './callbacks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExtra(
  signal = new AbortController().signal,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn(),
    requestId: 'test-req-id',
    _meta: {},
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function makeSkuCandidates(): SkuCandidate[] {
  return [
    {
      skuUuid: asSkuUuid('a'),
      providerUuid: asProviderUuid('p1'),
      name: 'docker-micro',
      active: true,
    },
    {
      skuUuid: asSkuUuid('b'),
      providerUuid: asProviderUuid('p2'),
      name: 'docker-micro',
      active: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// makeDeployCallbacks — onResolveSku
// ---------------------------------------------------------------------------

describe('makeDeployCallbacks', () => {
  describe('elicitation timeout', () => {
    const envName = 'MANIFEST_AGENT_ELICIT_TIMEOUT_MS';
    let original: string | undefined;

    beforeEach(() => {
      original = process.env[envName];
    });

    afterEach(() => {
      if (original === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = original;
      }
    });

    it('reads the operator override at each elicitation call', async () => {
      const elicitInput = vi
        .fn()
        .mockResolvedValue({ action: 'accept', content: { sku_uuid: 'a' } });
      const server = {
        elicitInput,
        getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
      } as unknown as Server;
      const callbacks = makeDeployCallbacks({ server, extra: makeExtra() });

      process.env[envName] = '12345';
      await callbacks.onResolveSku!(makeSkuCandidates());
      expect(
        (elicitInput.mock.calls[0]?.[1] as { timeout?: number } | undefined)
          ?.timeout,
      ).toBe(12345);

      process.env[envName] = '23456';
      await callbacks.onResolveSku!(makeSkuCandidates());
      expect(
        (elicitInput.mock.calls[1]?.[1] as { timeout?: number } | undefined)
          ?.timeout,
      ).toBe(23456);
    });

    it('falls back to ten minutes for a malformed override', async () => {
      process.env[envName] = '12000ms';
      const elicitInput = vi
        .fn()
        .mockResolvedValue({ action: 'accept', content: { sku_uuid: 'a' } });
      const server = {
        elicitInput,
        getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
      } as unknown as Server;
      const callbacks = makeDeployCallbacks({ server, extra: makeExtra() });

      await callbacks.onResolveSku!(makeSkuCandidates());

      expect(
        (elicitInput.mock.calls[0]?.[1] as { timeout?: number } | undefined)
          ?.timeout,
      ).toBe(600_000);
    });
  });

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
        skuUuid: asSkuUuid('a'),
        providerUuid: asProviderUuid('p1'),
        name: 'docker-micro',
        active: true,
      },
      {
        skuUuid: asSkuUuid('b'),
        providerUuid: asProviderUuid('p2'),
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
      {
        skuUuid: asSkuUuid('a'),
        providerUuid: asProviderUuid('p1'),
        name: 'docker-micro',
        active: true,
      },
      {
        skuUuid: asSkuUuid('b'),
        providerUuid: asProviderUuid('p2'),
        name: 'docker-micro',
        active: true,
      },
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
      {
        skuUuid: asSkuUuid('a'),
        providerUuid: asProviderUuid('p1'),
        name: 'docker-micro',
        active: true,
      },
      {
        skuUuid: asSkuUuid('b'),
        providerUuid: asProviderUuid('p2'),
        name: 'docker-micro',
        active: true,
      },
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
      {
        skuUuid: asSkuUuid('a'),
        providerUuid: asProviderUuid('p1'),
        name: 'docker-micro',
        active: true,
      },
      {
        skuUuid: asSkuUuid('b'),
        providerUuid: asProviderUuid('p2'),
        name: 'docker-micro',
        active: true,
      },
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

  it('ENG-745: recovery rejection uses server-level logging after the request signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const server = {
      elicitInput: vi.fn().mockRejectedValue(new Error('request cancelled')),
      sendLoggingMessage,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const extra = makeExtra(controller.signal);
    const callbacks = makeDeployCallbacks({ server, extra });
    const options: RecoveryOption[] = [
      {
        id: 'retry_set_domain',
        label: 'Retry',
        description: 'Retry the failed step.',
      },
      {
        id: 'salvage_without_domain',
        label: 'Keep lease',
        description: 'Keep the paid lease without its custom domain.',
      },
    ];

    await expect(
      callbacks.onFailure!(
        {
          outcome: 'partially_succeeded',
          leaseUuid: 'lease-paid',
          reason: 'Domain attachment failed after lease creation.',
        },
        options,
      ),
    ).resolves.toEqual({ id: 'salvage_without_domain' });

    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({
          kind: 'recovery_dismissed',
          applied_default: 'salvage_without_domain',
          lease_uuid: 'lease-paid',
        }),
      }),
    );
    expect(extra.sendNotification).not.toHaveBeenCalled();
  });

  it('includes the paid lease UUID when the user dismisses recovery', async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const server = {
      elicitInput: vi.fn().mockResolvedValue({ action: 'cancel' }),
      sendLoggingMessage,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const callbacks = makeDeployCallbacks({ server, extra: makeExtra() });
    const options: RecoveryOption[] = [
      {
        id: 'salvage_without_domain',
        label: 'Keep lease',
        description: 'Keep the paid lease without its custom domain.',
      },
    ];

    await expect(
      callbacks.onFailure!(
        {
          outcome: 'partially_succeeded',
          leaseUuid: 'lease-paid',
          reason: 'Domain attachment failed after lease creation.',
        },
        options,
      ),
    ).resolves.toEqual({ id: 'salvage_without_domain' });

    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({
          kind: 'recovery_dismissed',
          dismissed_action: 'cancel',
          applied_default: 'salvage_without_domain',
          lease_uuid: 'lease-paid',
        }),
      }),
    );
  });

  it('omits a lease UUID for non-partial recovery dismissals', async () => {
    // Defensive callback-boundary coverage: agent-core currently does not
    // offer recovery choices for this union arm, but direct callers can invoke
    // the public callback and the log must not fabricate an undefined UUID.
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const elicitInput = vi
      .fn()
      .mockRejectedValueOnce(new Error('recovery prompt rejected'))
      .mockResolvedValueOnce({ action: 'cancel' });
    const server = {
      elicitInput,
      sendLoggingMessage,
      getClientCapabilities: vi.fn().mockReturnValue({ elicitation: {} }),
    } as unknown as Server;
    const callbacks = makeDeployCallbacks({ server, extra: makeExtra() });
    const failure = {
      outcome: 'failed' as const,
      reason: 'Deployment failed before a lease was created.',
    };
    const options: RecoveryOption[] = [
      {
        id: 'salvage_without_domain',
        label: 'Keep lease',
        description: 'Keep the paid lease without its custom domain.',
      },
    ];

    await expect(callbacks.onFailure!(failure, options)).resolves.toEqual({
      id: 'salvage_without_domain',
    });
    await expect(callbacks.onFailure!(failure, options)).resolves.toEqual({
      id: 'salvage_without_domain',
    });

    expect(sendLoggingMessage).toHaveBeenCalledTimes(2);
    expect(
      sendLoggingMessage.mock.calls.map(
        ([params]) => params.data.dismissed_action,
      ),
    ).toEqual(['unknown', 'cancel']);
    for (const [params] of sendLoggingMessage.mock.calls) {
      expect(params.data).not.toHaveProperty('lease_uuid');
    }
  });
});
