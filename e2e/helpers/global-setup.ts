import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CERT_DIR = resolve(import.meta.dirname, '..', '.tls');
const CERT_PATH = resolve(CERT_DIR, 'cert.pem');

/**
 * Extract the self-signed TLS cert from the e2e providerd container
 * so the MCP server child processes can trust it via NODE_EXTRA_CA_CERTS.
 *
 * Extraction is best-effort: chain-only tests work without providerd.
 * Tests that need fred/providerd will fail with clear TLS errors if
 * the cert is missing.
 */
export function setup() {
  mkdirSync(CERT_DIR, { recursive: true });
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
}
