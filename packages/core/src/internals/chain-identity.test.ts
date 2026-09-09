import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPErrorCode } from '../types.js';
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
    });
    controller.abort(reason);
    await rejected;
  });

  it('releases the reader when the deadline interrupts response streaming', async () => {
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
              () => stream.error(init.signal?.reason),
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
    });
    await streaming;
    controller.abort(reason);
    await rejected;
    expect(response?.body?.locked).toBe(false);
  });
});
