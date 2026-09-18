// The local devnet defaults to PR #240, while production clients default to
// v0.13. CI selects both explicitly; never infer capability from an HTTP error.
const mode = process.env.FRED_COMPATIBILITY ?? 'pr240';
if (mode !== 'v0.13' && mode !== 'pr240') {
  throw new Error('FRED_COMPATIBILITY must be v0.13 or pr240');
}
if (
  process.env.MANIFEST_FRED_COMPATIBILITY !== undefined &&
  process.env.MANIFEST_FRED_COMPATIBILITY !== mode
) {
  throw new Error('The E2E devnet and MCP Fred compatibility modes disagree');
}
export const fredCompatibility = mode;
export const composeArgs =
  mode === 'v0.13'
    ? [
        'compose',
        '--project-name',
        'mcp-e2e-v013',
        '-f',
        'e2e/docker-compose.v013.yml',
      ]
    : ['compose', '-f', 'e2e/docker-compose.yml'];
