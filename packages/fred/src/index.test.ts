import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

/**
 * The MCP-server symbols that must NOT leak into the main barrel. `FredMCPServer`
 * pulls in `server/*` (register-tools/resources/prompts, the SSRF `fetch-gate`)
 * which imports core's Node-only `@manifest-network/manifest-mcp-core/guarded-fetch`
 * (resolves to `default: null` in browsers). If the barrel re-exports them, a
 * browser consumer importing any capability function (e.g. `deployManifest`)
 * fails to bundle (ENG-287). The server lives at the `./server` subpath instead.
 */
const SERVER_ONLY = ['FredMCPServer', 'createMnemonicFredServer'] as const;

describe('fred barrel — MCP server kept out (browser bundle safety, ENG-287)', () => {
  it.each(SERVER_ONLY)('does not export %s from the main barrel', (name) => {
    expect(name in barrel).toBe(false);
  });

  it('still exports the browser-safe capability surface', () => {
    expect(typeof barrel.deployManifest).toBe('function');
    expect(typeof barrel.deployApp).toBe('function');
    expect(typeof barrel.restartApp).toBe('function');
    expect(typeof barrel.updateApp).toBe('function');
    expect(typeof barrel.buildManifest).toBe('function');
    expect(typeof barrel.appStatus).toBe('function');
  });
});

describe('fred/server subpath entry (ENG-287)', () => {
  it('exposes FredMCPServer + createMnemonicFredServer', async () => {
    const entry = await import('./server/index.js');
    expect(typeof entry.FredMCPServer).toBe('function');
    expect(typeof entry.createMnemonicFredServer).toBe('function');
  });
});

describe('package.json exports — server subpath (ENG-287)', () => {
  it('maps ./server to the built Node-only entry, "." stays the barrel', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    const sub = pkg.exports?.['./server'];
    expect(sub).toBeDefined();
    expect(sub.node).toBe('./dist/server/index.js');
    expect(pkg.exports?.['.'].import).toBe('./dist/index.js');
  });
});
