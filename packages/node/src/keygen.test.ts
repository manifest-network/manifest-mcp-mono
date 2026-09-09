import fs, {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forces 0600 when overwriting a pre-existing loosely-permissioned keyfile', async () => {
    const keyfilePath = join(dir, 'key.json');

    // A replacement must explicitly request 0600 instead of inheriting the
    // old file's looser permissions through the atomic writer's defaults.
    writeFileSync(keyfilePath, 'stale');
    chmodSync(keyfilePath, 0o644);
    expect(statSync(keyfilePath).mode & 0o777).toBe(0o644);

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    await writeKeyfile(wallet, keyfilePath, 'test-password-123');

    expect(statSync(keyfilePath).mode & 0o777).toBe(0o600);
  });

  it('keeps the previous file until private ciphertext is ready to rename', async () => {
    const keyfilePath = join(dir, 'key.json');
    const previous = 'previous encrypted wallet';
    const ciphertext = 'replacement encrypted wallet';
    writeFileSync(keyfilePath, previous);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC);
    vi.spyOn(wallet, 'serialize').mockResolvedValue(ciphertext);
    const rename = fs.renameSync.bind(fs);
    const observedRename = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce((temporary, target) => {
        expect(readFileSync(keyfilePath, 'utf8')).toBe(previous);
        expect(statSync(temporary).mode & 0o777).toBe(0o600);
        expect(readFileSync(temporary, 'utf8')).toBe(ciphertext);
        expect(readFileSync(temporary, 'utf8')).not.toContain(TEST_MNEMONIC);
        rename(temporary, target);
      });
    await writeKeyfile(wallet, keyfilePath, 'test-password');
    expect(observedRename).toHaveBeenCalledOnce();
    expect(readFileSync(keyfilePath, 'utf8')).toBe(ciphertext);
    expect(readdirSync(dir)).toEqual(['key.json']);
  });

  it.each(['write', 'fsync', 'rename'] as const)(
    '%s failure preserves the previous keyfile and removes temporary ciphertext',
    async (operation) => {
      const keyfilePath = join(dir, 'key.json');
      const previous = 'previous encrypted wallet';
      writeFileSync(keyfilePath, previous, { mode: 0o600 });
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC);
      vi.spyOn(wallet, 'serialize').mockResolvedValue(
        'replacement encrypted wallet',
      );
      const failure = Object.assign(new Error('injected persistence failure'), {
        code: 'EIO',
      });
      if (operation === 'rename') {
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
          throw failure;
        });
      } else if (operation === 'fsync') {
        vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
          throw failure;
        });
      }
      await expect(
        writeKeyfile(wallet, keyfilePath, 'test-password'),
      ).rejects.toThrow('Failed to write keyfile');
      expect(readFileSync(keyfilePath, 'utf8')).toBe(previous);
      expect(statSync(keyfilePath).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['key.json']);
    },
  );

  it.each([false, true])(
    'handles a short write followed by failure=%s without publishing partial ciphertext',
    async (fails) => {
      const keyfilePath = join(dir, 'key.json');
      const previous = 'previous encrypted wallet';
      const ciphertext = 'complete replacement encrypted wallet';
      writeFileSync(keyfilePath, previous, { mode: 0o600 });
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC);
      vi.spyOn(wallet, 'serialize').mockResolvedValue(ciphertext);
      const write = fs.writeSync.bind(fs);
      const writes = vi
        .spyOn(fs, 'writeSync')
        .mockImplementationOnce((descriptor, data) => {
          if (typeof data === 'string')
            throw new Error(
              'Expected writeFileSync to pass its encoded buffer',
            );
          return write(descriptor, data, 0, 2, null);
        });
      if (fails) {
        writes.mockImplementationOnce(() => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        });
        await expect(
          writeKeyfile(wallet, keyfilePath, 'test-password'),
        ).rejects.toThrow('Failed to write keyfile');
      } else {
        await writeKeyfile(wallet, keyfilePath, 'test-password');
      }
      expect(writes).toHaveBeenCalledTimes(2);
      expect(readFileSync(keyfilePath, 'utf8')).toBe(
        fails ? previous : ciphertext,
      );
      expect(readdirSync(dir)).toEqual(['key.json']);
    },
  );

  it('preserves both failures when temporary ciphertext cleanup also fails', async () => {
    const keyfilePath = join(dir, 'key.json');
    const previous = 'previous encrypted wallet';
    const ciphertext = 'replacement encrypted wallet';
    writeFileSync(keyfilePath, previous, { mode: 0o600 });
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC);
    vi.spyOn(wallet, 'serialize').mockResolvedValue(ciphertext);
    const persistenceError = Object.assign(new Error('fsync failed'), {
      code: 'EIO',
    });
    const cleanupError = Object.assign(new Error('unlink failed'), {
      code: 'EACCES',
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw persistenceError;
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw cleanupError;
    });

    const result = await writeKeyfile(
      wallet,
      keyfilePath,
      'test-password',
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error))
      throw new Error('Expected persistence error');
    expect(result.message).toContain('Failed to write keyfile');
    expect(result.message).toContain('fsync failed');
    expect(result.message).toContain('Could not remove temporary ciphertext');
    expect(result.message).toContain('unlink failed');
    expect(result.cause).toBeInstanceOf(AggregateError);
    if (!(result.cause instanceof AggregateError))
      throw new Error('Expected aggregate persistence and cleanup causes');
    expect(result.cause.errors).toEqual([persistenceError, cleanupError]);
    expect(readFileSync(keyfilePath, 'utf8')).toBe(previous);
    const temporary = readdirSync(dir).find((name) => name !== 'key.json');
    expect(temporary).toBeDefined();
    if (!temporary) throw new Error('Expected retained temporary ciphertext');
    expect(result.message).toContain(join(dir, temporary));
    expect(readFileSync(join(dir, temporary), 'utf8')).toBe(ciphertext);
    expect(statSync(join(dir, temporary)).mode & 0o777).toBe(0o600);
  });

  it('does not touch the existing keyfile if encryption fails', async () => {
    const keyfilePath = join(dir, 'key.json');
    writeFileSync(keyfilePath, 'previous encrypted wallet', { mode: 0o600 });
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC);
    vi.spyOn(wallet, 'serialize').mockRejectedValue(
      new Error('encryption failed'),
    );
    await expect(
      writeKeyfile(wallet, keyfilePath, 'test-password'),
    ).rejects.toThrow('Failed to encrypt wallet');
    expect(readFileSync(keyfilePath, 'utf8')).toBe('previous encrypted wallet');
    expect(readdirSync(dir)).toEqual(['key.json']);
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
