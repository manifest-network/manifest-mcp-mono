import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CERT_DIR = resolve(import.meta.dirname, '..', '.tls');
const CERT_PATH = resolve(CERT_DIR, 'cert.pem');

/**
 * Extract the self-signed TLS cert from the e2e providerd container
 * so the MCP server child processes can trust it via NODE_EXTRA_CA_CERTS.
 */
export function setup() {
  mkdirSync(CERT_DIR, { recursive: true });
  try {
    execFileSync('docker', ['cp', 'e2e-providerd-1:/shared/tls/cert.pem', CERT_PATH], {
      stdio: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to extract TLS cert from e2e-providerd-1 container: ${msg}\n` +
        'Ensure the Docker E2E stack is running:\n' +
        '  docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180',
    );
  }

  process.env.E2E_TLS_CERT_PATH = CERT_PATH;
}
