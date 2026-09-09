import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableError, withRetry } from '../retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  verifyRestChainIdentity,
  verifyRpcChainIdentity,
} from './chain-identity.js';

const CHAIN_ID = 'identity-test';
const URL = 'https://chain.example.com/gateway';
const encoder = new TextEncoder();

afterEach(() => vi.restoreAllMocks());

describe.each([
  {
    protocol: 'RPC',
    verify: verifyRpcChainIdentity,
    document: {
      jsonrpc: '2.0',
      id: 'manifest-chain-identity',
      result: { node_info: { network: CHAIN_ID } },
    },
  },
  {
    protocol: 'REST',
    verify: verifyRestChainIdentity,
    document: { default_node_info: { network: CHAIN_ID } },
  },
])('$protocol identity response bounds', ({ verify, document }) => {
  it.each(['fetch', 'body'] as const)(
    'retries a nested owned deadline during %s using a fresh signal',
    async (phase) => {
      const first = new AbortController();
      const next = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(first.signal)
        .mockReturnValueOnce(next.signal);
      const reason = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      const failure = Object.assign(new TypeError('Custom transport wrapper'), {
        cause: Object.assign(new Error('Intermediate wrapper'), {
          cause:
            phase === 'fetch'
              ? reason
              : new DOMException('The operation was aborted', 'AbortError'),
        }),
      });
      let failedResponse: Response | undefined;
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => {
          first.abort(reason);
          if (phase === 'fetch') throw failure;
          failedResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.error(failure);
              },
            }),
          );
          return failedResponse;
        })
        .mockResolvedValueOnce(Response.json(document));
      const onRetry = vi.fn();

      await expect(
        withRetry(() => verify(URL, CHAIN_ID, fetch), {
          config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
          onRetry,
        }),
      ).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
      expect(timeout).toHaveBeenNthCalledWith(2, 10_000);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBe(first.signal);
      expect(fetch.mock.calls[1]?.[1]?.signal).toBe(next.signal);
      expect(next.signal.aborted).toBe(false);
      expect(onRetry).toHaveBeenCalledOnce();
      const error: unknown = onRetry.mock.calls[0]?.[0];
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { transportCode: 'ETIMEDOUT' },
      });
      expect(error).toHaveProperty('cause', failure);
      if (failedResponse) expect(failedResponse.body?.locked).toBe(false);
    },
  );

  it.each([false, true])(
    'preserves an established SDK verdict containing an abort (wrapped: %s)',
    async (wrapped) => {
      const deadline = new AbortController();
      const reason = new DOMException('Deadline elapsed', 'TimeoutError');
      deadline.abort(reason);
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const verdict = Object.assign(
        new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Established configuration verdict',
          { actualChainId: 'wrong-chain' },
        ),
        { cause: reason },
      );
      const failure = wrapped
        ? Object.assign(new TypeError('fetch failed'), { cause: verdict })
        : verdict;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw failure;
      });

      await expect(
        withRetry(() => verify(URL, CHAIN_ID, fetch), {
          config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        }),
      ).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledOnce();
      expect(verdict.details).toEqual({ actualChainId: 'wrong-chain' });
      expect(isRetryableError(failure)).toBe(false);
    },
  );

  it('preserves an unrelated cyclic cause chain after the deadline', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('Deadline elapsed', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const failure: Error & { cause?: unknown } = new Error(
      'Transport invariant',
    );
    const nested: Error & { cause?: unknown } = new Error('Nested invariant');
    failure.cause = nested;
    nested.cause = failure;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw failure;
    });

    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toBe(failure);
    expect(isRetryableError(failure)).toBe(false);
  });

  it('preserves a late chain mismatch after an injected transport ignores the deadline', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('Deadline elapsed', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(document).replace(CHAIN_ID, 'wrong-chain')),
    );
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { expectedChainId: CHAIN_ID, actualChainId: 'wrong-chain' },
    });
  });

  it('preserves a late size-limit verdict after an injected transport ignores the deadline', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('Deadline elapsed', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('x'.repeat(65_537)),
    );
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('64 KiB'),
    });
  });

  it('preserves HTTP 502 classification when response cancellation rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 502,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      message: expect.stringContaining('HTTP 502'),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves the size-limit verdict when reader cancellation rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(65_537));
        },
        cancel,
      }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('64 KiB'),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(['fetch', 'body'] as const)(
    'preserves an unrelated late TypeError during %s',
    async (phase) => {
      const deadline = new AbortController();
      deadline.abort(new DOMException('Deadline elapsed', 'TimeoutError'));
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const unrelated = new TypeError('Custom transport invariant failed');
      let response: Response | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (phase === 'fetch') throw unrelated;
        response = new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.error(unrelated);
            },
          }),
        );
        return response;
      });
      await expect(verify(URL, CHAIN_ID, fetch)).rejects.toBe(unrelated);
      if (response) expect(response.body?.locked).toBe(false);
    },
  );

  it('does not attribute an unrelated AbortError to a deadline that has not elapsed', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const unrelated = new DOMException(
      'Transport independently aborted',
      'AbortError',
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw unrelated;
    });
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toBe(unrelated);
  });

  it('normalizes the deadline reason even when its error name is not an abort name', async () => {
    const deadline = new AbortController();
    const reason = new Error('Custom deadline reason');
    deadline.abort(reason);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      throw init?.signal?.reason;
    });
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      message: expect.stringContaining('timed out'),
      details: { transportCode: 'ETIMEDOUT' },
      cause: reason,
    });
  });

  it('accepts a complete valid response exactly at the 64 KiB byte limit', async () => {
    const json = JSON.stringify(document);
    const body = json.padEnd(65_536, ' ');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body),
    );
    await expect(verify(URL, CHAIN_ID, fetch)).resolves.toBeUndefined();
  });

  it('counts streamed UTF-8 bytes and cancels an oversized response', async () => {
    // Character count fits under the cap, while encoded byte count does not.
    const body = JSON.stringify({ ...document, padding: 'é'.repeat(33_000) });
    expect(body.length).toBeLessThan(65_536);
    const bytes = encoder.encode(body);
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 32_768));
          controller.enqueue(bytes.slice(32_768));
        },
        cancel,
      }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('decodes a multibyte chain ID split across response chunks', async () => {
    const expectedChainId = 'test-é';
    const bytes = encoder.encode(
      JSON.stringify(document).replace(CHAIN_ID, expectedChainId),
    );
    const split = bytes.indexOf(0xc3) + 1;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              controller.close();
            },
          }),
        ),
    );
    await expect(verify(URL, expectedChainId, fetch)).resolves.toBeUndefined();
  });

  it('cancels an unsuccessful HTTP response without reading its body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 503,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    await expect(verify(URL, CHAIN_ID, fetch)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('passes a 10 second abort deadline through the identity transport', async () => {
    const controller = new AbortController();
    const deadline = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const verification = verify(URL, CHAIN_ID, fetch);
    expect(deadline).toHaveBeenCalledWith(10_000);
    const reason = new DOMException(
      'Identity deadline elapsed',
      'TimeoutError',
    );
    const rejected = expect(verification).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      message: expect.stringContaining('timed out'),
      details: { transportCode: 'ETIMEDOUT' },
      cause: reason,
    });
    controller.abort(reason);
    await rejected;
  });

  it('normalizes a body AbortError distinct from the deadline reason and releases the reader', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let response: Response | undefined;
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      response = new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode('{'));
            init?.signal?.addEventListener(
              'abort',
              () =>
                stream.error(
                  new DOMException('The operation was aborted', 'AbortError'),
                ),
              { once: true },
            );
          },
          pull() {
            started();
          },
        }),
      );
      return response;
    });
    const verification = verify(URL, CHAIN_ID, fetch);
    const reason = new DOMException(
      'Identity deadline elapsed',
      'TimeoutError',
    );
    const rejected = expect(verification).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      message: expect.stringContaining('timed out'),
      details: { transportCode: 'ETIMEDOUT' },
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
    await streaming;
    controller.abort(reason);
    await rejected;
    expect(response?.body?.locked).toBe(false);
  });
});
