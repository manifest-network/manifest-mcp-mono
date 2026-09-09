import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { errorChain } from './error-chain.js';

describe('error cause traversal', () => {
  it('retains exact error identities and outer-to-inner order for retry ownership', () => {
    const timeout = new DOMException('Attempt elapsed', 'TimeoutError');
    const owner = Object.assign(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Read failed', {
        transportCode: 'ETIMEDOUT',
      }),
      { cause: timeout },
    );
    const outer = Object.assign(new Error('Application wrapper'), {
      cause: owner,
    });
    const chain = errorChain(outer);

    expect(chain).toHaveLength(3);
    expect(chain[0]).toBe(outer);
    expect(chain[1]).toBe(owner);
    expect(chain[2]).toBe(timeout);
    expect(outer.cause).toBe(owner);
    expect(owner.cause).toBe(timeout);
  });

  it('visits a cyclic permanent verdict once without dropping the verdict', () => {
    const outer: Error & { cause?: unknown } = new Error('fetch failed');
    const verdict = Object.assign(
      new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'Wrong chain'),
      { cause: outer },
    );
    outer.cause = verdict;
    const chain = errorChain(outer);

    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(outer);
    expect(chain[1]).toBe(verdict);
  });

  it('terminates an error that cites itself as its cause', () => {
    const error: Error & { cause?: unknown } = new Error('Self-cause');
    error.cause = error;

    expect(errorChain(error)).toEqual([error]);
  });

  it('stops at a non-Error cause rather than attributing a nested record to the failure', () => {
    const unrelated = new DOMException('Independent timeout', 'TimeoutError');
    const error = Object.assign(new Error('Opaque failure'), {
      cause: { cause: unrelated },
    });

    expect(errorChain(error)).toEqual([error]);
  });
});
