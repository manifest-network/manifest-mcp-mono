import {
  bigIntReplacer,
  type CosmosClientManager,
  createPagination,
  LeaseState,
  leaseStateToJSON,
  MAX_PAGE_LIMIT,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface RegisterResourcesDeps {
  mcpServer: McpServer;
  clientManager: CosmosClientManager;
  walletProvider: WalletProvider;
}

export function registerResources(deps: RegisterResourcesDeps): void {
  const { mcpServer, clientManager, walletProvider } = deps;
  const fixedPagination = createPagination(MAX_PAGE_LIMIT);

  const resourceJson = (
    uri: URL,
    data: unknown,
  ): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(data, bigIntReplacer, 2),
      },
    ],
  });

  // -- manifest://leases/active --
  mcpServer.registerResource(
    'leases-active',
    'manifest://leases/active',
    {
      title: "Caller's active and pending leases",
      description:
        "Snapshot of the caller wallet's leases currently in ACTIVE or PENDING state. Useful as immutable context for an agent deciding which app to operate on.",
      mimeType: 'application/json',
    },
    async (uri) => {
      await clientManager.acquireRateLimit();
      const queryClient = await clientManager.getQueryClient();
      const tenant = await walletProvider.getAddress();
      const billing = queryClient.liftedinit.billing.v1;

      const [active, pending] = await Promise.all([
        billing.leasesByTenant({
          tenant,
          stateFilter: LeaseState.LEASE_STATE_ACTIVE,
          pagination: fixedPagination,
        }),
        billing.leasesByTenant({
          tenant,
          stateFilter: LeaseState.LEASE_STATE_PENDING,
          pagination: fixedPagination,
        }),
      ]);

      const summarize = (l: {
        uuid: string;
        state: number;
        providerUuid: string;
        createdAt?: Date;
        metaHash?: Uint8Array;
      }) => ({
        uuid: l.uuid,
        state: leaseStateToJSON(l.state),
        provider_uuid: l.providerUuid,
        created_at: l.createdAt?.toISOString(),
      });

      return resourceJson(uri, {
        tenant,
        active: active.leases.map(summarize),
        pending: pending.leases.map(summarize),
        counts: {
          active: active.leases.length,
          pending: pending.leases.length,
        },
      });
    },
  );

  // -- manifest://leases/recent --
  mcpServer.registerResource(
    'leases-recent',
    'manifest://leases/recent',
    {
      title: "Caller's most recent leases (any state)",
      description:
        "The caller's leases ordered by most recent first, up to 50, regardless of state. Useful for surfacing recently-closed or rejected leases the agent may want to act on.",
      mimeType: 'application/json',
    },
    async (uri) => {
      await clientManager.acquireRateLimit();
      const queryClient = await clientManager.getQueryClient();
      const tenant = await walletProvider.getAddress();
      const result = await queryClient.liftedinit.billing.v1.leasesByTenant({
        tenant,
        stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
        pagination: {
          key: new Uint8Array(),
          offset: 0n,
          limit: 50n,
          countTotal: true,
          reverse: true,
        },
      });

      return resourceJson(uri, {
        tenant,
        leases: result.leases.map((l) => ({
          uuid: l.uuid,
          state: leaseStateToJSON(l.state),
          provider_uuid: l.providerUuid,
          created_at: l.createdAt?.toISOString(),
          closed_at: l.closedAt?.toISOString(),
        })),
        total: result.pagination?.total?.toString(),
      });
    },
  );

  // -- manifest://providers --
  mcpServer.registerResource(
    'providers',
    'manifest://providers',
    {
      title: 'Provider catalog snapshot',
      description:
        'All active providers and their available SKUs (chain-side data only — no live HTTP health check). Use browse_catalog when health is needed.',
      mimeType: 'application/json',
    },
    async (uri) => {
      await clientManager.acquireRateLimit();
      const queryClient = await clientManager.getQueryClient();
      const sku = queryClient.liftedinit.sku.v1;
      const [providersResult, skusResult] = await Promise.all([
        sku.providers({ activeOnly: true, pagination: fixedPagination }),
        sku.sKUs({ activeOnly: true, pagination: fixedPagination }),
      ]);

      const providers = providersResult.providers.map((p) => ({
        uuid: p.uuid,
        address: p.address,
        api_url: p.apiUrl,
        active: p.active,
      }));

      const skus = skusResult.skus.map((s) => ({
        uuid: s.uuid,
        name: s.name,
        provider_uuid: s.providerUuid,
        active: s.active,
        base_price: s.basePrice
          ? { amount: s.basePrice.amount, denom: s.basePrice.denom }
          : null,
      }));

      return resourceJson(uri, {
        providers,
        skus,
        counts: {
          providers: providers.length,
          skus: skus.length,
        },
      });
    },
  );
}
