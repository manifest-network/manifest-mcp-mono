#!/usr/bin/env node
'use strict';

/**
 * Baseline / re-baseline the skill-replay fixture set for ENG-129.
 *
 * Drives the plugin's existing CJS pipeline (the canonical reference
 * implementation, at `$MANIFEST_AGENT_PLUGIN_ROOT/scripts/`) on the
 * canonical inputs registered in `packages/agent-core/__fixtures__/scenarios.json`,
 * captures the boundary outputs of each pipeline step, and writes them
 * into the scenario directory as `expected-*` artifacts.
 *
 * Defaults to **diff mode**: writes captured output to a tmpdir, diffs
 * against the committed `expected-*` files, exits 0 if identical, 1 if
 * any drift. This is the steady-state mode for confirming the plugin
 * hasn't moved underneath the parity contract.
 *
 * Pass `--write` to overwrite the committed `expected-*` files in place.
 * Use only when intentionally re-baselining (initial capture, or after
 * a vetted plugin change).
 *
 * Pass `--scenario <id>` to run a single scenario by its `scenarios.json`
 * `id` (e.g. `deploy-app/01-fast-path-active`). Default is "all scenarios
 * registered in scenarios.json".
 *
 * Env:
 *   MANIFEST_AGENT_PLUGIN_ROOT   default `/home/fmorency/dev/manifest-agent-plugin`
 *
 * Exit codes:
 *   0  all scenarios captured + identical to committed (or `--write` succeeded)
 *   1  one or more scenarios drifted; or a plugin script crashed; or
 *      a canonical input was missing
 *
 * NOT run by CI. Fixtures are committed artifacts; replay tests read
 * them from disk. Re-run by the operator when adding a scenario or
 * after the plugin source advances.
 */

const {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, dirname } = require('node:path');

const PLUGIN_ROOT =
  process.env.MANIFEST_AGENT_PLUGIN_ROOT ||
  '/home/fmorency/dev/manifest-agent-plugin';
const PLUGIN_SCRIPTS = join(PLUGIN_ROOT, 'scripts');
const FIXTURES_ROOT = join(__dirname, '..', '__fixtures__');
const CHAIN_DATA_FILE = join(FIXTURES_ROOT, 'chain-data', 'testnet.json');

// --------------------- arg parse ---------------------

function parseArgs(argv) {
  const args = { write: false, scenarioFilter: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--write') args.write = true;
    else if (argv[i] === '--scenario' && argv[i + 1]) {
      args.scenarioFilter = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        `Usage: node baseline-skill-fixtures.cjs [--write] [--scenario <id>]\n`,
      );
      process.exit(0);
    }
  }
  return args;
}

// --------------------- helpers ---------------------

