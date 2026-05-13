# `agent-core` skill-replay fixtures

This directory holds the byte-baseline parity contract for ENG-129's
extraction work. The fixtures here are committed artifacts — TS code in
`packages/agent-core/src/**` must produce byte-identical output against
the same inputs for the per-skill replay tests to pass.

## Provenance

Fixtures are captured by running the plugin's existing CJS pipeline
(`/home/fmorency/dev/manifest-agent-plugin/scripts/*.cjs`) on the
canonical inputs registered in `scenarios.json`, then recording the
boundary outputs of each pipeline step.

**Plugin git hash:** `3a33e80` (`main`, post-ENG-123 + ENG-124).
Update this when re-capturing against a moved plugin tree.

## Layout

```
__fixtures__/
├── README.md           # this file
├── scenarios.json      # canonical-input registry (1 entry per scenario)
├── chain-data/         # synthetic chain registry JSON for humanize-denom
│   └── testnet.json    # fee tokens map (umfx → MFX, etc.)
├── internals/          # one JSON per scenario for unit-test ports
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
        │   ├── expected-intent-recap.txt    # render-intent-recap.cjs output
        │   ├── expected-plan.txt            # render-deployment-plan.cjs output (BYTE-BASELINE)
        │   ├── expected-readiness.json      # evaluate-readiness.cjs output
        │   ├── expected-classify-response.json
        │   ├── expected-success.txt         # format-success.cjs output
        │   └── expected-saved-manifest.json # save-manifest.cjs file content
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
            └── expected-classify-error.json      # classify-deploy-error.cjs output
```

## Initial scope (parent Q3 refinement, 2026-05-12)

Only **`deploy-app/01-fast-path-active`** and
**`deploy-app/03-partial-success-set-domain-failed`** are baselined up
front. The other six scenarios (`02-custom-domain-success`,
`04-readiness-block`, `05-stack-spec`, `manage-domain/*`,
`close-lease/*`, `troubleshoot/*`) land on-demand or before PR 4 closes.

## Workflow

### Capture / re-capture

```bash
cd /home/fmorency/dev/manifest-mcp-mono.eng-129
source ~/.nvm/nvm.sh && nvm use 22

# Default plugin path is /home/fmorency/dev/manifest-agent-plugin.
# Override with $MANIFEST_AGENT_PLUGIN_ROOT if needed.
node packages/agent-core/scripts/baseline-skill-fixtures.cjs
```

Re-runs are idempotent: the script writes new outputs into a tmpdir,
diffs against the committed fixtures, and exits 0 if identical, 1 if
diffs are detected. Reviewers decide whether to accept (commit) or
fix the regression.

### CI

CI does NOT invoke the baseline script. Fixtures are committed
artifacts. The replay tests in
`packages/agent-core/src/__tests__/**` read fixtures from disk and
compare against TS runtime output.

## Editing fixtures

Do not hand-edit `expected-*` files. They are byte-baselines; if the
plugin's expected output changes, re-run the capture script and commit
the diff with an explanation. Hand-edits introduce parity drift that
the test suite cannot detect.

`input/*` files are designer-curated and CAN be edited (carefully) to
extend scenario coverage. Adding a new scenario:
1. Add a new directory under `skills/<skill>/<NN>-<name>/input/`.
2. Author the input files (canonical inputs the TS function would receive).
3. Register the scenario in `scenarios.json`.
4. Re-run the baseline script; commit the resulting `expected-*` files
   alongside the inputs.
