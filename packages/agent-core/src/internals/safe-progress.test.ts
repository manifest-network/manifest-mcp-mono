import { logger } from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitCompletion,
  emitProgress,
  notifyFailure,
} from './safe-progress.js';

describe('emitProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains a throwing host callback and logs the event kind', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() =>
      emitProgress(
        () => {
          throw new Error('host progress sink failed');
        },
        {
          kind: 'polling_for_readiness',
          leaseUuid: '11111111-1111-4111-8111-111111111111',
          attempt: 1,
          elapsedMs: 10,
        },
      ),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('polling_for_readiness'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('host progress sink failed'),
    );
  });

  it('contains an async host rejection instead of creating an unhandled rejection', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    emitProgress(
      async () => {
        throw new Error('async progress sink failed');
      },
      { kind: 'user_confirmed' },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('async progress sink failed'),
    );
  });

  it('is a no-op when no callback is registered', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() =>
      emitProgress(undefined, { kind: 'user_confirmed' }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('retains the concrete ProgressEvent contract at compile time', () => {
    const typeContract = () => {
      // @ts-expect-error polling events require lease identity and timing data
      emitProgress(undefined, { kind: 'polling_for_readiness' });
      // @ts-expect-error unknown event kinds cannot be inferred into a generic
      emitProgress(undefined, { kind: 'success' });
    };
    expect(typeContract).toBeTypeOf('function');
  });
});

describe('observational lifecycle callbacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains synchronous and asynchronous onComplete failures', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() =>
      emitCompletion(() => {
        throw new Error('sync completion failed');
      }),
    ).not.toThrow();
    emitCompletion(async () => {
      throw new Error('async completion failed');
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sync completion failed'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('async completion failed'),
    );
  });

  it('contains a simple onFailure notification rejection', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      notifyFailure(
        async () => {
          throw new Error('failure observer failed');
        },
        { reason: 'the original operation failed' },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failure observer failed'),
    );
  });
});
