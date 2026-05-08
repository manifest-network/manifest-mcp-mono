# @manifest-network/manifest-agent-core

TypeScript orchestration surface for Manifest agent flows. This package owns the deploy / manage-domain / troubleshoot / close-lease orchestration that two surfaces (Claude Code's `manifest-agent-plugin` and Barney) consume in lockstep — a bug fix in the core's recovery branch fixes every surface simultaneously.

> **Status — type contract only.** Stubs throw `NotImplemented`. Function bodies land in ENG-129. The package is `private: true` until then; do not depend on it from external repos yet.

See [ENG-127](https://linear.app/liftedinit/issue/ENG-127) for the broader initiative and [ENG-128](https://linear.app/liftedinit/issue/ENG-128) for this bootstrap PR.

## Layering

```
manifest-mcp-mono       — protocol-level tools (RPC over MCP)
manifest-agent-core     — orchestration, verification, recovery, plans, journal   (this package)
manifest-agent-plugin   — Claude Code surface
barney                  — conversational / intent surface
future daemon           — autonomous surface
```

The core sits above MCP; surfaces sit above the core. Callbacks are where surfaces differ — the plugin emits chat output and `AskUserQuestion`; Barney updates its UI; a future daemon auto-picks recovery branches per policy.

## Public surface

```ts
import {
  closeLease,
  deployApp,
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
```

Each function takes a typed args object plus a callbacks object with `onPlan` / `onConfirm` / `onProgress` / `onComplete` / `onFailure` hooks (`onPlan` only on `deployApp`). All four currently throw `NotImplemented` — see the type contract in `src/types.ts` for the frozen shapes.

## Where each function will live (planned in ENG-129)

| Stub | Planned home |
| --- | --- |
| `deployApp` | `src/deploy-app.ts` |
| `manageDomain` | `src/manage-domain.ts` |
| `troubleshootDeployment` | `src/troubleshoot.ts` |
| `closeLease` | `src/close-lease.ts` |

The shape sources of truth currently live in the `manifest-agent-plugin` repo's `scripts/*.cjs` files (e.g. `_spec.cjs`, `evaluate-readiness.cjs`, `classify-deploy-error.cjs`). ENG-129 lifts those into the typed functions above.
