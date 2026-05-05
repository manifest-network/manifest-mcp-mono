import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// Mock modules before imports
vi.mock('./modules.js', () => ({
  getQueryHandler: vi.fn(),
  getTxHandler: vi.fn(),
  getTxMsgBuilder: vi.fn(),
  getTxContextLoader: vi.fn(),
}));

vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  return {
    ...actual,
    // Execute immediately without actual retry/backoff for fast tests
    withRetry: vi
      .fn()
      .mockImplementation(async (operation: () => Promise<unknown>) => {
        return operation();
      }),
  };
});

import { cosmosEstimateFee, cosmosQuery, cosmosTx } from './cosmos.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';

const mockGetQueryHandler = vi.mocked(getQueryHandler);
const mockGetTxHandler = vi.mocked(getTxHandler);
const mockGetTxMsgBuilder = vi.mocked(getTxMsgBuilder);
const mockGetTxContextLoader = vi.mocked(getTxContextLoader);

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

    const result = await cosmosQuery(clientManager, 'bank', 'balances', [
      'manifest1abc',
    ]);

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

    await expect(
      cosmosQuery(clientManager, 'bank', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('network fail'),
    });
  });

  it('re-throws ManifestMCPError as-is when details.module is already set', async () => {
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      'nope',
      { module: 'preset', subcommand: 'preset-sub' },
    );
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await expect(cosmosQuery(clientManager, 'bank', 'balances')).rejects.toBe(
      original,
    );
  });

  it('augments ManifestMCPError without details.module with {module, subcommand}', async () => {
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      'nope',
    );
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await expect(
      cosmosQuery(clientManager, 'bank', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      message: 'nope',
      details: { module: 'bank', subcommand: 'balances' },
    });
  });

  it('validates module name (rejects invalid chars) with UNSUPPORTED_QUERY', async () => {
    await expect(
      cosmosQuery(clientManager, 'bank;drop', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      message: expect.stringContaining('Invalid module'),
    });
  });

  it('validates subcommand name (rejects invalid chars) with UNSUPPORTED_QUERY', async () => {
    mockGetQueryHandler.mockReturnValue(vi.fn());
    await expect(
      cosmosQuery(clientManager, 'bank', 'bal ances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      message: expect.stringContaining('Invalid subcommand'),
    });
  });

  it('rejects empty module name', async () => {
    await expect(
      cosmosQuery(clientManager, '', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
    });
  });

  it('rejects module name starting with hyphen', async () => {
    await expect(
      cosmosQuery(clientManager, '-bank', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_QUERY,
    });
  });

  it('allows underscores and hyphens in names', async () => {
    const mockHandler = vi.fn().mockResolvedValue({});
    mockGetQueryHandler.mockReturnValue(mockHandler);

    await cosmosQuery(clientManager, 'my_module', 'sub-command');

    expect(mockGetQueryHandler).toHaveBeenCalledWith('my_module');
  });

  it('augments getQueryClient errors with {module, subcommand}', async () => {
    mockGetQueryHandler.mockReturnValue(vi.fn());
    clientManager.getQueryClient.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Cannot create query client: neither restUrl nor rpcUrl is configured.',
      ),
    );

    await expect(
      cosmosQuery(clientManager, 'bank', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { module: 'bank', subcommand: 'balances' },
    });
  });

  it('augments acquireRateLimit errors with {module, subcommand}', async () => {
    mockGetQueryHandler.mockReturnValue(vi.fn());
    clientManager.acquireRateLimit.mockRejectedValue(
      new Error('rate-limit acquire failed'),
    );

    await expect(
      cosmosQuery(clientManager, 'bank', 'balances'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: { module: 'bank', subcommand: 'balances' },
    });
  });
});

