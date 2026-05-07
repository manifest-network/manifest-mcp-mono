# Documentation

Long-form documentation that complements the package READMEs.

| Topic | Audience | What's inside |
|-------|----------|---------------|
| [Tool selection guide](tool-selection-guide.md) | Users + agents | Which of the four MCP servers to wire up, and which tool to reach for in common scenarios |
| [Usage examples](usage-examples.md) | Users | End-to-end natural-language transcripts: balance checks, transfers, deployments, diagnostics, MFX→PWR conversion |
| [Prompts and resources reference](prompts-and-resources.md) | Users + agents | The 3 MCP prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`) and 3 resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) the Fred server exposes |
| [Troubleshooting](troubleshooting.md) | Users | Common error codes, what they mean, and how to recover |
| [Security model](security.md) | Users + operators | How ADR-036 auth works, what the wallet sees and signs, what's redacted, what's not, and the boundary between the agent and the human |
| [Library usage](library-usage.md) | Developers | Importing the packages outside an MCP host (Barney is the reference consumer) — wallet bootstrap, fred tool functions, HTTP clients |

For build, test, and contribution workflows, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
For internal architecture, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
