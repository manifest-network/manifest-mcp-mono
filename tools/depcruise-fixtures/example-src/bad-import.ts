// KNOWN-BAD FIXTURE (ENG-309) — NOT compiled into any package. See ../README.md.
//
// Simulates an `examples/**/src` file importing a node_modules package OUTSIDE the compose-only
// ALLOWLIST (the SDK + manifestjs are the ONLY permitted runtime deps). `@cosmjs/proto-signing` is
// the canonical stray import the allowlist must catch (spec §8 (d): "a stray @cosmjs/* / undici / ws
// is caught too"). The production `example-composes-only-sdk` rule MUST flag this.
//
// Why @cosmjs/* and not a sibling `manifest-mcp-*`: a workspace sibling resolves through its symlink
// to `packages/<pkg>/dist/index.js`, which the production `exclude: ^(packages|examples)/[^/]+/dist/`
// drops from the graph (so the edge is never seen). The allowlist's load-bearing target is the
// resolved `node_modules/@…` path of a true external dep — exactly what the spec's Step 5b note
// directs ("the allowlist's `to.path` should match the resolved `node_modules/@cosmjs/...` path").
import '@cosmjs/proto-signing';

export const leak = 1;
