/**
 * Unit tests for callback factories in `callbacks.ts`.
 *
 * Mock strategy: construct minimal `server` / `extra` stubs directly —
 * no MCP transport is needed for these unit tests. Only `server.elicitInput`
 * and `extra.sendNotification` are called by the factories.
 */

import type { SkuCandidate } from '@manifest-network/manifest-agent-core';
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
});
