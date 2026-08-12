// KNOWN-BAD FIXTURE (ENG-641) — NOT compiled into any package. See ../README.md.
//
// Simulates a `packages/fred/src` file reaching UP into agent-core. The layering is
// agent-core -> fred -> core; fred must never know about its own consumer. The production
// `no-fred-to-agentcore` rule MUST flag this.
//
// Imported by PACKAGE NAME: see `../core-src/bad-fred-import.ts` for why that form is the
// load-bearing one.
import type { AgentCoreRuntime } from '@manifest-network/manifest-agent-core';

export type BadAgentCoreAlias = AgentCoreRuntime;
