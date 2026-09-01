#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredDeclarations = [
  'packages/core/dist/index.d.ts',
  'packages/fred/dist/index.d.ts',
  'packages/sdk/dist/index.d.ts',
  'examples/sdk-acceptance/dist/index.d.ts',
];

const findMissingDeclarations = () =>
  requiredDeclarations.filter((path) => !existsSync(resolve(root, path)));

const missingDeclarations = findMissingDeclarations();

if (missingDeclarations.length > 0) {
  console.log(
    `Building workspace declarations required by the e2e type-check (missing: ${missingDeclarations.join(', ')})`,
  );
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCommand, ['run', 'build'], { cwd: root, stdio: 'inherit' });

  const stillMissing = findMissingDeclarations();
  if (stillMissing.length > 0) {
    throw new Error(
      `Workspace build did not create: ${stillMissing.join(', ')}`,
    );
  }
}