function runPluginScript(scriptName, cliArgs, stdin) {
  const scriptPath = join(PLUGIN_SCRIPTS, scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`plugin script not found: ${scriptPath}`);
  }
  const res = spawnSync(process.execPath, [scriptPath, ...cliArgs], {
    input: stdin || '',
    encoding: 'utf8',
    env: { ...process.env, MANIFEST_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  if (res.error) {
    throw new Error(`spawn of ${scriptName} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `${scriptName} exited ${res.status}\nstderr:\n${res.stderr}`,
    );
  }
  return res.stdout;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function diffOrWrite(committed, captured, write) {
  // committed = absolute path of the canonical fixture
  // captured = string content from this run
  // returns { changed: bool, action: 'identical' | 'wrote' | 'drift' }
  if (write) {
    mkdirSync(dirname(committed), { recursive: true });
    writeFileSync(committed, captured);
    return {
      changed:
        !existsSync(committed) || readFileSync(committed, 'utf8') !== captured,
      action: 'wrote',
    };
  }
  if (!existsSync(committed)) {
    return {
      changed: true,
      action: 'drift',
      detail: 'fixture missing (run with --write to baseline)',
    };
  }
  const old = readFileSync(committed, 'utf8');
  if (old === captured) return { changed: false, action: 'identical' };
  return {
    changed: true,
    action: 'drift',
    detail: `committed length=${old.length}, captured length=${captured.length}`,
  };
}

// --------------------- per-scenario captures ---------------------

function captureDeployApp(scenario, write) {
  const id = scenario.id;
  const scenarioDir = join(FIXTURES_ROOT, 'skills', id);
  const inputDir = join(scenarioDir, 'input');
  if (!existsSync(inputDir)) {
    throw new Error(`scenario ${id}: missing input dir ${inputDir}`);
  }

  const spec = readJson(join(inputDir, 'spec.json'));
  const readinessResp = readJson(join(inputDir, 'readiness-response.json'));
  const feeResp = readJson(join(inputDir, 'fee-response.json'));
  const metaResp = readJson(join(inputDir, 'meta-hash-response.json'));

  const results = []; // [{ name, committedPath, action, detail? }]
  const record = (name, captured) => {
    const committed = join(scenarioDir, name);
    const r = diffOrWrite(committed, captured, write);
    results.push({ name, ...r });
  };

  // ---------------- Step A: spec normalization helpers ----------------
  // summarize-spec.cjs reads the spec on stdin
  const summaryRaw = runPluginScript(
    'summarize-spec.cjs',
    [],
    JSON.stringify(spec),
  );
  const summary = JSON.parse(summaryRaw.trim());
  // primary image (sanity check; not committed)
  runPluginScript('extract-primary-image.cjs', [], JSON.stringify(spec));

  // ---------------- Step B: intent recap ----------------
  const intentRecap = runPluginScript(
    'render-intent-recap.cjs',
    ['--active-chain', scenario.active_chain || 'testnet'],
    JSON.stringify(spec),
  );
  record('expected-intent-recap.txt', intentRecap);

  // ---------------- Step C: readiness ----------------
  const readinessRaw = runPluginScript(
    'evaluate-readiness.cjs',
    ['--gas-price', scenario.gas_price || '1umfx'],
    JSON.stringify(readinessResp),
  );
  record('expected-readiness.json', readinessRaw);

  // ---------------- Step D: humanize fees ----------------
  // For the happy path: single fee. For partial-success: two fees.
  const isPartial = scenario.kind === 'partial-success';
  const createFee = isPartial ? feeResp.create_lease_fee : feeResp.fee;
  const createHumanFee = runPluginScript(
    'humanize-fee.cjs',
    [
      '--chain-data-file',
      CHAIN_DATA_FILE,
      '--fee-json',
      JSON.stringify(createFee.amount),
    ],
    '',
  ).trim();
  let setDomainHumanFee = null;
  if (isPartial && feeResp.set_domain_fee) {
    setDomainHumanFee = runPluginScript(
      'humanize-fee.cjs',
      [
        '--chain-data-file',
        CHAIN_DATA_FILE,
        '--fee-json',
        JSON.stringify(feeResp.set_domain_fee.amount),
      ],
      '',
    ).trim();
  }

  // ---------------- Step E: deployment plan (the big byte-baseline) ----------------
  const planStdin = JSON.stringify({ summary, readiness: readinessResp });
  const planArgs = [
    '--meta-hash',
    metaResp.meta_hash_hex,
    '--image',
    spec.image || Object.values(spec.services || {})[0]?.image || '(no image)',
    '--size',
    scenario.size || 'small',
    '--tx-gas',
    createFee.gas,
    '--tx-fee',
    createHumanFee,
    '--chain-data-file',
    CHAIN_DATA_FILE,
  ];
  if (isPartial) {
    planArgs.push('--custom-domain', scenario.custom_domain);
    if (scenario.custom_domain_service) {
      planArgs.push('--custom-domain-service', scenario.custom_domain_service);
    }
    // Copilot review fix (PR #58 r3250445914): `expected-plan.txt` is
    // a renderer-LEVEL byte-baseline — `render-deployment-plan.test.ts`
    // feeds the TS renderer a REAL `setDomain: { coins, gas }` fee
    // directly (mirroring the CJS plugin's `--set-domain-tx-fee` arg
    // here). The orchestrator-LEVEL path (`deploy-app.ts:estimateFees`)
    // emits the `{ notEstimated: true }` sentinel for set-domain today
    // (tracked as ENG-185 #3 deferred). Both paths flow through the
    // same renderer with different inputs.
    //
    // Per option (c) of the team-lead's brief, the CJS invocation
    // here continues to pass `--set-domain-tx-fee` so the fixture
    // stays renderer-test-aligned. When ENG-185 #3 lands the real
    // set-domain estimate, the orchestrator's output will converge
    // with this baseline; until then the two paths diverge by design.
    planArgs.push('--set-domain-tx-gas', feeResp.set_domain_fee.gas);
    planArgs.push('--set-domain-tx-fee', setDomainHumanFee);
  }
  const plan = runPluginScript(
    'render-deployment-plan.cjs',
    planArgs,
    planStdin,
  );
  record('expected-plan.txt', plan);

  // ---------------- Step F: classify response or error ----------------
  if (isPartial) {
    const errEnvelope = readJson(join(inputDir, 'deploy-error.json'));
    const classifyArgs = scenario.custom_domain
      ? ['--expected-custom-domain', scenario.custom_domain]
      : [];
    const classifyErr = runPluginScript(
      'classify-deploy-error.cjs',
      classifyArgs,
      JSON.stringify(errEnvelope),
    );
    record('expected-classify-error.json', classifyErr);
  } else {
    const deployResp = readJson(join(inputDir, 'deploy-response.json'));
    const classifyResp = runPluginScript(
      'classify-deploy-response.cjs',
      [],
      JSON.stringify(deployResp),
    );
    record('expected-classify-response.json', classifyResp);

    // ---------------- Step G: format success ----------------
    const successArgs = ['--lease-uuid', scenario.lease_uuid];
    const success = runPluginScript(
      'format-success.cjs',
      successArgs,
      JSON.stringify({ deploy_response: deployResp }),
    );
    record('expected-success.txt', success);
    // Note: save-manifest.cjs writes to a target dir on disk; capturing
    // the would-be-written wrapper requires running it against a tmpdir
    // and reading the file back. Deferred — adds tmpdir scaffolding and
    // schema-version asserts that aren't load-bearing for parity. Listed
    // in __fixtures__/README.md as a follow-up.
  }

  // ---------------- mcp-script.json (hand-curated; sanity check shape) ----------------
  // Not generated from CJS — the script is a TS-test artifact that
  // describes which mocked MCP calls the replay harness should script.
  // We assemble it here from the canonical inputs.
  const mcpScript = isPartial
    ? buildPartialMcpScript(
        spec,
        scenario,
        readinessResp,
        feeResp,
        metaResp,
        readJson(join(inputDir, 'deploy-error.json')),
      )
    : buildHappyMcpScript(
        spec,
        scenario,
        readinessResp,
        feeResp,
        metaResp,
        readJson(join(inputDir, 'deploy-response.json')),
      );
  record('mcp-script.json', `${JSON.stringify(mcpScript, null, 2)}\n`);

  return results;
}

// Discipline V audit (Copilot review pass 3 — r3250445914/.../r3250446056):
// every `expected_args` / `response` field in the two builders below
// maps to a real call site in `packages/agent-core/src/deploy-app.ts`.
// Source-of-truth references per call (line numbers as of `33bb567`):
//
//   checkDeploymentReadiness (deploy-app.ts:155-162)
//     call: (queryClient, tenantAddress, { image, size })
//     capture: the third positional arg only — `{ image, size }`.
//     `queryClient` and `tenantAddress` are harness-supplied runtime
//     context, not spec-derived; recording them here would conflate
//     the test-boundary args with the runtime context the transcript
//     can't replay.
//
//   buildManifestPreview (deploy-app.ts:191-193 + buildManifestPreviewInput
//     at deploy-app.ts:566-588)
//     call: buildManifestPreview(buildManifestPreviewInput(spec, size))
//     buildManifestPreviewInput flattens single-service specs to
//     `{ size, image, port, env }` and stack specs to `{ size, services }`.
//     Capture the flattened input.
//
//   cosmosEstimateFee (deploy-app.ts:614-621)
//     call: cosmosEstimateFee(clientManager, 'billing', 'create-lease',
//       ['--meta-hash', metaHashHex, itemArg])
//     itemArg = `${skuUuid}:1` for single-service or non-named stack;
//     `${skuUuid}:1:${serviceName}` for named-stack. The test mock's
//     `findSkuUuid` resolves to `'sku-uuid-fixture'`; the fixture
//     reflects that.
//     Response: full `FeeEstimateResult` shape per
//     packages/core/src/types.ts —
//       `{ module, subcommand, gasEstimate, fee: { amount, gas } }`.
//     The prior fixture recorded only `feeResp.fee`, dropping
//     `module` / `subcommand` / `gasEstimate`.
//
//   fredDeployApp (deploy-app.ts:299-305 + buildFredDeployInput at
//     deploy-app.ts:681-708)
//     call: fredDeployApp(clientManager, getAuthToken,
//       getLeaseDataAuthToken, fredInput, fetchFn)
//     fredInput = buildFredDeployInput(confirmedSpec, size). For
//     single-service: `{ size, image, port, env, customDomain?,
//     serviceName? }`. For stack: `{ size, services, customDomain?,
//     serviceName? }`. Capture `fredInput` only (the auth callbacks
//     and fetchFn are harness-supplied).

/** Helper: derive the flattened buildManifestPreview input from a spec. */
function previewInputFromSpec(spec, size) {
  if (spec && typeof spec === 'object' && spec.services) {
    return { size, services: spec.services };
  }
  return {
    size,
    image: spec?.image,
    port: spec?.port,
    env: spec?.env,
  };
}

/** Helper: derive the flattened fred deployApp input from a spec. */
function fredInputFromSpec(spec, size) {
  const base = previewInputFromSpec(spec, size);
  if (spec?.customDomain) base.customDomain = spec.customDomain;
  if (spec?.serviceName) base.serviceName = spec.serviceName;
  return base;
}

/** Helper: derive the create-lease itemArg from a spec. */
function createLeaseItemArg(spec) {
  if (spec?.services && spec.serviceName) {
    return `sku-uuid-fixture:1:${spec.serviceName}`;
  }
  return 'sku-uuid-fixture:1';
}

/**
 * Wrap a `{ amount, gas }` fee envelope into the canonical
 * `FeeEstimateResult` shape with `module` / `subcommand` /
 * `gasEstimate`. `gasEstimate` is recorded at the same value as
 * `fee.gas` for fixture purposes; in production the two diverge by
 * the configured `gasMultiplier` (default 1.5 per CLAUDE.md), per
 * Copilot Fix 12 (r3250192734).
 */
function wrapFeeResult(feeEnvelope, subcommand) {
  return {
    module: 'billing',
    subcommand,
    gasEstimate: String(feeEnvelope.gas ?? ''),
    fee: feeEnvelope,
  };
}

function buildHappyMcpScript(
  spec,
  scenario,
  readinessResp,
  feeResp,
  metaResp,
  deployResp,
) {
  const size = scenario.size;
  const image = spec?.image;
  return {
    description: `Mocked MCP call/response transcript for ${scenario.id}`,
    calls: [
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'checkDeploymentReadiness',
        expected_args: { image, size },
        response: readinessResp,
      },
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'buildManifestPreview',
        expected_args: previewInputFromSpec(spec, size),
        response: metaResp,
      },
      {
        module: '@manifest-network/manifest-mcp-core',
        function: 'cosmosEstimateFee',
        expected_args: {
          // Copilot review fix (PR #58 r3249294955): module short-name
          // + positional string args, not `{ args: {} }` or proto path.
          // `'sku-uuid-fixture'` matches the test mock's `findSkuUuid`
          // (`packages/agent-core/src/deploy-app.test.ts`).
          module: 'billing',
          subcommand: 'create-lease',
          args: [
            '--meta-hash',
            metaResp.meta_hash_hex,
            createLeaseItemArg(spec),
          ],
        },
        response: wrapFeeResult(feeResp.fee, 'create-lease'),
      },
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'deployApp',
        expected_args: fredInputFromSpec(spec, size),
        response: deployResp,
      },
    ],
  };
}

function buildPartialMcpScript(
  spec,
  scenario,
  readinessResp,
  feeResp,
  metaResp,
  deployError,
) {
  const size = scenario.size;
  const image = spec?.image;
  return {
    description: `Mocked MCP call/response transcript for ${scenario.id}`,
    calls: [
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'checkDeploymentReadiness',
        expected_args: { image, size },
        response: readinessResp,
      },
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'buildManifestPreview',
        expected_args: previewInputFromSpec(spec, size),
        response: metaResp,
      },
      {
        module: '@manifest-network/manifest-mcp-core',
        function: 'cosmosEstimateFee',
        expected_args: {
          // r3249294955 fix (see buildHappyMcpScript audit comment).
          module: 'billing',
          subcommand: 'create-lease',
          args: [
            '--meta-hash',
            metaResp.meta_hash_hex,
            createLeaseItemArg(spec),
          ],
        },
        response: wrapFeeResult(feeResp.create_lease_fee, 'create-lease'),
      },
      // r3249294955 (continued): the orchestrator does NOT invoke
      // `cosmosEstimateFee` for `set-item-custom-domain` today — it
      // emits the `{ notEstimated: true, reason: 'set-domain fee
      // skipped' }` sentinel per the deferred placeholder (tracked as
      // ENG-185 scope item #3). The prior set-domain entry recorded a
      // call that never fires and would create a hazard if a future
      // replay test asserted the call happens. Removed per option (a)
      // of the team-lead's brief: fixture reflects current behavior;
      // re-add when ENG-185 #3's real set-domain estimate lands.
      {
        module: '@manifest-network/manifest-mcp-fred',
        function: 'deployApp',
        expected_args: fredInputFromSpec(spec, size),
        throws: deployError,
      },
    ],
  };
}

// --------------------- main ---------------------

function main() {
  const args = parseArgs(process.argv);
  const registry = readJson(join(FIXTURES_ROOT, 'scenarios.json'));
  if (!Array.isArray(registry.scenarios)) {
    process.stderr.write(
      `scenarios.json malformed: expected { scenarios: [...] }\n`,
    );
    process.exit(1);
  }

  const filtered = args.scenarioFilter
    ? registry.scenarios.filter((s) => s.id === args.scenarioFilter)
    : registry.scenarios;
  if (filtered.length === 0) {
    process.stderr.write(
      `no scenarios matched filter ${args.scenarioFilter || '*'}\n`,
    );
    process.exit(1);
  }

  // Copilot review fix (PR #58 r3267708678): separate `errorCount`
  // from `driftCount`. Capture errors are categorically different
  // from baseline drift — a scenario crash means the script couldn't
  // generate the artifact at all, which `--write` mode should NOT
  // silently swallow as a successful re-baseline. Prior code lumped
  // both into `driftCount` and skipped exit-1 in `--write` mode,
  // hiding scenario failures during re-baselining.
  let driftCount = 0;
  let errorCount = 0;
  let totalCount = 0;
  for (const scenario of filtered) {
    process.stdout.write(`\n=== ${scenario.id} ===\n`);
    let results;
    try {
      if (scenario.skill === 'deploy-app') {
        results = captureDeployApp(scenario, args.write);
      } else {
        process.stdout.write(
          `  (skipped — handler for skill '${scenario.skill}' not yet implemented)\n`,
        );
        continue;
      }
    } catch (err) {
      process.stderr.write(`  FAIL: ${err.message}\n`);
      // r3267708678 fix: bump errorCount, NOT driftCount. Errors
      // exit 1 regardless of mode; drift only in check mode.
      errorCount++;
      continue;
    }
    for (const r of results) {
      totalCount++;
      const tag =
        r.action === 'identical'
          ? 'OK  '
          : r.action === 'wrote'
            ? 'WROTE'
            : 'DRIFT';
      process.stdout.write(
        `  ${tag}  ${r.name}${r.detail ? `  (${r.detail})` : ''}\n`,
      );
      if (r.action === 'drift') driftCount++;
    }
  }

  process.stdout.write(
    `\nSummary: ${totalCount} artifacts checked, ${driftCount} drifted, ${errorCount} errors${args.write ? ' (--write mode; baselines re-written)' : ''}\n`,
  );
  // Exit logic (r3267708678):
  //   - errors    → always exit 1, regardless of mode (capture failure
  //                 cannot be silenced by --write).
  //   - drift     → exit 1 only in check mode; `--write` succeeds by
  //                 definition (baselines re-written).
  //   - otherwise → exit 0.
  process.exit(errorCount > 0 || (driftCount > 0 && !args.write) ? 1 : 0);
}

main();
