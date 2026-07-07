# @manifest-network/manifest-agent-core

TypeScript orchestration surface for Manifest agent flows. This package owns the deploy / manage-domain / troubleshoot / close-lease orchestration that host surfaces consume in lockstep — a bug fix in the core's recovery branch fixes every host surface simultaneously.

> **Status.** Publicly published on npm as `@manifest-network/manifest-agent-core` (ENG-129). Consume via `npm install @manifest-network/manifest-agent-core`. The MCP-server adapter that wraps this orchestration surface via elicitation lives at [`@manifest-network/manifest-mcp-agent`](../agent/README.md).

See [ENG-127](https://linear.app/liftedinit/issue/ENG-127) for the broader initiative and [ENG-128](https://linear.app/liftedinit/issue/ENG-128) for the bootstrap PR.

## Layering

```
manifest-mcp-mono       — protocol-level tools (RPC over MCP)
manifest-agent-core     — orchestration, verification, recovery, plans, journal   (this package)
host surface(s)         — chat / conversational / autonomous front-ends
```

The core sits above MCP; host surfaces sit above the core. Callbacks are where surfaces differ — a chat surface emits chat output and `AskUserQuestion`; a conversational surface updates its UI; an autonomous daemon auto-picks recovery branches per policy.

## Public surface

```ts
import {
  closeLease,
  deployApp,
  loadChainDenomMap,
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
```

`loadChainDenomMap` is a helper that pre-loads a chain-registry denom map (the `DeployAppOptions.chainDataFile` input) for denom humanization — e.g. `umfx` → `MFX` — in plan/progress output.

Each function takes a typed args object plus a callbacks object with `onConfirm` / `onProgress` / `onComplete` / `onFailure` hooks. `deployApp` takes an `AppDeploySpec`; the other three take their own `*Args` types — only `ManageDomainArgs` is action-discriminated (`{ action: 'set' | 'clear' | 'lookup', ... }`), while `TroubleshootArgs` and `CloseLeaseArgs` are plain `{ leaseUuid: string }` interfaces. Only `deployApp` accepts `onPlan` and `onResolveSku` (ambiguous-SKU disambiguation) and uses an enriched `onFailure` — `(failure: FailureEnvelope, options: RecoveryOption[]) => Promise<RecoveryChoice>` — to drive partial-success recovery: retry the set-domain step, salvage the lease without the custom domain, cancel a pending lease, or close an active one. See `RecoveryOptionId` in `src/types.ts` for the exact literal IDs (`retry_set_domain`, `salvage_without_domain`, `cancel_lease`, `close_lease`). The other three use the simpler `(failure: { reason: string }) => Promise<void>`. See `src/types.ts` for the frozen shapes.

## Where each function lives

| Function | Home |
| --- | --- |
| `deployApp` | `src/deploy-app.ts` |
| `manageDomain` | `src/manage-domain.ts` |
| `troubleshootDeployment` | `src/troubleshoot.ts` |
| `closeLease` | `src/close-lease.ts` |

## SSRF-guarded fetch (Node-only subpath)

The SSRF-guarded `fetch` factory is re-exported from a Node-only subpath, `@manifest-network/manifest-agent-core/guarded-fetch` — deliberately kept off the package barrel so browser bundles don't drag in `undici` / `node:async_hooks` (mirrors core's `@manifest-network/manifest-mcp-core/guarded-fetch` split). Import it from that subpath, never the barrel.
