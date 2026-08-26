import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from './callTool.js';

/**
 * Scripted responder for incoming `elicitation/create` requests on the
 * test-side MCP `Client`. The test author owns the mapping from request
 * shape → result — the helper just wires it up.
 *
 * `respond` may be sync or async. It must return a valid `ElicitResult`
 * (`{ action: 'accept' | 'decline' | 'cancel', content?: ... }`).
 */
export interface ElicitationScript {
  respond: (req: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
}

export interface ConnectedElicitationClient {
  readonly client: Client;
  close(): Promise<void>;
}

/**
 * Connect an elicitation-capable test client while leaving its lifetime under
 * the caller's control. This is the lower-level form used by cancellation and
 * notification tests that must keep the transport open after `callTool`
 * rejects; closing immediately would abort the server request independently
 * and make signal-forwarding assertions vacuous.
 */
export async function connectClientWithElicitation(
  server: Server,
  script?: ElicitationScript,
  activeTransports: InMemoryTransport[] = [],
  declareElicitationCapability = true,
): Promise<ConnectedElicitationClient> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  activeTransports.push(clientTransport, serverTransport);

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    declareElicitationCapability
      ? { capabilities: { elicitation: {} } }
      : { capabilities: {} },
  );

  if (declareElicitationCapability && script !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      return await script.respond(request);
    });
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => {});
    await clientTransport.close().catch(() => {});
    await serverTransport.close().catch(() => {});

    for (const transport of [clientTransport, serverTransport]) {
      const index = activeTransports.indexOf(transport);
      if (index !== -1) activeTransports.splice(index, 1);
    }
  };

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Mirror of `callTool` for tools that mid-execution call
 * `server.elicitInput(...)`. Connects an MCP client (advertising the
 * `elicitation` capability by default) to the server over an in-memory
 * transport, registers a request handler that delegates each incoming
 * elicitation to `script.respond`, then invokes the named tool.
 *
 * Cleanup always runs via the `finally` block: client and both transports
 * are closed, then removed from `activeTransports` to prevent double-close
 * in the caller's `afterEach`.
 *
 * @param server  - The MCP `Server` instance (from `getServer()`)
 * @param toolName - Name of the tool to invoke
 * @param toolInput - Tool arguments
 * @param script - Scripted responder for `elicitation/create` requests
 * @param activeTransports - Optional mutable array; transports are added
 *   before the call and removed after cleanup completes.
 * @param declareElicitationCapability - When `true` (default) the test
 *   `Client` advertises `capabilities: { elicitation: {} }`. Set to
 *   `false` to exercise the wrapper's capability-guard path (the tool
 *   should reject with `INVALID_CONFIG` before any elicitation happens).
 */
export async function callToolWithElicitation(
  server: Server,
  toolName: string,
  toolInput: Record<string, unknown>,
  script: ElicitationScript,
  activeTransports: InMemoryTransport[] = [],
  declareElicitationCapability = true,
): Promise<ToolResult> {
  const connection = await connectClientWithElicitation(
    server,
    script,
    activeTransports,
    declareElicitationCapability,
  );

  try {
    return (await connection.client.callTool({
      name: toolName,
      arguments: toolInput,
    })) as ToolResult;
  } finally {
    await connection.close();
  }
}
