import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

/** Fresh values: never resolve a revoked proxy through a promise or test matcher. */
export const unreadableErrors = [
  ...['code', 'message', 'details'].map((field) => ({
    name: `SDK ${field} getter`,
    create: () =>
      Object.defineProperty(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          {
            module: 'billing',
          },
        ),
        field,
        {
          get() {
            throw new Error(`Cannot read ${field}`);
          },
        },
      ),
  })),
  {
    name: 'SDK detail value getter',
    create: () =>
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'fetch failed', {
        get partial() {
          throw new Error('Cannot read partial');
        },
      }),
  },
  {
    name: 'revoked proxy',
    create: () => {
      const { proxy, revoke } = Proxy.revocable(new Error('fetch failed'), {});
      revoke();
      return proxy;
    },
  },
  {
    name: 'message getter throwing a revoked proxy',
    create: () => {
      const { proxy, revoke } = Proxy.revocable(new Error('secondary'), {});
      revoke();
      return Object.defineProperty(new Error('fetch failed'), 'message', {
        get() {
          throw proxy;
        },
      });
    },
  },
];
