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

// Discover workspace packages dynamically
const pkgDir = resolve(root, "packages");
let entries;
try {
  entries = readdirSync(pkgDir, { withFileTypes: true });
} catch (err) {
  console.error(`Cannot read packages directory: ${err.message}`);
  console.error(`Expected packages directory at: ${pkgDir}`);
  process.exit(1);
}
const workspacePkgJsons = entries
  .filter((d) => d.isDirectory())
  .map((d) => `packages/${d.name}/package.json`);

const packageJsonPaths = ["package.json", ...workspacePkgJsons];

// Phase 1: Read and validate all package.json files
const packages = [];
for (const rel of packageJsonPaths) {
  const filepath = resolve(root, rel);
  let raw;
  try {
    raw = readFileSync(filepath, "utf-8");
  } catch (err) {
    console.error(`Failed to read ${rel}: ${err.message}`);
    process.exit(1);
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${rel}: ${err.message}`);
    process.exit(1);
  }
  packages.push({ rel, filepath, pkg });
}

// Collect internal package names from workspace packages (skip root)
const internalPackages = new Set(
  packages.filter((p) => p.rel !== "package.json").map((p) => p.pkg.name),
);

const caretVersion = `^${version}`;

// Phase 2: Update versions and internal dependency ranges, then write
const written = [];
for (const { rel, filepath, pkg } of packages) {
  pkg.version = version;
  for (const dep of internalPackages) {
    if (pkg.dependencies?.[dep]) pkg.dependencies[dep] = caretVersion;
    if (pkg.devDependencies?.[dep]) pkg.devDependencies[dep] = caretVersion;
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
  console.error("  npm install --package-lock-only");
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
