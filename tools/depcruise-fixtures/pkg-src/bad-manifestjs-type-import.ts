// KNOWN-BAD FIXTURE (ENG-309) — NOT compiled into any package. See ../README.md.
//
// Simulates a downstream-package `src` file reaching into a manifestjs GENERATED TYPE path
// (`…/codegen/.../types.js`) instead of consuming the canonical DTO via core's chokepoint
// (`core/src/manifest-types.ts`). The production `manifestjs-types-chokepoint` rule MUST flag this.
import type { Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

export type BadLeaseAlias = Lease;
