import { toUtf8 } from '@cosmjs/encoding';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSmartContractState = vi.fn();
const mockSignAndBroadcast = vi.fn();

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue({
        disconnect: vi.fn(),
        getQueryClient: vi.fn().mockResolvedValue({
          cosmwasm: {
            wasm: {
              v1: {
                smartContractState: (...args: unknown[]) =>
                  mockSmartContractState(...args),
              },
            },
          },
        }),
        getSigningClient: vi.fn().mockResolvedValue({
          signAndBroadcast: (...args: unknown[]) =>
            mockSignAndBroadcast(...args),
        }),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({}),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

import {
  callTool as callToolHelper,
  type ToolResult,
} from '@manifest-network/manifest-mcp-core/__test-utils__/callTool.js';
import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { CosmwasmMCPServer } from './index.js';

let activeTransports: InMemoryTransport[] = [];

function callTool(
  server: CosmwasmMCPServer,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<ToolResult> {
  return callToolHelper(
    server.getServer(),
    toolName,
    toolInput,
    activeTransports,
  );
}

function makeConverterConfig(overrides?: Record<string, unknown>) {
  return {
    poa_admin: 'manifest1admin',
    rate: '0.379',
    source_denom: 'umfx',
    target_denom: 'factory/manifest1admin/upwr',
    paused: false,
    ...overrides,
  };
}

function mockConfigResponse(config: Record<string, unknown> = {}) {
  mockSmartContractState.mockResolvedValue({
    data: toUtf8(JSON.stringify(makeConverterConfig(config))),
  });
}

function makeServer() {
  return new CosmwasmMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet(),
    converterAddress: 'manifest1converter',
  });
}

const TOOL_NAMES = ['get_mfx_to_pwr_rate', 'convert_mfx_to_pwr'];

beforeEach(() => {
  vi.clearAllMocks();
  activeTransports = [];
});

afterEach(async () => {
  for (const t of activeTransports) {
    await t.close();
  }
  activeTransports = [];
});

describe('CosmwasmMCPServer', () => {
  describe('listTools via protocol', () => {
    it('should advertise exactly 2 tools', async () => {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(2);
        expect(result.tools.map((t) => t.name).sort()).toEqual(
          [...TOOL_NAMES].sort(),
        );
      } finally {
        await client.close();
      }
    });
  });

  // The annotations + _meta.manifest matrix is the contract the
  // manifest-agent plugin relies on to derive its broadcast policy. Pin it
  // explicitly per tool: a change here is a downstream-visible change and
  // should require updating the plugin in lockstep.
  describe('tool annotations + _meta.manifest', () => {
    async function listTools() {
      const server = makeServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        return new Map(result.tools.map((t) => [t.name, t]));
      } finally {
        await client.close();
      }
    }

    it('every tool has annotations.title and _meta.manifest at the current version', async () => {
      // Safety net: when a new tool is registered, this test fails until the
      // contract metadata is added. Per-tool tests below pin the values.
      const tools = await listTools();
      expect(tools.size).toBeGreaterThan(0);
      for (const [name, tool] of tools) {
        expect(tool.annotations?.title, `${name} annotations.title`).toEqual(
          expect.any(String),
        );
        expect(tool._meta, `${name} _meta`).toMatchObject({
          manifest: {
            v: 1,
            broadcasts: expect.any(Boolean),
            estimable: expect.any(Boolean),
          },
        });
      }
    });

    it('get_mfx_to_pwr_rate is read-only', async () => {
      const tools = await listTools();
      const t = tools.get('get_mfx_to_pwr_rate');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: false,
        estimable: false,
      });
    });

    it('convert_mfx_to_pwr broadcasts a destructive, fund-spending tx', async () => {
      const tools = await listTools();
      const t = tools.get('convert_mfx_to_pwr');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });
  });

  describe('get_mfx_to_pwr_rate', () => {
    it('returns rate config without preview when no amount given', async () => {
      mockConfigResponse();
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate');
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.rate).toBe('0.379');
      expect(data.source_denom).toBe('umfx');
      expect(data.target_denom).toBe('factory/manifest1admin/upwr');
      expect(data.paused).toBe(false);
      expect(data.preview).toBeUndefined();
    });

    it('returns preview when amount is provided', async () => {
      mockConfigResponse();
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate', {
        amount: '1000000',
      });
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.preview).toEqual({
        input_amount: '1000000',
        input_denom: 'umfx',
        output_amount: '379000',
        output_denom: 'factory/manifest1admin/upwr',
      });
    });

    it('rejects non-numeric amount', async () => {
      mockConfigResponse();
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate', {
        amount: 'abc',
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Invalid conversion amount');
    });
  });

  describe('convert_mfx_to_pwr', () => {
    it('rejects when contract is paused', async () => {
      mockConfigResponse({ paused: true });
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: '1000000',
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('currently paused');
    });

    it('rejects zero amount', async () => {
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: '0',
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('positive integer string');
      expect(mockSignAndBroadcast).not.toHaveBeenCalled();
    });

    it('rejects zero-equivalent amounts like "00"', async () => {
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: '00',
      });
      expect(result.isError).toBe(true);
      expect(mockSignAndBroadcast).not.toHaveBeenCalled();
    });

    it('rejects non-numeric amount', async () => {
      mockConfigResponse();
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: 'abc',
      });
      expect(result.isError).toBe(true);
      expect(mockSignAndBroadcast).not.toHaveBeenCalled();
    });

    it('reports failed on-chain transaction', async () => {
      mockConfigResponse();
      mockSignAndBroadcast.mockResolvedValue({
        transactionHash: 'FAILHASH',
        code: 5,
        height: 100,
        gasUsed: 100000,
        gasWanted: 200000,
        rawLog: 'contract error: insufficient funds',
      });
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: '1000000',
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('failed with code 5');
    });

    it('executes conversion and returns result', async () => {
      mockConfigResponse();
      mockSignAndBroadcast.mockResolvedValue({
        transactionHash: 'TXHASH123',
        code: 0,
        height: 100,
        gasUsed: 200000,
        gasWanted: 250000,
      });
      const server = makeServer();
      const result = await callTool(server, 'convert_mfx_to_pwr', {
        amount: '1000000',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.transactionHash).toBe('TXHASH123');
      expect(data.expected_output.amount).toBe('379000');
      expect(data.rate).toBe('0.379');
    });
  });

  describe('calculateConversion edge cases', () => {
    it('handles integer rate (no decimals)', async () => {
      mockConfigResponse({ rate: '2' });
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate', {
        amount: '500',
      });
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.preview.output_amount).toBe('1000');
    });

    it('handles zero rate', async () => {
      mockConfigResponse({ rate: '0' });
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate', {
        amount: '1000000',
      });
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.preview.output_amount).toBe('0');
    });

    it('handles high-precision rate', async () => {
      mockConfigResponse({ rate: '0.000001' });
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate', {
        amount: '1000000',
      });
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.preview.output_amount).toBe('1');
    });
  });

  describe('queryConverterConfig validation', () => {
    it('rejects malformed contract response', async () => {
      mockSmartContractState.mockResolvedValue({
        data: toUtf8(JSON.stringify({ wrong: 'shape' })),
      });
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate');
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Unexpected converter config shape');
    });

    it('rejects non-JSON contract response', async () => {
      mockSmartContractState.mockResolvedValue({
        data: toUtf8('not json'),
      });
      const server = makeServer();
      const result = await callTool(server, 'get_mfx_to_pwr_rate');
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Failed to parse converter config');
    });
  });
});
