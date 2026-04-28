import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Wallet bootstrap and key-management CLI coverage.
 *
 * The MCPTestClient harness has so far only exercised the COSMOS_MNEMONIC
 * branch of `bootstrap.ts:resolveWallet`. This file pins the other two
 * branches (encrypted keyfile, plaintext keyfile) and the failure modes
 * around them, plus the user-facing behavior of the `keygen` and `import`
 * subcommands when invoked outside a TTY.
 *
 * Notes:
 *   - `keygen` and `import` require a real TTY (see packages/node/src/
 *     keygen.ts:7-11 — promptPassword refuses non-interactive input).
 *     We test the surfaced error rather than wiring up a pty, so the
 *     CLI's non-interactive failure mode stays user-visible.
 *   - The encrypted-keyfile success path uses the same library function
 *     (`DirectSecp256k1HdWallet.serialize`) that `runImport` uses
 *     internally, so the file format under test is identical.
 *   - This file does not need a running chain; the tests only call
 *     `get_account_info` (local-only, no RPC traffic) and check exit
 *     codes from CLI invocations.
 */

// Test mnemonic — 24 words, valid BIP-39, derives manifest1 addresses.
// Reused from MCPTestClient's DEFAULT_MNEMONIC; address is ADDR2 from
// e2e/.env. Asserting the derived address proves the bootstrap loaded
// the right key.
const TEST_MNEMONIC =
  'wealth flavor believe regret funny network recall kiss grape useless pepper cram hint member few certain unveil rather brick bargain curious require crowd raise';
const EXPECTED_ADDRESS = 'manifest1efd63aw40lxf3n4mhf7dzhjkr453axurm6rp3z';

const KEYFILE_PASSWORD = 'e2e-test-password-12345';
const CHAIN_ENTRY = 'packages/node/dist/chain.js';

describe('Wallet bootstrap (keyfile)', () => {
  let tmpDir: string;
  let plaintextPath: string;
  let encryptedPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wallet-e2e-'));

    // Plaintext keyfile: { mnemonic: "..." } — KeyfileWalletProvider
    // dispatches by presence of `obj.type` (encrypted) vs `obj.mnemonic`
    // (plaintext) at packages/node/src/keyfileWallet.ts:~120.
    plaintextPath = join(tmpDir, 'plaintext.json');
    writeFileSync(
      plaintextPath,
      JSON.stringify({ mnemonic: TEST_MNEMONIC }),
      { mode: 0o600 },
    );

    // Encrypted keyfile: same format as `runKeygen`/`runImport` writes,
    // because we use the same serialize() call under the hood.
    encryptedPath = join(tmpDir, 'encrypted.json');
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    const serialized = await wallet.serialize(KEYFILE_PASSWORD);
    writeFileSync(encryptedPath, serialized, { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Plaintext keyfile', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({
        serverEntry: CHAIN_ENTRY,
        keyFile: plaintextPath,
        disableMnemonic: true,
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it('boots from a {mnemonic: "..."} keyfile and derives the right address', async () => {
      const result = await client.callTool<{ address: string }>(
        'get_account_info',
      );
      expect(result.address).toBe(EXPECTED_ADDRESS);
    });

    it('preserves mode 0600 on the test fixture (sanity)', () => {
      const mode = statSync(plaintextPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('Encrypted keyfile (correct password)', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({
        serverEntry: CHAIN_ENTRY,
        keyFile: encryptedPath,
        keyPassword: KEYFILE_PASSWORD,
        disableMnemonic: true,
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it('boots from an encrypted keyfile with the correct password', async () => {
      const result = await client.callTool<{ address: string }>(
        'get_account_info',
      );
      expect(result.address).toBe(EXPECTED_ADDRESS);
    });

    it('encrypted keyfile contents have the cosmjs envelope shape', () => {
      const raw = readFileSync(encryptedPath, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      // CosmJS encrypted wallets surface `type`, `kdf`, `encryption`, `data`.
      expect(obj.type).toBeDefined();
      expect(obj.data).toBeDefined();
    });
  });

  describe('Encrypted keyfile failure modes', () => {
    it('fails to start without MANIFEST_KEY_PASSWORD', async () => {
      const client = new MCPTestClient();
      // Server exits early; the MCP transport never gets a hello, so
      // connect() rejects. Exact error class depends on the SDK; we
      // only assert that it threw.
      let thrown: unknown;
      try {
        await client.connect({
          serverEntry: CHAIN_ENTRY,
          keyFile: encryptedPath,
          // no keyPassword
          disableMnemonic: true,
        });
      } catch (err) {
        thrown = err;
      }
      // Defensive close — connect() may have left a stray transport.
      try {
        await client.close();
      } catch {
        // ignore
      }
      expect(thrown).toBeDefined();
    });

    it('fails to start with a wrong MANIFEST_KEY_PASSWORD', async () => {
      const client = new MCPTestClient();
      let thrown: unknown;
      try {
        await client.connect({
          serverEntry: CHAIN_ENTRY,
          keyFile: encryptedPath,
          keyPassword: 'definitely-not-the-right-password',
          disableMnemonic: true,
        });
      } catch (err) {
        thrown = err;
      }
      try {
        await client.close();
      } catch {
        // ignore
      }
      expect(thrown).toBeDefined();
    });
  });
});

describe('keygen / import subcommands (non-interactive)', () => {
  // The CLI deliberately rejects non-TTY input (packages/node/src/keygen.ts:9).
  // We pin that user-visible behavior here so a regression that silently
  // accepted piped/empty input would surface.
  const cliPath = resolve(process.cwd(), CHAIN_ENTRY);

  function runSubcommand(
    subcommand: string,
  ): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn('node', [cliPath, subcommand], {
        env: {
          ...process.env,
          MANIFEST_KEY_FILE: '/dev/null/nonexistent',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', rejectRun);
      child.on('close', (code) => {
        resolveRun({ code, stderr });
      });
      // Close stdin immediately so the prompt fails fast rather than
      // hanging the test on `await prompt()`.
      child.stdin.end();
    });
  }

  it('keygen exits non-zero with the documented "interactive terminal required" error', async () => {
    const { code, stderr } = await runSubcommand('keygen');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Interactive terminal required/i);
  });

  it('import exits non-zero with the documented "interactive terminal required" error', async () => {
    const { code, stderr } = await runSubcommand('import');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Interactive terminal required/i);
  });

  it('an unknown subcommand exits non-zero with usage text', async () => {
    const { code, stderr } = await runSubcommand('not-a-real-subcommand');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Unknown subcommand/i);
    expect(stderr).toMatch(/keygen/);
    expect(stderr).toMatch(/import/);
  });
});
