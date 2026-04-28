// Patches for CosmJS faucet to support Manifest factory denoms
// See: https://github.com/liftedinit/manifest-deploy/tree/main/roles/faucet

const fs = require("fs");

// Patch 1: Relax denom regex for factory denoms
// Original only allows 2-20 lowercase alpha chars, which rejects
// factory/manifest1.../upwr style denoms.
let tokens = fs.readFileSync("packages/faucet/src/tokens.ts", "utf8");
const oldRegex = "const parseBankTokenPattern = /^([a-zA-Z]{2,20})$/;";
const newRegex =
  "const parseBankTokenPattern = /^([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;";
if (!tokens.includes(oldRegex)) {
  console.error("FATAL: tokens.ts patch target not found.");
  console.error("These patches are designed for CosmJS v0.38.0. If you changed COSMJS_VERSION, the patches may need updating.");
  process.exit(1);
}
tokens = tokens.replace(oldRegex, newRegex);
fs.writeFileSync("packages/faucet/src/tokens.ts", tokens);
console.log("Patched tokens.ts: relaxed denom regex");

// Patch 2: Sanitize denom for env-var lookup
// Factory denoms contain slashes and dots that are invalid in env-var names.
// Replace non-alphanumeric chars with underscores before lookup.
let tokenMgr = fs.readFileSync(
  "packages/faucet/src/tokenmanager.ts",
  "utf8",
);
const oldEnvLookup =
  "const amountFromEnv = process.env[`FAUCET_CREDIT_AMOUNT_${denom.toUpperCase()}`];";
const newEnvLookup = [
  'const sanitized = denom.toUpperCase().replace(/[^A-Z0-9]/g, "_");',
  '      const amountFromEnv = process.env[`FAUCET_CREDIT_AMOUNT_${sanitized}`];',
].join("\n");
if (!tokenMgr.includes(oldEnvLookup)) {
  console.error("FATAL: tokenmanager.ts patch target not found.");
  console.error("These patches are designed for CosmJS v0.38.0. If you changed COSMJS_VERSION, the patches may need updating.");
  process.exit(1);
}
tokenMgr = tokenMgr.replace(oldEnvLookup, newEnvLookup);
fs.writeFileSync("packages/faucet/src/tokenmanager.ts", tokenMgr);
console.log("Patched tokenmanager.ts: sanitize denom for env-var lookup");

// Patch 3 & 4: Track cooldown per address+denom instead of per address
// Without this, requesting MFX triggers cooldown for PWR too.
let webserver = fs.readFileSync(
  "packages/faucet/src/api/webserver.ts",
  "utf8",
);
const oldGet = "this.addressCounter.get(address)";
const newGet = 'this.addressCounter.get(address + ":" + denom)';
const oldSet = "this.addressCounter.set(address, new Date())";
const newSet = 'this.addressCounter.set(address + ":" + denom, new Date())';
if (!webserver.includes(oldGet) || !webserver.includes(oldSet)) {
  console.error("FATAL: webserver.ts patch targets not found.");
  console.error("These patches are designed for CosmJS v0.38.0. If you changed COSMJS_VERSION, the patches may need updating.");
  process.exit(1);
}
webserver = webserver.replaceAll(oldGet, newGet);
webserver = webserver.replaceAll(oldSet, newSet);
fs.writeFileSync("packages/faucet/src/api/webserver.ts", webserver);
console.log("Patched webserver.ts: cooldown per address+denom");

console.log("All patches applied successfully");
