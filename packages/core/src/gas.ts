/**
 * Gas-fee computation primitives, exposed on the universal
 * `@manifest-network/manifest-mcp-core/gas` subpath (off the package barrel).
 *
 * `buildGasFee` is core-internal to the `cosmosTx`/`executeTx` broadcast paths;
 * it is surfaced here — deliberately NOT on the barrel — so a first-party sibling
 * package that broadcasts on its own (the cosmwasm converter) can enforce the same
 * absolute gas-limit ceiling (`COSMOS_MAX_GAS`, ENG-556) rather than passing `'auto'`.
 * Browser-safe (`@cosmjs/*` + core types only, no node builtins), so a plain
 * `import` condition like the other universal subpaths (`/faucet`, `/ssrf`).
 */
export { DEFAULT_GAS_MULTIPLIER, DEFAULT_MAX_GAS } from './config.js';
export { buildGasFee } from './transactions/utils.js';
