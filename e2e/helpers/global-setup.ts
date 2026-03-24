import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CERT_DIR = resolve(import.meta.dirname, '..', '.tls');
const CERT_PATH = resolve(CERT_DIR, 'cert.pem');

/**
 * Extract the self-signed TLS cert from the e2e providerd container
 * so the MCP server child processes can trust it via NODE_EXTRA_CA_CERTS.
 */
export function setup() {
  if (!existsSync(CERT_PATH)) {
    mkdirSync(CERT_DIR, { recursive: true });
    execFileSync('docker', ['cp', 'e2e-providerd-1:/shared/tls/cert.pem', CERT_PATH], {
      stdio: 'pipe',
    });
  }

  process.env.E2E_TLS_CERT_PATH = CERT_PATH;
}
