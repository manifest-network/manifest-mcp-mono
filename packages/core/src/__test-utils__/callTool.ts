import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Shared test helper: connects an MCP client to a server via in-memory
 * transport, calls the given tool, then cleans up.
 *
 * @param server  - The MCP `Server` instance (from `getServer()`)
 * @param toolName - Name of the tool to invoke
 * @param toolInput - Optional tool arguments
 * @param activeTransports - Mutable array that tracks open transports
 *   so the caller's `afterEach` can close them on failure.
 */
export async function callTool(
  server: Server,
  toolName: string,
  toolInput: Record<string, unknown> = {},
  activeTransports: InMemoryTransport[] = [],
): Promise<ToolResult> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  activeTransports.push(clientTransport, serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return await client.callTool({ name: toolName, arguments: toolInput }) as ToolResult;
  } finally {
    await client.close();
  }
}
