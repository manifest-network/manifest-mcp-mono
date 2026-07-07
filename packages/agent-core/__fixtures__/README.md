# `agent-core` skill-replay fixtures

This directory holds the byte-baseline parity contract for ENG-129's
extraction work. The fixtures here are committed artifacts — TS code in
`packages/agent-core/src/**` must produce byte-identical output against
the same inputs for the per-skill replay tests to pass.

## Layout

```
__fixtures__/
├── README.md           # this file
├── scenarios.json      # canonical scenario registry (skill, kind, chain, UUIDs)
├── chain-data/         # synthetic chain registry JSON for humanize-denom
│   └── testnet.json    # fee tokens map (umfx → MFX, etc.)
└── skills/
    ├── deploy-app/
    │   ├── 01-fast-path-active/
    │   ├── 03-partial-success-set-domain-failed/
    │   ├── 05-needs-wait-then-active/
    │   ├── 06-classifier-failed-terminal/
    │   └── 07-classifier-failed-no-lease-uuid/
    ├── manage-domain/
    │   ├── 01-set-success/
    │   ├── 02-set-mismatch/
    │   ├── 03-clear-success/
    │   ├── 04-lookup-found/
    │   ├── 05-lookup-not-found/
    │   └── 06-stack-set-success/
    ├── close-lease/
    │   ├── 01-close-success/
    │   ├── 02-close-pending-verify-fail/
    │   └── 03-close-not-found/
    └── troubleshoot/
        ├── 01-active-healthy/
        ├── 02-pending/
        ├── 03-closed-terminal/
        └── 04-lease-not-found/
```

Each scenario directory holds an `input/` subtree (canonical inputs the TS
function receives) plus committed `expected-*` baselines; the exact files
vary by scenario kind — see `scenarios.json` for the full set. A
representative deploy-app scenario:

```
01-fast-path-active/
├── input/
│   ├── spec.json                # DeploySpec (single-service)
│   ├── readiness-response.json  # mocked check_deployment_readiness
│   ├── fee-response.json        # mocked cosmos_estimate_fee
│   ├── meta-hash-response.json  # mocked build_manifest_preview
│   └── deploy-response.json     # mocked deploy_app success
├── mcp-script.json              # ordered MCP call/response transcript
├── expected-intent-recap.txt    # render-intent-recap output
├── expected-plan.txt            # render-deployment-plan output (BYTE-BASELINE)
├── expected-readiness.json      # evaluate-readiness output
├── expected-classify-response.json
└── expected-success.txt         # format-success output
```

## Baselined scenarios

All four skills have committed scenario baselines on disk:

- **`deploy-app/`** — `01-fast-path-active`,
  `03-partial-success-set-domain-failed`, `05-needs-wait-then-active`,
  `06-classifier-failed-terminal`, `07-classifier-failed-no-lease-uuid`
- **`manage-domain/`** — `01-set-success`, `02-set-mismatch`,
  `03-clear-success`, `04-lookup-found`, `05-lookup-not-found`,
  `06-stack-set-success`
- **`close-lease/`** — `01-close-success`, `02-close-pending-verify-fail`,
  `03-close-not-found`
- **`troubleshoot/`** — `01-active-healthy`, `02-pending`,
  `03-closed-terminal`, `04-lease-not-found`

See `scenarios.json` for the canonical per-scenario metadata (skill, kind,
active chain, and UUIDs).

## CI

CI does NOT regenerate fixtures. Fixtures are committed artifacts. The
replay tests in `packages/agent-core/src/*.test.ts` and
`packages/agent-core/src/internals/*.test.ts` read fixtures from disk
and compare against TS runtime output.

## Editing fixtures

Do not hand-edit `expected-*` files. They are byte-baselines. If the
expected output changes (because the TS implementation legitimately
changed), update the baseline together with the code change and commit
the diff with an explanation. Hand-edits without a corresponding code
change introduce parity drift that the test suite cannot detect.

`input/*` files are designer-curated and CAN be edited (carefully) to
extend scenario coverage. Adding a new scenario:
1. Add a new directory under `skills/<skill>/<NN>-<name>/input/`.
2. Author the input files (canonical inputs the TS function would receive).
3. Register the scenario in `scenarios.json`.
4. Capture the resulting `expected-*` outputs and commit them alongside
   the inputs.
