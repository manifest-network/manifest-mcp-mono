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
 * Cleanup always runs via the `finally` block: client and both transports
 * are closed, then removed from `activeTransports` to prevent double-close
 * in the caller's `afterEach`.
 *
 * @param server  - The MCP `Server` instance (from `getServer()`)
 * @param toolName - Name of the tool to invoke
 * @param toolInput - Optional tool arguments
 * @param activeTransports - Optional mutable array; transports are added
 *   before the call and removed after cleanup completes.
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

    // Remove by identity so afterEach won't double-close
    for (const t of [clientTransport, serverTransport]) {
      const idx = activeTransports.indexOf(t);
      if (idx !== -1) activeTransports.splice(idx, 1);
    }
  }
}
