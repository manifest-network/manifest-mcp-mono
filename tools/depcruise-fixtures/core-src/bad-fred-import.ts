// KNOWN-BAD FIXTURE (ENG-641) — NOT compiled into any package. See ../README.md.
//
// Simulates a `packages/core/src` file reaching UP into fred. core is the dependency sink; the DAG
// is node -> {chain, lease, fred, cosmwasm, agent} -> core, never reverse. The production
// `no-core-to-fred-or-agentcore` rule MUST flag this.
//
// The import is written BY PACKAGE NAME because that is the only form anyone actually writes — and
// it is precisely the form the rule used to be blind to (ENG-641): before `webpackConfig` aliased
// package names to `src`, this resolved into `packages/fred/dist/`, which `exclude` deleted from the
// graph, so the edge vanished and the rule matched nothing. A relative `../../fred/src/x.js` import
// would have matched all along, which is exactly why it proves nothing.
import type { ProviderApiError } from '@manifest-network/manifest-mcp-fred';

export type BadFredAlias = ProviderApiError;
