import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { loadKeyfileConfig } from './config.js';
import { promptHidden } from './hidden-input.js';

function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive terminal required for key management commands. Cannot prompt for input in non-interactive mode.',
    );
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      if (!answered) {
        reject(new Error('Input stream closed before response was received.'));
      }
    });
  });
}

/**
 * Read a secret without echoing it.
 *
 * The chunk handling that makes this correct lives in `hidden-input.ts` and is
 * unit-tested there. It used to be an inline listener that treated each stdin
 * `'data'` event as one keystroke, which silently folded a pasted password's
 * trailing CR/LF into the key material (ENG-668).
 */
function promptPassword(question: string): Promise<string> {
  return promptHidden(question);
}

/**
 * The mnemonic is the only recoverable form of the wallet: the keyfile is
 * useless without its password, and nothing else on the machine holds the seed.
 * Print it the way every Cosmos CLI does, so the user is told to write it down
 * at the one moment they can (ENG-668 Q-4).
 */
function displayMnemonic(mnemonic: string): void {
  const rule = '='.repeat(79);
  console.error('');
  console.error(rule);
  console.error('  RECOVERY PHRASE - WRITE THIS DOWN NOW');
  console.error(rule);
  console.error('');
  console.error(`  ${mnemonic}`);
  console.error('');
  console.error(
    '  These words are the ONLY way to recover this wallet if the keyfile is',
  );
  console.error(
    '  lost or its password is forgotten. Store them offline. Anyone who reads',
  );
  console.error(
    '  them controls the funds at this address. They are not stored anywhere in',
  );
  console.error(
    '  plaintext -- only inside the password-encrypted keyfile. To print them',
  );
  console.error('  again you will need that keyfile and its password:');
  console.error('');
  console.error('      <cli> export      (e.g. manifest-mcp-chain export)');
  console.error(rule);
  console.error('');
}

/**
 * Recover the mnemonic from an existing encrypted keyfile, behind its password.
 *
 * Exists because every keyfile generated before ENG-668 was written without its
 * owner ever seeing the mnemonic; for those wallets this is the only route to a
 * backup. Exported for unit testing.
 */
