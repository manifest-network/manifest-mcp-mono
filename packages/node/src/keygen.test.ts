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
import { exportMnemonic, writeKeyfile } from './keygen.js';

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

describe('exportMnemonic (ENG-668 Q-4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keygen-export-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the mnemonic out of a keyfile written by writeKeyfile', async () => {
    // The recovery route for every wallet generated before this change: keygen
    // showed only the address, so the keyfile was the sole copy of the seed.
    const keyfilePath = join(dir, 'key.json');
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    await writeKeyfile(wallet, keyfilePath, 'test-password-123');

    await expect(
      exportMnemonic(keyfilePath, 'test-password-123'),
    ).resolves.toBe(TEST_MNEMONIC);
  });

  it('recovers a wallet whose keyfile was encrypted under a CRLF-corrupted password', async () => {
    // Pre-fix keygen could encrypt under `pw\r\n` while the user believed the
    // password was `pw`. Such a keyfile is not lost -- it just needs the exact
    // bytes -- and this is the path that gets the mnemonic back out of it.
    const keyfilePath = join(dir, 'key.json');
    const corrupted = `test-password-123${String.fromCharCode(13)}${String.fromCharCode(10)}`;
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    await writeKeyfile(wallet, keyfilePath, corrupted);

    await expect(
      exportMnemonic(keyfilePath, 'test-password-123'),
    ).rejects.toThrow(/Verify the password is correct/);
    await expect(exportMnemonic(keyfilePath, corrupted)).resolves.toBe(
      TEST_MNEMONIC,
    );
  });

  it('rejects a wrong password without leaking the underlying crypto error', async () => {
    const keyfilePath = join(dir, 'key.json');
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    await writeKeyfile(wallet, keyfilePath, 'test-password-123');

    await expect(exportMnemonic(keyfilePath, 'wrong-password')).rejects.toThrow(
      `Failed to decrypt keyfile at ${keyfilePath}. Verify the password is correct.`,
    );
  });

  it('reports a missing keyfile distinctly from a bad password', async () => {
    const missing = join(dir, 'nope.json');
    await expect(exportMnemonic(missing, 'whatever')).rejects.toThrow(
      /Failed to read keyfile/,
    );
  });
});
