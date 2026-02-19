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

  const password = await prompt('Enter password for keyfile encryption: ');
  if (!password) {
    console.error('Error: password cannot be empty.');
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
  } catch {
    console.error('Note: could not derive address for display, but the keyfile was written successfully.');
  }
}

export async function runImport(): Promise<void> {
  const config = loadKeyfileConfig();
  const prefix = config.addressPrefix;
  const keyfilePath = config.keyfilePath;

  await confirmOverwrite(keyfilePath);

  const mnemonic = await prompt('Enter mnemonic: ');
  if (!mnemonic.trim()) {
    console.error('Error: mnemonic cannot be empty.');
    process.exit(1);
  }

  const password = await prompt('Enter password for keyfile encryption: ');
  if (!password) {
    console.error('Error: password cannot be empty.');
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
  } catch {
    console.error('Note: could not derive address for display, but the keyfile was written successfully.');
  }
}
