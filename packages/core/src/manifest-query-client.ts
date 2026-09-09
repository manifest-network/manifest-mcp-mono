import type { cosmwasm as cosmwasmNs } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js';
import type { ibc as ibcNs } from '@manifest-network/manifestjs/dist/codegen/ibc/bundle.js';
import type { liftedinit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js';
import type { osmosis as osmosisNs } from '@manifest-network/manifestjs/dist/codegen/osmosis/bundle.js';
import type { strangelove_ventures as strangeloveVenturesNs } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/bundle.js';

// Combined query client type: liftedinit modules (cosmos + billing/manifest/sku) + cosmwasm
// + strangelove_ventures (poa) + osmosis (tokenfactory) + ibc (transfer, channel, client, connection).
// Uses Pick to extract only each factory's unique namespace, avoiding conflicts with overlapping cosmos types.
type LiftedinitQueryClient = Awaited<
  ReturnType<typeof liftedinit.ClientFactory.createRPCQueryClient>
>;
type CosmwasmQueryClient = Awaited<
  ReturnType<typeof cosmwasmNs.ClientFactory.createRPCQueryClient>
>;
type StrangeloveVenturesQueryClient = Awaited<
  ReturnType<typeof strangeloveVenturesNs.ClientFactory.createRPCQueryClient>
>;
type OsmosisQueryClient = Awaited<
  ReturnType<typeof osmosisNs.ClientFactory.createRPCQueryClient>
>;
type IbcQueryClient = Awaited<
  ReturnType<typeof ibcNs.ClientFactory.createRPCQueryClient>
>;
export type ManifestQueryClient = LiftedinitQueryClient &
  Pick<CosmwasmQueryClient, 'cosmwasm'> &
  Pick<StrangeloveVenturesQueryClient, 'strangelove_ventures'> &
  Pick<OsmosisQueryClient, 'osmosis'> &
  Pick<IbcQueryClient, 'ibc'>;
