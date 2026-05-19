# `agent-core` skill-replay fixtures

This directory holds the byte-baseline parity contract for ENG-129's
extraction work. The fixtures here are committed artifacts — TS code in
`packages/agent-core/src/**` must produce byte-identical output against
the same inputs for the per-skill replay tests to pass.

## Layout

```
__fixtures__/
├── README.md           # this file
├── scenarios.json      # canonical-input registry (1 entry per scenario)
├── chain-data/         # synthetic chain registry JSON for humanize-denom
│   └── testnet.json    # fee tokens map (umfx → MFX, etc.)
├── internals/          # (DEFERRED — fixture tree for unit-test ports; tracked for PR-3.x / ENG-185)
│   ├── verify-recover/
│   ├── classify-deploy-error/
│   ├── verify-domain-state/
│   └── evaluate-readiness/
└── skills/
    └── deploy-app/
        ├── 01-fast-path-active/             # deploy-happy
        │   ├── input/                       # canonical inputs
        │   │   ├── spec.json                # DeploySpec (single-service)
        │   │   ├── readiness-response.json  # mocked check_deployment_readiness
        │   │   ├── fee-response.json        # mocked cosmos_estimate_fee
        │   │   ├── meta-hash-response.json  # mocked build_manifest_preview
        │   │   └── deploy-response.json     # mocked deploy_app success
        │   ├── mcp-script.json              # ordered MCP call/response transcript
        │   ├── expected-intent-recap.txt    # render-intent-recap output
        │   ├── expected-plan.txt            # render-deployment-plan output (BYTE-BASELINE)
        │   ├── expected-readiness.json      # evaluate-readiness output
        │   ├── expected-classify-response.json
        │   ├── expected-success.txt         # format-success output
        │   └── expected-saved-manifest.json # save-manifest file content (deferred — see scope note)
        └── 03-partial-success-set-domain-failed/  # deploy-partial-success
            ├── input/                            # canonical inputs
            │   ├── spec.json                     # DeploySpec WITH customDomain
            │   ├── readiness-response.json
            │   ├── fee-response.json             # both create-lease + set-domain fees
            │   ├── meta-hash-response.json
            │   └── deploy-error.json             # MCP error envelope ("Deploy partially succeeded:")
            ├── mcp-script.json
            ├── expected-intent-recap.txt
            ├── expected-plan.txt                 # dual-fee variant
            ├── expected-readiness.json           # evaluate-readiness output
            └── expected-classify-error.json      # classify-deploy-error output
```

## Initial scope (parent Q3 refinement, 2026-05-12)

Only **`deploy-app/01-fast-path-active`** and
**`deploy-app/03-partial-success-set-domain-failed`** are baselined up
front. The other six scenarios (`02-custom-domain-success`,
`04-readiness-block`, `05-stack-spec`, `manage-domain/*`,
`close-lease/*`, `troubleshoot/*`) land on-demand or before PR 4 closes.

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
