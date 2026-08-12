// KNOWN-BAD FIXTURE (ENG-641) — NOT compiled into any package. See ../README.md.
//
// Simulates a `packages/core/src` file reaching UP into agent-core — the second arm of the same
// rule (`to: ^packages/(fred|agent-core)/src`), which a fred-only fixture would leave unproven.
// The production `no-core-to-fred-or-agentcore` rule MUST flag this.
//
// Imported by PACKAGE NAME: see the sibling fixture `bad-fred-import.ts` for why that form is the
// load-bearing one.
import type { AgentCoreRuntime } from '@manifest-network/manifest-agent-core';

export type BadAgentCoreAlias = AgentCoreRuntime;
