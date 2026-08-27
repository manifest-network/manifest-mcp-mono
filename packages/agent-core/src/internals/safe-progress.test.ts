import { logger } from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitProgress } from './safe-progress.js';

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
        { kind: 'polling_for_readiness' },
      ),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('polling_for_readiness'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('host progress sink failed'),
    );
  });

  it('is a no-op when no callback is registered', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() => emitProgress(undefined, { kind: 'success' })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
