// KNOWN-BAD FIXTURE (ENG-641) — NOT compiled into any package. See ../README.md.
//
// Simulates an `examples/**/src` file reaching past the public SDK into another workspace package's
// source. The example exists to demonstrate that the published SDK surface is SUFFICIENT on its own;
// it stops demonstrating that the moment it reaches into core/fred/agent-core directly. The
// production `no-example-to-non-sdk-package` rule MUST flag this.
//
// This is the sibling of `bad-import.ts`, which covers the same §9 invariant from the node_modules
// side. Two fixtures because two rules: once package names alias to `src` (ENG-641), a workspace
// sibling is a FIRST-PARTY edge, so the `dependencyTypes: npm…` allowlist in
// `example-composes-only-sdk` no longer sees it at all.
import type { ProviderApiError } from '@manifest-network/manifest-mcp-fred';

export type BadWorkspaceAlias = ProviderApiError;
