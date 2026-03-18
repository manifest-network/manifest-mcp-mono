import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';

describe('logger', () => {
  afterEach(() => {
    logger.setLevel('warn');
    vi.restoreAllMocks();
  });

  it('defaults to warn level', () => {
    expect(logger.getLevel()).toBe('warn');
  });

  it('logs warn and error at warn level', () => {
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
