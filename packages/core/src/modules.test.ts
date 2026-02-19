import { describe, it, expect } from 'vitest';
import {
  getAvailableModules,
  getModuleSubcommands,
  isSubcommandSupported,
  getSupportedModules,
  throwUnsupportedSubcommand,
} from './modules.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('getAvailableModules', () => {
  it('should return query and tx modules', () => {
    const modules = getAvailableModules();

    expect(modules.queryModules).toBeDefined();
    expect(modules.txModules).toBeDefined();
    expect(modules.queryModules.length).toBeGreaterThan(0);
    expect(modules.txModules.length).toBeGreaterThan(0);
  });

  it('should include expected query modules', () => {
    const modules = getAvailableModules();
    const queryNames = modules.queryModules.map(m => m.name);

    expect(queryNames).toContain('bank');
    expect(queryNames).toContain('staking');
    expect(queryNames).toContain('distribution');
    expect(queryNames).toContain('gov');
    expect(queryNames).toContain('auth');
    expect(queryNames).toContain('billing');
    expect(queryNames).toContain('sku');
    expect(queryNames).toContain('group');
  });

  it('should include expected tx modules', () => {
    const modules = getAvailableModules();
    const txNames = modules.txModules.map(m => m.name);

    expect(txNames).toContain('bank');
    expect(txNames).toContain('staking');
    expect(txNames).toContain('distribution');
    expect(txNames).toContain('gov');
    expect(txNames).toContain('billing');
    expect(txNames).toContain('manifest');
    expect(txNames).toContain('sku');
    expect(txNames).toContain('group');
  });
});

describe('getModuleSubcommands', () => {
  it('should return subcommands for valid query module', () => {
    const subcommands = getModuleSubcommands('query', 'bank');

    expect(subcommands.length).toBeGreaterThan(0);
    expect(subcommands.some(s => s.name === 'balance')).toBe(true);
    expect(subcommands.some(s => s.name === 'balances')).toBe(true);
  });

  it('should return subcommands for valid tx module', () => {
    const subcommands = getModuleSubcommands('tx', 'bank');

    expect(subcommands.length).toBeGreaterThan(0);
    expect(subcommands.some(s => s.name === 'send')).toBe(true);
  });

  it('should throw ManifestMCPError for unknown module', () => {
    expect(() => getModuleSubcommands('query', 'unknown')).toThrow(ManifestMCPError);
  });

  it('should have UNKNOWN_MODULE error code', () => {
    try {
      getModuleSubcommands('query', 'unknown');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.UNKNOWN_MODULE);
    }
  });

  it('should include aliases in subcommands', () => {
    const bankSubcommands = getModuleSubcommands('query', 'bank');
    expect(bankSubcommands.some(s => s.name === 'total')).toBe(true);

    const stakingSubcommands = getModuleSubcommands('tx', 'staking');
    expect(stakingSubcommands.some(s => s.name === 'undelegate')).toBe(true);
  });
});

describe('isSubcommandSupported', () => {
  it('should return true for supported query subcommands', () => {
    expect(isSubcommandSupported('query', 'bank', 'balance')).toBe(true);
    expect(isSubcommandSupported('query', 'staking', 'delegation')).toBe(true);
  });

  it('should return true for supported tx subcommands', () => {
    expect(isSubcommandSupported('tx', 'bank', 'send')).toBe(true);
    expect(isSubcommandSupported('tx', 'staking', 'delegate')).toBe(true);
  });

  it('should return false for unsupported subcommands', () => {
    expect(isSubcommandSupported('query', 'bank', 'unknown')).toBe(false);
    expect(isSubcommandSupported('tx', 'bank', 'unknown')).toBe(false);
  });

  it('should return false for unknown modules', () => {
    expect(isSubcommandSupported('query', 'unknown', 'balance')).toBe(false);
    expect(isSubcommandSupported('tx', 'unknown', 'send')).toBe(false);
  });

  it('should support aliases', () => {
    expect(isSubcommandSupported('query', 'bank', 'total')).toBe(true);
    expect(isSubcommandSupported('tx', 'staking', 'undelegate')).toBe(true);
  });
});

describe('getSupportedModules', () => {
  it('should return query and tx module maps', () => {
    const modules = getSupportedModules();

    expect(modules.query).toBeDefined();
    expect(modules.tx).toBeDefined();
  });

  it('should include subcommand arrays for each module', () => {
    const modules = getSupportedModules();

    expect(Array.isArray(modules.query.bank)).toBe(true);
    expect(modules.query.bank).toContain('balance');
    expect(modules.query.bank).toContain('balances');

    expect(Array.isArray(modules.tx.bank)).toBe(true);
    expect(modules.tx.bank).toContain('send');
  });
});

describe('throwUnsupportedSubcommand', () => {
  it('should throw ManifestMCPError for unsupported query subcommand', () => {
    expect(() => throwUnsupportedSubcommand('query', 'bank', 'unknown')).toThrow(ManifestMCPError);
  });

  it('should throw ManifestMCPError for unsupported tx subcommand', () => {
    expect(() => throwUnsupportedSubcommand('tx', 'bank', 'unknown')).toThrow(ManifestMCPError);
  });

  it('should use UNSUPPORTED_QUERY error code for queries', () => {
    try {
      throwUnsupportedSubcommand('query', 'bank', 'unknown');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.UNSUPPORTED_QUERY);
    }
  });

  it('should use UNSUPPORTED_TX error code for transactions', () => {
    try {
      throwUnsupportedSubcommand('tx', 'bank', 'unknown');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.UNSUPPORTED_TX);
    }
  });

  it('should include module and subcommand in error message', () => {
    try {
      throwUnsupportedSubcommand('query', 'staking', 'badcmd');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('staking');
      expect(message).toContain('badcmd');
      expect(message).toContain('query');
    }
  });

  it('should include availableSubcommands in error details', () => {
    try {
      throwUnsupportedSubcommand('tx', 'bank', 'unknown');
    } catch (error) {
      const details = (error as ManifestMCPError).details;
      expect(details?.availableSubcommands).toBeDefined();
      expect(details?.availableSubcommands).toContain('send');
      expect(details?.availableSubcommands).toContain('multi-send');
    }
  });

  it('should include correct subcommands for each module', () => {
    try {
      throwUnsupportedSubcommand('query', 'gov', 'unknown');
    } catch (error) {
      const details = (error as ManifestMCPError).details;
      expect(details?.availableSubcommands).toContain('proposal');
      expect(details?.availableSubcommands).toContain('proposals');
      expect(details?.availableSubcommands).toContain('vote');
    }
  });
});
