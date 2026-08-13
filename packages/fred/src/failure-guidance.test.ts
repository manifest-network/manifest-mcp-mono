import { describe, expect, it } from 'vitest';
import { FRED_REASON_GUIDANCE, guidanceFor } from './failure-guidance.js';
import { FRED_FAILURE_REASONS } from './failure-reason.js';

// The fred MCP tools a next step may legitimately point at. Keeping this list
// here means renaming a tool without revisiting the guidance fails loudly
// rather than shipping advice that names a tool the server no longer registers.
const FRED_TOOLS = [
  'browse_catalog',
  'deploy_app',
  'app_status',
  'get_logs',
  'restart_app',
  'update_app',
  'restore_app',
  'app_diagnostics',
  'app_releases',
  'check_deployment_readiness',
  'build_manifest_preview',
  'wait_for_app_ready',
] as const;

describe('FRED_REASON_GUIDANCE', () => {
  it('has a row for every reason this client curates', () => {
    expect(Object.keys(FRED_REASON_GUIDANCE).sort()).toEqual(
      [...FRED_FAILURE_REASONS].sort(),
    );
  });

  it('every actionable next step names a tool the fred server registers', () => {
    for (const [reason, g] of Object.entries(FRED_REASON_GUIDANCE)) {
      if (!g.nextStep.includes('No tenant action exists')) {
        const named = FRED_TOOLS.some((t) => g.nextStep.includes(t));
        expect(named, `${reason}: "${g.nextStep}"`).toBe(true);
      }
    }
  });

  it('a next step that names no tool says outright that nothing can be done', () => {
    // The inverse guard, and the more valuable half: a row with no tool must be
    // an explicit dead end, not guidance that merely forgot to name one. Never
    // leave an assistant to invent a retry for a failure the tenant cannot fix.
    for (const [reason, g] of Object.entries(FRED_REASON_GUIDANCE)) {
      const named = FRED_TOOLS.some((t) => g.nextStep.includes(t));
      if (!named) {
        expect(g.nextStep, reason).toContain('No tenant action exists');
        expect(g.actor, reason).toBe('provider');
      }
    }
  });

  it('marks the provider-side failures a tenant cannot act on', () => {
    // The cell an assistant cannot infer from the enum name — without it a model
    // will tell the tenant to retry a storage failure they have no access to.
    expect(FRED_REASON_GUIDANCE.Internal.actor).toBe('provider');
    expect(FRED_REASON_GUIDANCE.CleanupFailed.actor).toBe('provider');
    expect(FRED_REASON_GUIDANCE.VolumeCleanupExhausted.actor).toBe('provider');
  });

  it('flags UpdateFailed as possibly historical (the app is still running)', () => {
    // Fred retains reason/message on a healthy `ready` lease whose last update
    // rolled back. Guidance that assumes "failed => down" is wrong here.
    expect(FRED_REASON_GUIDANCE.UpdateFailed.mayBeHistorical).toBe(true);
    expect(FRED_REASON_GUIDANCE.UpdateFailed.explanation).toContain('PREVIOUS');
  });
});

describe('guidanceFor', () => {
  it('resolves a known reason', () => {
    expect(guidanceFor('ImagePullFailed')).toBe(
      FRED_REASON_GUIDANCE.ImagePullFailed,
    );
  });

  it('returns undefined for an UNRECOGNIZED reason instead of throwing', () => {
    // The expected, normal result for a reason from a newer Fred: callers fall
    // back to the human message rather than inventing guidance.
    expect(guidanceFor('SomeFutureReason')).toBeUndefined();
  });

  it('returns undefined when there is no reason', () => {
    expect(guidanceFor(undefined)).toBeUndefined();
  });
});
