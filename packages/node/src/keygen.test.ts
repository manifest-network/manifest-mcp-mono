import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeKeyfile } from './keygen.js';

// A valid 24-word test mnemonic (DO NOT use in production)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('writeKeyfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keygen-perms-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('forces 0600 when overwriting a pre-existing loosely-permissioned keyfile', async () => {
    const keyfilePath = join(dir, 'key.json');

    // Pre-create the target with world/group-readable perms. writeFileSync's
    // `mode` option is honored ONLY on file creation, so an existing path keeps
    // these loose perms unless we explicitly chmod after writing.
    writeFileSync(keyfilePath, 'stale');
    chmodSync(keyfilePath, 0o644);
    expect(statSync(keyfilePath).mode & 0o777).toBe(0o644);

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    await writeKeyfile(wallet, keyfilePath, 'test-password-123');

    expect(statSync(keyfilePath).mode & 0o777).toBe(0o600);
  });
});
