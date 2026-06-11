import { describe, expect, it } from 'vitest';
import { noopLogger, resolveCallSignal } from './index.js';

describe('logger/options re-exported from the barrel', () => {
  it('exposes noopLogger + resolveCallSignal', () => {
    expect(typeof resolveCallSignal).toBe('function');
    expect(typeof noopLogger.debug).toBe('function');
  });
});
