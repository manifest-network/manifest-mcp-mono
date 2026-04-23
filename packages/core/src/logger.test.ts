import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, parseLogLevel } from './logger.js';

describe('logger', () => {
  afterEach(() => {
    logger.setLevel('warn');
    vi.restoreAllMocks();
  });

  it('defaults to warn level', () => {
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

describe('parseLogLevel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'debug',
    'info',
    'warn',
    'error',
    'silent',
  ] as const)('round-trips valid level %s', (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  it('returns warn for undefined', () => {
    expect(parseLogLevel(undefined)).toBe('warn');
  });

  it('returns warn for empty string', () => {
    expect(parseLogLevel('')).toBe('warn');
  });

  it('returns warn and warns on invalid input', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseLogLevel('spam')).toBe('warn');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain('Invalid LOG_LEVEL "spam"');
  });
});
