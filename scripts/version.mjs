#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Only strict MAJOR.MINOR.PATCH; pre-release suffixes intentionally rejected
const version = process.argv[2];
if (
  !version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  console.error("Usage: node scripts/version.mjs <version>");
  console.error("Version must be MAJOR.MINOR.PATCH (e.g., 0.2.0)");
  process.exit(1);
}

// Discover workspace members dynamically: packages/* (required) + examples/* (optional).
// Both get their version bumped and their internal dep ranges normalized; only packages/*
// names become normalize targets (see internalPackages below).
function discoverPkgJsons(dirName, { required }) {
  const dir = resolve(root, dirName);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (required) {
      console.error(`Cannot read ${dirName} directory: ${err.message}`);
      console.error(`Expected ${dirName} directory at: ${dir}`);
      process.exit(1);
    }
    return []; // optional dir absent — nothing to normalize
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => `${dirName}/${d.name}/package.json`);
}

const packageJsonPaths = [
  "package.json",
  ...discoverPkgJsons("packages", { required: true }),
  ...discoverPkgJsons("examples", { required: false }),
];

// Phase 1: Read and validate all package.json files
const packages = [];
for (const rel of packageJsonPaths) {
  const filepath = resolve(root, rel);
  try {
    const raw = readFileSync(filepath, "utf-8");
    const pkg = JSON.parse(raw);
    packages.push({ rel, filepath, pkg });
  } catch (err) {
    console.error(`Failed to load ${rel}: ${err.message}`);
    process.exit(1);
  }
}

// Validate every non-root member has a name.
const workspacePackages = packages.filter((p) => p.rel !== "package.json");
for (const p of workspacePackages) {
  if (!p.pkg.name) {
    console.error(`${p.rel} is missing a "name" field`);
    process.exit(1);
  }
}
// Internal packages = the names whose ranges get normalized wherever they appear. examples/*
// are private consumers (bumped + their internal ranges normalized) but never a normalize
// target, so build the set from packages/ only.
const internalPackages = new Set(
  packages
    .filter((p) => p.rel.startsWith("packages/"))
    .map((p) => p.pkg.name),
);

const exactVersion = version; // internal siblings pinned EXACT (lockstep supply-chain determinism)
const peerVersion = `^${version}`; // internal peers stay caret, tracked to the release minor

// Phase 2: Update versions and internal dependency ranges, then write
const written = [];
for (const { rel, filepath, pkg } of packages) {
  pkg.version = version;
  for (const dep of internalPackages) {
    if (pkg.dependencies?.[dep]) pkg.dependencies[dep] = exactVersion;
    if (pkg.devDependencies?.[dep]) pkg.devDependencies[dep] = exactVersion;
    if (pkg.peerDependencies?.[dep]) pkg.peerDependencies[dep] = peerVersion;
  }
  try {
    writeFileSync(filepath, JSON.stringify(pkg, null, 2) + "\n");
  } catch (err) {
    console.error(`\nFailed to write ${rel}: ${err.message}`);
    if (written.length > 0) {
      console.error(`Already updated: ${written.join(", ")}`);
      console.error("To revert: git checkout -- package.json packages/*/package.json");
    }
    process.exit(1);
  }
  written.push(rel);
  console.log(`  updated ${rel}`);
}

// Keep packages/core/src/version.ts in sync so VERSION constant matches package.json
const versionTsPath = resolve(root, "packages/core/src/version.ts");
try {
  writeFileSync(versionTsPath, `export const VERSION = '${version}';\n`);
  console.log("  updated packages/core/src/version.ts");
} catch (err) {
  console.error(`\nFailed to write packages/core/src/version.ts: ${err.message}`);
  process.exit(1);
}

console.log("\nSyncing package-lock.json...");
try {
  execSync("npm install --package-lock-only --ignore-scripts", { cwd: root, stdio: "inherit" });
} catch (err) {
  console.error("\nFailed to sync package-lock.json.");
  if (err.status != null) {
    console.error(`Exit code: ${err.status}`);
  }
  console.error(
    `All package.json files were updated to ${version} but the lockfile is stale.`,
  );
  console.error("Resolve the issue above, then run:");
  console.error("  npm install --package-lock-only --ignore-scripts");
  process.exit(1);
}

console.log(`
Version updated to ${version}

Next steps:
  git add -A
  git commit -m "chore: release v${version}"
  git tag v${version}
  git push origin main --tags
`);
