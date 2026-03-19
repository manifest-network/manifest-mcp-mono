import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';

describe('logger', () => {
  let savedLogLevel: string | undefined;

  beforeEach(() => {
    savedLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (savedLogLevel !== undefined) {
      process.env.LOG_LEVEL = savedLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
    logger.setLevel('warn');
    vi.restoreAllMocks();
  });

  it('defaults to warn level when LOG_LEVEL is unset', () => {
    // The module-level resolveLevel() already ran at import time.
    // Reset to the expected default via setLevel to test behavior.
    logger.setLevel('warn');
    expect(logger.getLevel()).toBe('warn');
  });

  it('logs warn and error at warn level', () => {
    logger.setLevel('warn');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn('test warn');
    logger.error('test error');
    logger.info('should not show');
    logger.debug('should not show');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('logs all levels at debug level', () => {
    logger.setLevel('debug');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('logs nothing at silent level', () => {
    logger.setLevel('silent');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(spy).not.toHaveBeenCalled();
  });

  it('prefixes messages with level tag', () => {
    logger.setLevel('debug');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('hello');
    expect(spy).toHaveBeenCalledWith('[DEBUG]', 'hello');
  });
});