describe('cosmosTx', () => {
  let clientManager: ReturnType<typeof makeMockClientManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default to "no loader registered" — vi.clearAllMocks resets call
    // history but not implementations, so a previous test's
    // .mockReturnValue or .mockImplementation would otherwise leak.
    mockGetTxContextLoader.mockReturnValue(undefined);
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

    const result = await cosmosTx(clientManager, 'bank', 'send', [
      'addr',
      '100umfx',
    ]);

    expect(mockGetTxHandler).toHaveBeenCalledWith('bank');
    expect(mockHandler).toHaveBeenCalledWith(
      { mock: 'signingClient' },
      'manifest1sender',
      'send',
      ['addr', '100umfx'],
      false,
      undefined,
      undefined,
    );
    expect(result).toEqual(txResult);
  });

  it('passes waitForConfirmation to handler', async () => {
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'bank', 'send', [], true);

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      [],
      true,
      undefined,
      undefined,
    );
  });

  it('enriches ManifestMCPError with module/subcommand/args context', async () => {
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'insufficient gas',
    );
    const mockHandler = vi.fn().mockRejectedValue(original);
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(
      cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toSatisfy(
      (err: ManifestMCPError) =>
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.TX_FAILED &&
        err.details?.module === 'bank' &&
        err.details?.subcommand === 'send' &&
        JSON.stringify(err.details?.args) ===
          JSON.stringify(['addr', '100umfx']),
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

    await expect(cosmosTx(clientManager, 'bank', 'send', [])).rejects.toBe(
      original,
    );
  });

  it('wraps unknown errors into TX_FAILED', async () => {
    const mockHandler = vi.fn().mockRejectedValue(new Error('random error'));
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(
      cosmosTx(clientManager, 'bank', 'send', ['addr']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('random error'),
      details: expect.objectContaining({ module: 'bank', subcommand: 'send' }),
    });
  });

  it('validates module name with UNSUPPORTED_TX', async () => {
    await expect(
      cosmosTx(clientManager, 'bad module', 'send', []),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_TX,
      message: expect.stringContaining('Invalid module'),
    });
  });

  it('validates subcommand name with UNSUPPORTED_TX', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());
    await expect(
      cosmosTx(clientManager, 'bank', 'bad;cmd', []),
    ).rejects.toMatchObject({
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
      return {
        module: 'bank',
        subcommand: 'send',
        transactionHash: 'X',
        code: 0,
        height: '1',
      };
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'bank', 'send', []);

    expect(callOrder).toEqual([
      'rateLimit',
      'getClient',
      'getAddress',
      'handler',
    ]);
  });

  it('rejects gasMultiplier < 1', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());

    await expect(
      cosmosTx(clientManager, 'bank', 'send', [], false, {
        gasMultiplier: 0.5,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasMultiplier'),
    });
  });

  it('rejects gasMultiplier of NaN', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());

    await expect(
      cosmosTx(clientManager, 'bank', 'send', [], false, {
        gasMultiplier: NaN,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasMultiplier'),
    });
  });

  it('rejects gasMultiplier of Infinity', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());

    await expect(
      cosmosTx(clientManager, 'bank', 'send', [], false, {
        gasMultiplier: Infinity,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasMultiplier'),
    });
  });

  it('rejects gasMultiplier when gasPrice is not configured', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());
    // Default mock has no gasPrice in config

    await expect(
      cosmosTx(clientManager, 'bank', 'send', [], false, {
        gasMultiplier: 2.0,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasPrice'),
    });
  });

  it('passes resolved TxOptions to handler when gasMultiplier override provided', async () => {
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    // Override config to include gasPrice
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });

    await cosmosTx(clientManager, 'bank', 'send', [], false, {
      gasMultiplier: 2.5,
    });

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      [],
      false,
      { gasMultiplier: 2.5, gasPrice: '1.0umfx' },
      undefined,
    );
  });

  it('threads the registered TxBuildContextLoader result into the handler', async () => {
    const onChainParams = {
      maxLeasesPerTenant: 9n,
      maxItemsPerLease: 9n,
      minLeaseDuration: 9n,
      maxPendingLeasesPerTenant: 9n,
      pendingTimeout: 9n,
      allowedList: ['manifest1existing'],
      reservedDomainSuffixes: ['.preserved.test'],
    };
    const loader = vi
      .fn()
      .mockResolvedValue({ currentBillingParams: onChainParams });
    mockGetTxContextLoader.mockImplementation((module, subcommand) =>
      module === 'billing' && subcommand === 'update-params'
        ? loader
        : undefined,
    );
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'billing',
      subcommand: 'update-params',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'billing', 'update-params', [
      '10',
      '5',
      '3600',
      '2',
      '300',
    ]);

    expect(loader).toHaveBeenCalledOnce();
    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'update-params',
      ['10', '5', '3600', '2', '300'],
      false,
      undefined,
      { currentBillingParams: onChainParams },
    );
  });

  it('skips the loader and passes undefined context for subcommands without a registered loader', async () => {
    mockGetTxContextLoader.mockReturnValue(undefined);
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);

    await cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx']);

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      ['addr', '100umfx'],
      false,
      undefined,
      undefined,
    );
  });

  it('acquires a rate-limit token before invoking a context loader', async () => {
    const callOrder: string[] = [];
    clientManager.acquireRateLimit.mockImplementation(async () => {
      callOrder.push('acquireRateLimit');
    });
    const loader = vi.fn().mockImplementation(async () => {
      callOrder.push('loader');
      return { currentBillingParams: { allowedList: [] } as never };
    });
    mockGetTxContextLoader.mockReturnValue(loader);
    mockGetTxHandler.mockReturnValue(vi.fn().mockResolvedValue({}));

    await cosmosTx(clientManager, 'billing', 'update-params', []);

    // Two acquires: one for the loader's RPC, one for signAndBroadcast.
    expect(
      callOrder.filter((step) => step === 'acquireRateLimit'),
    ).toHaveLength(2);
    expect(callOrder.indexOf('acquireRateLimit')).toBeLessThan(
      callOrder.indexOf('loader'),
    );
  });

  it('wraps non-ManifestMCPError loader failures as QUERY_FAILED with module/subcommand context', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('rpc unreachable'));
    mockGetTxContextLoader.mockReturnValue(loader);
    const mockHandler = vi.fn();
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(
      cosmosTx(clientManager, 'billing', 'update-params', []),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ManifestMCPError)) return false;
      return (
        error.code === ManifestMCPErrorCode.QUERY_FAILED &&
        error.details?.module === 'billing' &&
        error.details?.subcommand === 'update-params' &&
        /rpc unreachable/.test(error.message)
      );
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('preserves a structured ManifestMCPError thrown by the loader', async () => {
    const loader = vi
      .fn()
      .mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'response.params was empty',
        ),
      );
    mockGetTxContextLoader.mockReturnValue(loader);
    const mockHandler = vi.fn();
    mockGetTxHandler.mockReturnValue(mockHandler);

    await expect(
      cosmosTx(clientManager, 'billing', 'update-params', []),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ManifestMCPError)) return false;
      return (
        error.code === ManifestMCPErrorCode.QUERY_FAILED &&
        error.message === 'response.params was empty' &&
        error.details?.module === 'billing' &&
        error.details?.subcommand === 'update-params'
      );
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('augments getSigningClient errors with {module, subcommand, args}', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());
    clientManager.getSigningClient.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet is not connected',
      ),
    );

    await expect(
      cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      details: {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      },
    });
  });

  it('augments acquireRateLimit errors with {module, subcommand, args}', async () => {
    mockGetTxHandler.mockReturnValue(vi.fn());
    clientManager.acquireRateLimit.mockRejectedValue(
      new Error('rate-limit acquire failed'),
    );

    await expect(
      cosmosTx(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      details: {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      },
    });
  });
});

