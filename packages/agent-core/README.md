# @manifest-network/manifest-agent-core

TypeScript orchestration surface for Manifest agent flows. This package owns the deploy / manage-domain / troubleshoot / close-lease orchestration that host surfaces consume in lockstep — a bug fix in the core's recovery branch fixes every host surface simultaneously.

> **Status.** All four orchestration functions have real implementations as of ENG-129 (PRs 1–4). The package remains `private: true` pending a publish decision; do not depend on it from external repos yet.

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
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
```

Each function takes a typed args object plus a callbacks object with `onConfirm` / `onProgress` / `onComplete` / `onFailure` hooks. `deployApp` takes a `DeploySpec`; the other three take action-discriminated `*Args` types (e.g. `ManageDomainArgs` is `{ action: 'set' | 'clear' | 'lookup', ... }`). Only `deployApp` accepts `onPlan` and uses an enriched `onFailure` — `(failure: FailureEnvelope, options: RecoveryOption[]) => Promise<RecoveryChoice>` — to drive partial-success recovery: retry the set-domain step, salvage the lease without the custom domain, cancel a pending lease, or close an active one. See `RecoveryOptionId` in `src/types.ts` for the exact literal IDs (`retry_set_domain`, `salvage_without_domain`, `cancel_lease`, `close_lease`). The other three use the simpler `(failure: { reason: string }) => Promise<void>`. See `src/types.ts` for the frozen shapes.

## Where each function lives

| Function | Home |
| --- | --- |
| `deployApp` | `src/deploy-app.ts` |
| `manageDomain` | `src/manage-domain.ts` |
| `troubleshootDeployment` | `src/troubleshoot.ts` |
| `closeLease` | `src/close-lease.ts` |
