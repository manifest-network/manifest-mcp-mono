// `parseBooleanEnv` was promoted to @manifest-network/manifest-mcp-core in
// ENG-268; the full suite lives there (packages/core/src/env-utils.test.ts).
// This smoke test only verifies the agent re-export wiring + behavior.

import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import { parseBooleanEnv } from './env.js';

const ENV = 'MANIFEST_AGENT_FETCH_GUARDED';

describe('parseBooleanEnv re-export (moved to core, ENG-268)', () => {
  it('parses truthy/falsy and falls back to the default', () => {
    expect(parseBooleanEnv('on', false, ENV)).toBe(true);
    expect(parseBooleanEnv('off', true, ENV)).toBe(false);
    expect(parseBooleanEnv(undefined, true, ENV)).toBe(true);
  });

  it('throws INVALID_CONFIG naming the env var on an unrecognized value', () => {
    let err: unknown;
    try {
      parseBooleanEnv('ture', true, ENV);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).message).toContain(ENV);
  });
});