describe('cosmosEstimateFee', () => {
  let clientManager: ReturnType<typeof makeMockClientManager>;
  let mockSimulate: ReturnType<typeof vi.fn>;

  function setupHappyPath(opts?: {
    gasEstimate?: number;
    canonicalSubcommand?: string;
    memo?: string;
    config?: Record<string, unknown>;
  }) {
    mockSimulate = vi.fn().mockResolvedValue(opts?.gasEstimate ?? 100000);
    clientManager.getSigningClient.mockResolvedValue({
      simulate: mockSimulate,
    });
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
      ...opts?.config,
    });
    const mockBuilder = vi.fn().mockReturnValue({
      messages: [
        { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: { fake: true } },
      ],
      memo: opts?.memo ?? '',
      ...(opts?.canonicalSubcommand !== undefined && {
        canonicalSubcommand: opts.canonicalSubcommand,
      }),
    });
    mockGetTxMsgBuilder.mockReturnValue(mockBuilder);
    return mockBuilder;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTxContextLoader.mockReturnValue(undefined);
    clientManager = makeMockClientManager();
  });

  it('happy path: dispatches to builder, simulates, returns fee estimate shape', async () => {
    setupHappyPath({ gasEstimate: 100000 });

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', [
      'addr',
      '100umfx',
    ]);

    expect(mockGetTxMsgBuilder).toHaveBeenCalledWith('bank');
    expect(result).toEqual({
      module: 'bank',
      subcommand: 'send',
      gasEstimate: '100000',
      fee: {
        amount: [{ denom: 'umfx', amount: '150000' }],
        gas: '150000',
      },
    });
  });

  it('builder is called with (senderAddress, subcommand, args, context)', async () => {
    const mockBuilder = setupHappyPath();

    await cosmosEstimateFee(clientManager, 'bank', 'send', ['addr', '100umfx']);

    expect(mockBuilder).toHaveBeenCalledWith(
      'manifest1sender',
      'send',
      ['addr', '100umfx'],
      undefined,
    );
  });

  it('memo from builder is forwarded to simulate', async () => {
    setupHappyPath({ memo: 'hello' });

    await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    expect(mockSimulate).toHaveBeenCalledWith(
      'manifest1sender',
      expect.any(Array),
      'hello',
    );
  });

  it('threads the registered TxBuildContextLoader result into the builder', async () => {
    const onChainParams = {
      maxLeasesPerTenant: 9n,
      maxItemsPerLease: 9n,
      minLeaseDuration: 9n,
      maxPendingLeasesPerTenant: 9n,
      pendingTimeout: 9n,
      allowedList: ['manifest1existing'],
      reservedDomainSuffixes: ['.preserved.test'],
    };
    const loader = vi
      .fn()
      .mockResolvedValue({ currentBillingParams: onChainParams });
    mockGetTxContextLoader.mockImplementation((module, subcommand) =>
      module === 'billing' && subcommand === 'update-params'
        ? loader
        : undefined,
    );
    const mockBuilder = setupHappyPath();

    await cosmosEstimateFee(clientManager, 'billing', 'update-params', [
      '10',
      '5',
      '3600',
      '2',
      '300',
    ]);

    expect(loader).toHaveBeenCalledOnce();
    expect(mockBuilder).toHaveBeenCalledWith(
      'manifest1sender',
      'update-params',
      ['10', '5', '3600', '2', '300'],
      { currentBillingParams: onChainParams },
    );
  });

  it('empty memo from builder is forwarded to simulate', async () => {
    setupHappyPath({ memo: '' });

    await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    expect(mockSimulate).toHaveBeenCalledWith(
      'manifest1sender',
      expect.any(Array),
      '',
    );
  });

  it('fee.gas equals Math.ceil(gasEstimate * gasMultiplier)', async () => {
    setupHappyPath({ gasEstimate: 100001 });

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', [], {
      gasMultiplier: 1.5,
    });

    // 100001 * 1.5 = 150001.5 -> ceil = 150002
    expect(result.fee.gas).toBe('150002');
  });

  it('gasEstimate is the raw simulation value as a string', async () => {
    setupHappyPath({ gasEstimate: 100000 });

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    expect(result.gasEstimate).toBe('100000');
    expect(typeof result.gasEstimate).toBe('string');
  });

  it('subcommand normalization via canonicalSubcommand', async () => {
    setupHappyPath({ canonicalSubcommand: 'unbond' });

    const result = await cosmosEstimateFee(
      clientManager,
      'staking',
      'undelegate',
      [],
    );

    expect(result.subcommand).toBe('unbond');
  });

  it('subcommand passthrough when builder does not normalize', async () => {
    setupHappyPath();

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    expect(result.subcommand).toBe('send');
  });

  it('validates module name with UNSUPPORTED_TX', async () => {
    await expect(
      cosmosEstimateFee(clientManager, 'bad module', 'send', []),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_TX,
      message: expect.stringContaining('Invalid module'),
    });
  });

  it('validates subcommand name with UNSUPPORTED_TX', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'bad;cmd', []),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNSUPPORTED_TX,
      message: expect.stringContaining('Invalid subcommand'),
    });
  });

  it('rejects gasMultiplier < 1', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', [], {
        gasMultiplier: 0.5,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasMultiplier'),
    });
  });

  it('rejects gasMultiplier of NaN', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', [], {
        gasMultiplier: NaN,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });

  it('rejects gasMultiplier of Infinity', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', [], {
        gasMultiplier: Infinity,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });

  it('requires gasPrice in config', async () => {
    // Default mock has no gasPrice
    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', []),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('gasPrice'),
    });
  });

  it('reads gasMultiplier from signing client when no override (parity with cosmosTx)', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    // Signing client carries the patched defaultGasMultiplier from client.ts.
    // cosmosEstimateFee should read from here, not from config, so that both
    // tools agree even if the patch fell back to CosmJS's built-in default.
    clientManager.getSigningClient.mockResolvedValue({
      simulate: vi.fn().mockResolvedValue(100000),
      defaultGasMultiplier: 2.0,
    });
    mockGetTxMsgBuilder.mockReturnValue(
      vi
        .fn()
        .mockReturnValue({ messages: [{ typeUrl: 'x', value: {} }], memo: '' }),
    );

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    // 100000 * 2.0 = 200000 (uses signing client's multiplier, not DEFAULT 1.5)
    expect(result.fee.gas).toBe('200000');
  });

  it('falls back to DEFAULT_GAS_MULTIPLIER when signing client has no defaultGasMultiplier', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    // Signing client without defaultGasMultiplier (e.g., patch failed)
    clientManager.getSigningClient.mockResolvedValue({
      simulate: vi.fn().mockResolvedValue(100000),
    });
    mockGetTxMsgBuilder.mockReturnValue(
      vi
        .fn()
        .mockReturnValue({ messages: [{ typeUrl: 'x', value: {} }], memo: '' }),
    );

    const result = await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    // 100000 * 1.5 (DEFAULT_GAS_MULTIPLIER) = 150000
    expect(result.fee.gas).toBe('150000');
  });

  it('propagates UNKNOWN_MODULE from getTxMsgBuilder without retry', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    mockGetTxMsgBuilder.mockImplementation(() => {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.UNKNOWN_MODULE,
        'Unknown tx module: nonexistent',
        { availableModules: ['bank', 'staking'] },
      );
    });

    await expect(
      cosmosEstimateFee(clientManager, 'nonexistent', 'send', []),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.UNKNOWN_MODULE,
      message: expect.stringContaining('Unknown tx module'),
    });
    // Should be called exactly once (before retry loop, no retry)
    expect(mockGetTxMsgBuilder).toHaveBeenCalledTimes(1);
    // Should NOT have entered the retry loop
    expect(clientManager.acquireRateLimit).not.toHaveBeenCalled();
    expect(clientManager.getSigningClient).not.toHaveBeenCalled();
  });

  it('acquires rate limit before RPC call', async () => {
    const callOrder: string[] = [];
    clientManager.acquireRateLimit.mockImplementation(async () => {
      callOrder.push('rateLimit');
    });
    const simulate = vi.fn().mockImplementation(async () => {
      callOrder.push('simulate');
      return 100000;
    });
    clientManager.getSigningClient.mockImplementation(async () => {
      callOrder.push('getClient');
      return { simulate };
    });
    clientManager.getAddress.mockImplementation(async () => {
      callOrder.push('getAddress');
      return 'manifest1sender';
    });
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    mockGetTxMsgBuilder.mockReturnValue(
      vi
        .fn()
        .mockReturnValue({ messages: [{ typeUrl: 'x', value: {} }], memo: '' }),
    );

    await cosmosEstimateFee(clientManager, 'bank', 'send', []);

    expect(callOrder).toEqual([
      'rateLimit',
      'getClient',
      'getAddress',
      'simulate',
    ]);
  });

  it('enriches ManifestMCPError without module details', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      'bad address',
    );
    mockGetTxMsgBuilder.mockReturnValue(
      vi.fn().mockImplementation(() => {
        throw original;
      }),
    );
    clientManager.getSigningClient.mockResolvedValue({
      simulate: vi.fn(),
    });

    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toSatisfy(
      (err: ManifestMCPError) =>
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.INVALID_ADDRESS &&
        err.details?.module === 'bank' &&
        err.details?.subcommand === 'send' &&
        JSON.stringify(err.details?.args) ===
          JSON.stringify(['addr', '100umfx']),
    );
  });

  it('does not double-enrich ManifestMCPError that already has module', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      'bad address',
      { module: 'other', subcommand: 'other' },
    );
    mockGetTxMsgBuilder.mockReturnValue(
      vi.fn().mockImplementation(() => {
        throw original;
      }),
    );
    clientManager.getSigningClient.mockResolvedValue({
      simulate: vi.fn(),
    });

    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', []),
    ).rejects.toBe(original);
  });

  it('wraps unknown errors as SIMULATION_FAILED with context', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    mockGetTxMsgBuilder.mockReturnValue(
      vi
        .fn()
        .mockReturnValue({ messages: [{ typeUrl: 'x', value: {} }], memo: '' }),
    );
    clientManager.getSigningClient.mockResolvedValue({
      simulate: vi.fn().mockRejectedValue(new Error('insufficient funds')),
    });

    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', ['addr']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.SIMULATION_FAILED,
      message: expect.stringContaining('insufficient funds'),
      details: expect.objectContaining({ module: 'bank', subcommand: 'send' }),
    });
  });

  it('augments getSigningClient errors with {module, subcommand, args}', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    mockGetTxMsgBuilder.mockReturnValue(vi.fn());
    clientManager.getSigningClient.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet is not connected',
      ),
    );

    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      details: {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      },
    });
  });

  it('augments acquireRateLimit errors with {module, subcommand, args}', async () => {
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });
    mockGetTxMsgBuilder.mockReturnValue(vi.fn());
    clientManager.acquireRateLimit.mockRejectedValue(
      new Error('rate-limit acquire failed'),
    );

    await expect(
      cosmosEstimateFee(clientManager, 'bank', 'send', ['addr', '100umfx']),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.SIMULATION_FAILED,
      details: {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      },
    });
  });
});
