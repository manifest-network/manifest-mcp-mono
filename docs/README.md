# Documentation

Long-form documentation that complements the package READMEs.

| Topic | Audience | What's inside |
|-------|----------|---------------|
| [Tool selection guide](tool-selection-guide.md) | Users + agents | Which MCP servers to wire up, and which tool to reach for in common scenarios |
| [Usage examples](usage-examples.md) | Users | End-to-end natural-language transcripts: balance checks, transfers, deployments, diagnostics, MFX→PWR conversion |
| [Prompts and resources reference](prompts-and-resources.md) | Users + agents | The 3 MCP prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`) and 3 resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) the Fred server exposes |
| [Troubleshooting](troubleshooting.md) | Users | Common error codes, what they mean, and how to recover |
| [Security model](security.md) | Users + operators | How ADR-036 auth works, what the wallet sees and signs, what's redacted, what's not, and the boundary between the agent and the human |
| [SDK reference](../packages/sdk/README.md) | Developers | Build a TypeScript app on Manifest + Fred — install, quickstart, the bound client, subpath map |
| [SDK cookbook](library-usage.md) | Developers | The library deep dive: wallets, the three client factories, reads/txs, deploy lifecycle, live status, errors (Barney — the Manifest web frontend — is the reference consumer) |

For build, test, and contribution workflows, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
For internal architecture, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
