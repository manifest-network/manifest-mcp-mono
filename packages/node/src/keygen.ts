import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { loadKeyfileConfig } from './config.js';

function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive terminal required for key management commands. Cannot prompt for input in non-interactive mode.'
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

function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive terminal required for key management commands. Cannot prompt for input in non-interactive mode.'
    );
  }
  return new Promise((resolve, reject) => {
    let password = '';
    process.stderr.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      process.stderr.write('\n');
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`stdin error during password prompt: ${err.message}`));
    };

    const onData = (ch: string): void => {
      if (ch === '\r' || ch === '\n') {
        cleanup();
        resolve(password);
      } else if (ch === '\u0004') {
        // Ctrl+D (EOF) — reject instead of resolving with partial input
        cleanup();
        reject(new Error('Input stream closed before password was entered.'));
      } else if (ch === '\u0003') {
        cleanup();
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        if (password.length > 0) {
          password = [...password].slice(0, -1).join('');
        }
      } else if (ch >= ' ') {
        password += ch;
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
  });
}

async function writeKeyfile(wallet: DirectSecp256k1HdWallet, keyfilePath: string, password: string): Promise<void> {
  let serialized: string;
  try {
    serialized = await wallet.serialize(password);
  } catch (err: unknown) {
    throw new Error(
      `Failed to encrypt wallet: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    mkdirSync(dirname(keyfilePath), { recursive: true, mode: 0o700 });
    writeFileSync(keyfilePath, serialized, { mode: 0o600 });
  } catch (err: unknown) {
    throw new Error(
      `Failed to write keyfile to ${keyfilePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function confirmOverwrite(keyfilePath: string): Promise<void> {
  if (existsSync(keyfilePath)) {
    const answer = await prompt(`Keyfile already exists at ${keyfilePath}. Overwrite? (yes/no): `);
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

  const password = await promptPassword('Enter password for keyfile encryption: ');
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
    console.error(`Failed to generate wallet: ${err instanceof Error ? err.message : String(err)}`);
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
    console.error(`Note: could not derive address for display (${err instanceof Error ? err.message : String(err)}), but the keyfile was written successfully.`);
  }
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

  const password = await promptPassword('Enter password for keyfile encryption: ');
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
    wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix });
  } catch (err: unknown) {
    console.error(
      `Invalid mnemonic: ${err instanceof Error ? err.message : String(err)}\n` +
      'Please verify your mnemonic phrase has the correct number of words (12, 15, 18, 21, or 24) ' +
      'and all words are valid BIP-39 words.'
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
    console.error(`Note: could not derive address for display (${err instanceof Error ? err.message : String(err)}), but the keyfile was written successfully.`);
  }
}