export async function exportMnemonic(
  keyfilePath: string,
  password: string,
): Promise<string> {
  let serialized: string;
  try {
    serialized = readFileSync(keyfilePath, 'utf8');
  } catch (err: unknown) {
    throw new Error(
      `Failed to read keyfile at ${keyfilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let wallet: DirectSecp256k1HdWallet;
  try {
    wallet = await DirectSecp256k1HdWallet.deserialize(serialized, password);
  } catch {
    // Deliberately does not forward the underlying message: it can echo
    // password-derived detail, and the actionable cause is always the same.
    throw new Error(
      `Failed to decrypt keyfile at ${keyfilePath}. Verify the password is correct.`,
    );
  }

  return wallet.mnemonic;
}

// Exported for unit testing of the on-disk permission enforcement.
export async function writeKeyfile(
  wallet: DirectSecp256k1HdWallet,
  keyfilePath: string,
  password: string,
): Promise<void> {
  let serialized: string;
  try {
    serialized = await wallet.serialize(password);
  } catch (err: unknown) {
    throw new Error(
      `Failed to encrypt wallet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    mkdirSync(dirname(keyfilePath), { recursive: true, mode: 0o700 });
    writeFileSync(keyfilePath, serialized, { mode: 0o600 });
    // writeFileSync's `mode` applies ONLY when the file is newly created (flag
    // 'w' = O_CREAT|O_WRONLY|O_TRUNC); for an already-existing path the OS
    // ignores it and the file keeps its current (possibly loose, e.g. 0644)
    // permissions. chmodSync unconditionally enforces 0600 so re-running
    // keygen/import over a pre-existing keyfile can never leave it
    // group/world-readable.
    chmodSync(keyfilePath, 0o600);
  } catch (err: unknown) {
    throw new Error(
      `Failed to write keyfile to ${keyfilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function confirmOverwrite(keyfilePath: string): Promise<void> {
  if (existsSync(keyfilePath)) {
    const answer = await prompt(
      `Keyfile already exists at ${keyfilePath}. Overwrite? (yes/no): `,
    );
    if (answer.toLowerCase() !== 'yes') {
      console.error('Aborted. Existing keyfile was not modified.');
      process.exit(0);
    }
  }
}

export async function runKeygen(): Promise<void> {
  const config = loadKeyfileConfig();
  const prefix = config.addressPrefix;
  const keyfilePath = config.keyfilePath;

  await confirmOverwrite(keyfilePath);

  const password = await promptPassword(
    'Enter password for keyfile encryption: ',
  );
  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }
  const confirmPassword = await promptPassword('Confirm password: ');
  if (password !== confirmPassword) {
    console.error('Error: passwords do not match.');
    process.exit(1);
  }

  let wallet: DirectSecp256k1HdWallet;
  try {
    wallet = await DirectSecp256k1HdWallet.generate(24, { prefix });
  } catch (err: unknown) {
    console.error(
      `Failed to generate wallet: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  await writeKeyfile(wallet, keyfilePath, password);
  console.error(`Keyfile written to ${keyfilePath}`);

  try {
    const accounts = await wallet.getAccounts();
    if (accounts.length > 0) {
      console.error(`Address: ${accounts[0].address}`);
    }
  } catch (err) {
    console.error(
      `Note: could not derive address for display (${err instanceof Error ? err.message : String(err)}), but the keyfile was written successfully.`,
    );
  }

  // Last, so it is what remains on screen. Before ENG-668 this wallet's seed
  // existed in exactly one place -- an encrypted file the user could lock
  // themselves out of -- and was never shown.
  displayMnemonic(wallet.mnemonic);
}

/**
 * `<cli> export` — print the mnemonic for the configured keyfile.
 *
 * The password gate is the keyfile's own: a reader who cannot decrypt it learns
 * nothing. Output goes to stderr, alongside every other prompt on this path, so
 * it is not captured by a naive `>` redirect into a file.
 */
export async function runExport(): Promise<void> {
  const config = loadKeyfileConfig();
  const keyfilePath = config.keyfilePath;

  if (!existsSync(keyfilePath)) {
    console.error(
      `No keyfile found at ${keyfilePath}. Nothing to export.\n` +
        'Generate one with `keygen`, or point MANIFEST_KEY_FILE at an existing keyfile.',
    );
    process.exit(1);
  }

  // MANIFEST_KEY_PASSWORD wins when set, and is used verbatim. This is the
  // whole recovery route for a keyfile encrypted under a pre-ENG-668 password
  // that absorbed a paste's trailing CR/LF: those bytes cannot be typed at the
  // prompt, because the prompt treats CR and LF as submission. Without an
  // env-var path, the affected wallets — the ones this command exists for —
  // would be exactly the ones it could not open.
  const envPassword = config.keyPassword;
  let password: string;
  if (envPassword) {
    console.error('Using the password from MANIFEST_KEY_PASSWORD.');
    password = envPassword;
  } else {
    password = await promptPassword('Enter keyfile password: ');
  }
  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }

  let mnemonic: string;
  try {
    mnemonic = await exportMnemonic(keyfilePath, password);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  displayMnemonic(mnemonic);
}

export async function runImport(): Promise<void> {
  const config = loadKeyfileConfig();
  const prefix = config.addressPrefix;
  const keyfilePath = config.keyfilePath;

  await confirmOverwrite(keyfilePath);

  const mnemonic = await promptPassword('Enter mnemonic (hidden): ');
  if (!mnemonic.trim()) {
    console.error('Error: mnemonic cannot be empty.');
    process.exit(1);
  }

  const password = await promptPassword(
    'Enter password for keyfile encryption: ',
  );
  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }
  const confirmPassword = await promptPassword('Confirm password: ');
  if (password !== confirmPassword) {
    console.error('Error: passwords do not match.');
    process.exit(1);
  }

  let wallet: DirectSecp256k1HdWallet;
  try {
    wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), {
      prefix,
    });
  } catch (err: unknown) {
    console.error(
      `Invalid mnemonic: ${err instanceof Error ? err.message : String(err)}\n` +
        'Please verify your mnemonic phrase has the correct number of words (12, 15, 18, 21, or 24) ' +
        'and all words are valid BIP-39 words.',
    );
    process.exit(1);
  }

  await writeKeyfile(wallet, keyfilePath, password);
  console.error(`Keyfile written to ${keyfilePath}`);

  try {
    const accounts = await wallet.getAccounts();
    if (accounts.length > 0) {
      console.error(`Address: ${accounts[0].address}`);
    }
  } catch (err) {
    console.error(
      `Note: could not derive address for display (${err instanceof Error ? err.message : String(err)}), but the keyfile was written successfully.`,
    );
  }
}
