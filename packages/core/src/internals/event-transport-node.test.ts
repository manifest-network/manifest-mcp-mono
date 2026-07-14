import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createNodeEventTransport } from './event-transport-node.js';

describe('createNodeEventTransport — runtime check', () => {
  it('throws a clear error on non-Node runtimes', () => {
    const original = process.versions;
    Object.defineProperty(process, 'versions', {
      value: {},
      configurable: true,
    });
    try {
      expect(() => createNodeEventTransport()).toThrow(/Node\.js runtime/);
    } finally {
      Object.defineProperty(process, 'versions', {
        value: original,
        configurable: true,
      });
    }
  });

  it('returns a transport with an open() method', () => {
    const t = createNodeEventTransport();
    expect(typeof t.open).toBe('function');
  });
});

describe('createNodeEventTransport — SSRF guard', () => {
  it('guarded (default): refuses a loopback host, emitting an SSRF error AND a synthetic close', async () => {
    const t = createNodeEventTransport();
    const sock = t.open('ws://127.0.0.1:9/does-not-matter');
    // Register BOTH listeners synchronously — the transport fires error then close back-to-back in its
    // async catch, so a late onClose registration would miss the (already-emitted) synthetic close.
    const errP = new Promise<Error>((resolve) => sock.onError(resolve));
    const closeP = new Promise<number>((resolve) =>
      sock.onClose((c) => resolve(c)),
    );
    const err = await errP;
    expect(err.message).toMatch(/SSRF blocked/);
    expect(err.message).toMatch(/loopback/);
    // A synthetic close (1006) must follow so a consumer waiting on onClose can fall back (not hang).
    expect(await closeP).toBe(1006);
    sock.close();
  });
});

describe('createNodeEventTransport — adapter over a real ws server (guard off)', () => {
  let server: WebSocketServer | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function startServer(
    onConn: (ws: import('ws').WebSocket) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        const addr = wss.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
      wss.on('connection', onConn);
      server = wss;
    });
  }

  it('opens, receives text frames, and closes (onOpen/onMessage/onClose)', async () => {
    const port = await startServer((ws) => {
      ws.send(JSON.stringify({ hello: 'world' }));
    });

    // guarded:false so the loopback test server is reachable.
    const t = createNodeEventTransport({ guarded: false });
    const sock = t.open(`ws://127.0.0.1:${port}/v1/leases/abc/events?token=t`);

    const opened = new Promise<void>((r) => sock.onOpen(r));
    const message = new Promise<string>((r) => sock.onMessage(r));
    const closed = new Promise<number>((r) => sock.onClose((code) => r(code)));

    await opened;
    expect(JSON.parse(await message)).toEqual({ hello: 'world' });

    sock.close(1000);
    await closed;
  });
});
