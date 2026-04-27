import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CERT_DIR = resolve(import.meta.dirname, '..', '.tls');
const CERT_PATH = resolve(CERT_DIR, 'cert.pem');
const CONVERTER_ENV_PATH = resolve(CERT_DIR, 'converter.env');

/**
 * Extract the self-signed TLS cert from the e2e providerd container
 * so the MCP server child processes can trust it via NODE_EXTRA_CA_CERTS.
 *
 * Also extract the converter contract address from the chain container's
 * shared volume (written by init_billing.sh) so cosmwasm tests can pass
 * MANIFEST_CONVERTER_ADDRESS through to the spawned MCP server.
 *
 * Extraction is best-effort: chain-only tests work without providerd or
 * the converter file. Tests that need fred/providerd will fail with clear
 * TLS errors if the cert is missing; cosmwasm tests will fail with a clear
 * error if the converter address is missing.
 */
export function setup() {
  mkdirSync(CERT_DIR, { recursive: true });

  // TLS cert from providerd
  try {
    execFileSync(
      'docker',
      ['compose', '-f', 'e2e/docker-compose.yml', 'cp', 'providerd:/shared/tls/cert.pem', CERT_PATH],
      { stdio: 'pipe' },
    );
    process.env.E2E_TLS_CERT_PATH = CERT_PATH;
  } catch (err) {
    const stderr =
      err && typeof (err as { stderr?: Buffer }).stderr?.toString === 'function'
        ? (err as { stderr: Buffer }).stderr.toString().trim()
        : '';
    console.warn(
      '[e2e] Could not extract TLS cert from providerd — fred tests will fail.\n' +
        (stderr ? `  ${stderr}\n` : '') +
        '  Start the full stack: docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180',
    );
  }

  // Converter address from chain container (written by init_billing.sh).
  // Copy from the chain service since it always has the shared volume mounted;
  // the init service exits after running and may not be queryable.
  try {
    execFileSync(
      'docker',
      ['compose', '-f', 'e2e/docker-compose.yml', 'cp', 'chain:/shared/converter.env', CONVERTER_ENV_PATH],
      { stdio: 'pipe' },
    );
    const contents = readFileSync(CONVERTER_ENV_PATH, 'utf8');
    const match = /^MANIFEST_CONVERTER_ADDRESS=(.+)$/m.exec(contents);
    if (match) {
      process.env.MANIFEST_CONVERTER_ADDRESS = match[1].trim();
    }
  } catch {
    // Best-effort: cosmwasm tests will fail with a clear error if
    // MANIFEST_CONVERTER_ADDRESS is unset.
  }
}
