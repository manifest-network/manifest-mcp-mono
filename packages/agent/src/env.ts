/**
 * Boolean-flavored env-var parsing for `@manifest-network/manifest-mcp-agent`.
 *
 * The implementation was promoted to `@manifest-network/manifest-mcp-core`
 * in ENG-268 once a second consumer (`packages/fred`'s SSRF-guard gate)
 * needed it. Re-exported here so the agent package's existing `./env.js`
 * import path keeps working.
 */
export { parseBooleanEnv } from '@manifest-network/manifest-mcp-core';
