import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Shared test helper: connects an MCP client to a server via in-memory
 * transport, calls the given tool, then cleans up both transports.
 *
 * Transports are tracked in `activeTransports` only while the call is
 * in flight and removed after cleanup, so callers' `afterEach` hooks
 * won't double-close.
 *
 * @param server  - The MCP `Server` instance (from `getServer()`)
 * @param toolName - Name of the tool to invoke
 * @param toolInput - Optional tool arguments
 * @param activeTransports - Optional mutable array; transports are added
 *   before connect and removed after cleanup so only leaked transports
 *   (from mid-connect failures) remain for the caller's `afterEach`.
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

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return await client.callTool({ name: toolName, arguments: toolInput }) as ToolResult;
  } finally {
    await client.close().catch(() => {});
    await clientTransport.close().catch(() => {});
    await serverTransport.close().catch(() => {});

    // Remove from tracking array so afterEach won't double-close
    const idx = activeTransports.indexOf(clientTransport);
    if (idx !== -1) activeTransports.splice(idx, 2);
  }
}
