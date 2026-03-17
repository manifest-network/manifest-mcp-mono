import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// Mock modules before imports
vi.mock('./modules.js', () => ({
  getQueryHandler: vi.fn(),
  getTxHandler: vi.fn(),
}));

vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  return {
    ...actual,
    // Execute immediately without actual retry/backoff for fast tests
    withRetry: vi.fn().mockImplementation(async (operation: () => Promise<unknown>) => {
      return operation();
    }),
  };
});

import { cosmosQuery, cosmosTx } from './cosmos.js';
import { getQueryHandler, getTxHandler } from './modules.js';

const mockGetQueryHandler = vi.mocked(getQueryHandler);
const mockGetTxHandler = vi.mocked(getTxHandler);

function makeMockClientManager() {
  return {
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    getQueryClient: vi.fn().mockResolvedValue({ mock: 'queryClient' }),
    getSigningClient: vi.fn().mockResolvedValue({ mock: 'signingClient' }),
    getAddress: vi.fn().mockResolvedValue('manifest1sender'),
    getConfig: vi.fn().mockReturnValue({ retry: { maxRetries: 3 } }),
    disconnect: vi.fn(),
  } as any;
}

describe('cosmosQuery', () => {
  let clientManager: ReturnType<typeof makeMockClientManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    clientManager = makeMockClientManager();
  });

  it('dispatches to the correct query handler and returns result shape', async () => {
    const mockHandler = vi.fn().mockResolvedValue({ balances: [] });
    mockGetQueryHandler.mockReturnValue(mockHandler);

    const result = await cosmosQuery(clientManager, 'bank', 'balances', ['manifest1abc']);

    expect(mockGetQueryHandler).toHaveBeenCalledWith('bank');
    expect(result).toEqual({
      module: 'bank',
      subcommand: 'balances',
      result: { balances: [] },
    });
  });

  it('acquires rate limit before RPC call', async () => {
    const callOrder: string[] = [];
    clientManager.acquireRateLimit.mockImplementation(async () => {
      callOrder.push('rateLimit');
    });
    clientManager.getQueryClient.mockImplementation(async () => {
      callOrder.push('getClient');
      return {};
    });
    const mockHandler = vi.fn().mockImplementation(async () => {
      callOrder.push('handler');
      return {};
    });
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await cosmosQuery(clientManager, 'bank', 'balances');

    expect(callOrder).toEqual(['rateLimit', 'getClient', 'handler']);
  });

  it('wraps non-ManifestMCPError into QUERY_FAILED', async () => {
    const mockHandler = vi.fn().mockRejectedValue(new Error('network fail'));
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await expect(cosmosQuery(clientManager, 'bank', 'balances')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('network fail'),
    });
  });

  it('re-throws ManifestMCPError as-is', async () => {
    const original = new ManifestMCPError(ManifestMCPErrorCode.UNSUPPORTED_QUERY, 'nope');
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await expect(cosmosQuery(clientManager, 'bank', 'balances')).rejects.toBe(original);
  });

  it('validates module name (rejects invalid chars) with UNSUPPORTED_QUERY', async () => {
    await expect(cosmosQuery(clientManager, 'bank;drop', 'balances')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      message: expect.stringContaining('Invalid module'),
    });
  });

  it('validates subcommand name (rejects invalid chars) with UNSUPPORTED_QUERY', async () => {
    mockGetQueryHandler.mockReturnValue(vi.fn());
    await expect(cosmosQuery(clientManager, 'bank', 'bal ances')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      message: expect.stringContaining('Invalid subcommand'),
    });
  });

  it('rejects empty module name', async () => {
    await expect(cosmosQuery(clientManager, '', 'balances')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
    });
  });

  it('rejects module name starting with hyphen', async () => {
    await expect(cosmosQuery(clientManager, '-bank', 'balances')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
    });
  });

  it('allows underscores and hyphens in names', async () => {
    const mockHandler = vi.fn().mockResolvedValue({});
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await cosmosQuery(clientManager, 'my_module', 'sub-command');

    expect(mockGetQueryHandler).toHaveBeenCalledWith('my_module');
  });
});

describe('cosmosTx', () => {
  let clientManager: ReturnType<typeof makeMockClientManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    clientManager = makeMockClientManager();
  });

  it('dispatches to the correct tx handler', async () => {
    const txResult = {
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'ABC123',
      code: 0,
      height: '100',
    };
    const mockHandler = vi.fn().mockResolvedValue(txResult);
    mockGetTxHandler.mockReturnValue(mockHandler);

    const result = await cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx']);

    expect(mockGetTxHandler).toHaveBeenCalledWith('bank');
    expect(mockHandler).toHaveBeenCalledWith(
      { mock: 'signingClient' },
      'manifest1sender',
      'send',
      ['addr', '100umfx'],
      false,
    );
    expect(result).toEqual(txResult);
  });

  it('passes waitForConfirmation to handler', async () => {
    const mockHandler = vi.fn().mockResolvedValue({ module: 'bank', subcommand: 'send', transactionHash: 'X', code: 0, height: '1' });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'bank', 'send', [], true);

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      [],
      true,
    );
  });

  it('enriches ManifestMCPError with module/subcommand/args context', async () => {
    const original = new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'insufficient gas');
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx'])).rejects.toSatisfy(
      (err: ManifestMCPError) =>
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.TX_FAILED &&
        err.details?.module === 'bank' &&
        err.details?.subcommand === 'send' &&
        JSON.stringify(err.details?.args) === JSON.stringify(['addr', '100umfx']),
    );
  });

  it('does not double-enrich ManifestMCPError that already has module', async () => {
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'already enriched',
      { module: 'staking', subcommand: 'delegate' },
    );
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(cosmosTx(clientManager, 'bank', 'send', [])).rejects.toBe(original);
  });

  it('wraps unknown errors into TX_FAILED', async () => {
    const mockHandler = vi.fn().mockRejectedValue(new Error('random error'));
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(cosmosTx(clientManager, 'bank', 'send', ['addr'])).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('random error'),
      details: expect.objectContaining({ module: 'bank', subcommand: 'send' }),
    });
  });

  it('validates module name with UNSUPPORTED_TX', async () => {
    await expect(cosmosTx(clientManager, 'bad module', 'send', [])).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_TX,
      message: expect.stringContaining('Invalid module'),
    });
  });

  it('validates subcommand name with UNSUPPORTED_TX', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());
    await expect(cosmosTx(clientManager, 'bank', 'bad;cmd', [])).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_TX,
      message: expect.stringContaining('Invalid subcommand'),
    });
  });

  it('acquires rate limit before RPC call', async () => {
    const callOrder: string[] = [];
    clientManager.acquireRateLimit.mockImplementation(async () => {
      callOrder.push('rateLimit');
    });
    clientManager.getSigningClient.mockImplementation(async () => {
      callOrder.push('getClient');
      return {};
    });
    clientManager.getAddress.mockImplementation(async () => {
      callOrder.push('getAddress');
      return 'manifest1sender';
    });
    const mockHandler = vi.fn().mockImplementation(async () => {
      callOrder.push('handler');
      return { module: 'bank', subcommand: 'send', transactionHash: 'X', code: 0, height: '1' };
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'bank', 'send', []);

    expect(callOrder).toEqual(['rateLimit', 'getClient', 'getAddress', 'handler']);
  });
});
