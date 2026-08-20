import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Doc-sync guard for `packages/node/README.md` — the primary npm-facing install
 * doc, and the one place a user looks to learn which tools a server exposes.
 *
 * It drifted twice: the Fred table said "(11)" and omitted `restore_app` for two
 * releases (ENG-672 D-6), and the agent server had no table at all. Both are the
 * same failure — a tool was added and the README was not — and neither was
 * catchable by any test, because nothing tied the prose to the registrations.
 *
 * This pins each server's table against the `registerTool` names in that
 * server's own source: the heading count, and the exact set of tool names.
 *
 * Per ENG-760, a source-grep guard that does not comment-strip is vacuous — a
 * commented-out `registerTool` would be counted as registered. Lines are
 * comment-stripped before extraction, and the extraction is sabotage-tested by
 * the self-check below.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..');
const README = join(HERE, '..', 'README.md');

/** Where each server registers its tools, and the README heading that documents it. */
const SERVERS = [
  { heading: 'Chain', source: 'chain/src/index.ts' },
  { heading: 'Lease', source: 'lease/src/index.ts' },
  { heading: 'Fred', source: 'fred/src/server/register-tools.ts' },
  { heading: 'CosmWasm', source: 'cosmwasm/src/index.ts' },
  { heading: 'Agent', source: 'agent/src/index.ts' },
] as const;

/** Drop `//`-comment and block-comment-continuation lines before matching. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');
}

/** Tool names passed as the first argument to `registerTool`, in source order. */
function registeredToolNames(source: string): string[] {
  const src = stripComments(readFileSync(join(PACKAGES, source), 'utf8'));
  const names = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map(
    (m) => m[1],
  );
  return [...new Set(names)];
}

/** Tool names in the first column of the README table under `## <heading> server tools (…)`. */
function documentedToolNames(heading: string): {
  count: number;
  names: string[];
} {
  const readme = readFileSync(README, 'utf8');
  const headingRe = new RegExp(
    `^## ${heading} server tools \\(([^)]*)\\)$`,
    'm',
  );
  const match = readme.match(headingRe);
  if (match === null) {
    throw new Error(
      `packages/node/README.md has no "## ${heading} server tools (N)" heading. ` +
        'Every MCP server must have a tool table there.',
    );
  }
  // The leading integer of the count, so Chain's "6, +1 optional" still parses.
  const count = Number.parseInt(match[1], 10);
  const rest = readme.slice((match.index ?? 0) + match[0].length);
  const section = rest.split(/^## /m)[0];
  const names = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map(
    (m) => m[1],
  );
  return { count, names };
}

describe('node README tool tables match the registered tools', () => {
  it.each(SERVERS)(
    '$heading server: documented names equal registered names',
    ({ heading, source }) => {
      const registered = registeredToolNames(source).sort();
      const documented = documentedToolNames(heading).names.sort();

      expect(
        documented,
        `packages/node/README.md's ${heading} table is out of sync with ${source}. ` +
          'Add the missing rows (or drop the stale ones) — this README is the ' +
          'primary npm-facing install doc.',
      ).toEqual(registered);
    },
  );

  it.each(SERVERS)(
    '$heading server: heading count equals the number of rows',
    ({ heading, source }) => {
      const { count, names } = documentedToolNames(heading);
      // Chain documents "(6, +1 optional)" — request_faucet is registered only
      // when MANIFEST_FAUCET_URL is set, so the leading integer is the
      // unconditional count and the table carries one extra row.
      const optional = heading === 'Chain' ? 1 : 0;

      expect(
        names.length - optional,
        `packages/node/README.md says "## ${heading} server tools (${count})" but the ` +
          `table has ${names.length} rows (${optional} documented as optional).`,
      ).toBe(count);
      expect(registeredToolNames(source).length - optional).toBe(count);
    },
  );

  it('the extractor actually finds registrations (guard-for-the-guard)', () => {
    // A regex that silently matches nothing would make every check above pass
    // vacuously — the exact failure mode ENG-760 exists to fix. Fred is the
    // largest surface and the one that drifted, so pin it non-trivially.
    expect(registeredToolNames('fred/src/server/register-tools.ts')).toContain(
      'restore_app',
    );
    expect(
      registeredToolNames('fred/src/server/register-tools.ts').length,
    ).toBeGreaterThan(5);
  });

  it('the extractor ignores a commented-out registration', () => {
    // Sabotage test: `toContain`-style matching on raw source would count this.
    const sabotaged = stripComments(
      ["// mcpServer.registerTool(", "//   'ghost_tool',", 'const x = 1;'].join(
        '\n',
      ),
    );
    expect(sabotaged).not.toContain('ghost_tool');
  });
});
