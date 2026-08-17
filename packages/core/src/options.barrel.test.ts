import { describe, expect, it } from 'vitest';
import {
  abortableSleep,
  abortReason,
  noopLogger,
  resolveCallSignal,
} from './index.js';

describe('logger/options re-exported from the barrel', () => {
  it('exposes noopLogger + resolveCallSignal', () => {
    expect(typeof resolveCallSignal).toBe('function');
    expect(typeof noopLogger.debug).toBe('function');
  });

  // fred imports both of these from the barrel — core's `internals/*` is unreachable from
  // outside the package (the exports map has 9 explicit subpaths and no wildcard), so the
  // barrel is the only door and this assertion is what keeps it open (ENG-710).
  it('exposes the hoisted cancellation helpers abortReason + abortableSleep', () => {
    expect(typeof abortReason).toBe('function');
    expect(typeof abortableSleep).toBe('function');
  });
});
