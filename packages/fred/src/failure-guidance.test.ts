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
    expect(FRED_REASON_GUIDANCE.CleanupFailed.actor).toBe('provider');
    expect(FRED_REASON_GUIDANCE.VolumeCleanupExhausted.actor).toBe('provider');
    expect(FRED_REASON_GUIDANCE.BackendStorageLost.actor).toBe('provider');
  });

  it('never offers maintenance on a lease whose backend storage was lost', () => {
    // Fred PR #243 answers restart, update, and restore with 410 for this lease:
    // the only forward path is a NEW deployment, never a retry of this one.
    const lost = FRED_REASON_GUIDANCE.BackendStorageLost;
    expect(lost.nextStep).toContain('deploy_app');
    expect(lost.nextStep).toContain(
      'restart_app, update_app, and restore_app all fail',
    );
    expect(lost.mayBeHistorical).toBeUndefined();
  });

  it('never claims a lease with lost storage is already closed on chain', () => {
    // Fred serves this reason while the lease is still ACTIVE, and its reconciler
    // can defer the chain close (lost_lease_test.go, DEPLOYMENT.md), so the row
    // must send the reader to the actual chain state.
    const lost = FRED_REASON_GUIDANCE.BackendStorageLost;
    expect(lost.explanation).not.toMatch(/closed on chain/);
    expect(lost.explanation).toContain('later reconciliation sweep');
    expect(lost.explanation).toContain('app_status chainState');
    expect(lost.nextStep).toContain('close_lease');
  });

  it('flags ImagePullFailed as possibly historical (a failed update keeps the previous release)', () => {
    // Fred PR #242 checks image admission before replacing any container, and a
    // ready lease keeps the failed attempt's reason.
    const pull = FRED_REASON_GUIDANCE.ImagePullFailed;
    expect(pull.mayBeHistorical).toBe(true);
    expect(pull.explanation).toContain('If app_status reports ready');
    expect(pull.explanation).toContain('128 layers');
    expect(pull.nextStep).toContain('update_app');
  });

  it('classifies Internal as tenant-ACTIONABLE despite being provider-caused', () => {
    // `actor` is who can DO something, not who is to blame. Conflating the two
    // produced a live contradiction: the row advised restart_app while the
    // prompt listed Internal among the reasons not to retry.
    expect(FRED_REASON_GUIDANCE.Internal.actor).toBe('tenant');
    expect(FRED_REASON_GUIDANCE.Internal.nextStep).toContain('restart_app');
  });

  it('a provider-actor row never advises a retry it just said is impossible', () => {
    // The guard for the contradiction itself, not just its one instance.
    for (const [reason, g] of Object.entries(FRED_REASON_GUIDANCE)) {
      if (g.actor === 'provider') {
        expect(g.nextStep, `${reason} claims no tenant action`).toContain(
          'No tenant action exists',
        );
      }
    }
  });

  it('flags UpdateFailed as possibly historical (the app is still running)', () => {
    // Fred retains reason/message on a healthy `ready` lease whose last update
    // rolled back. Guidance that assumes "failed => down" is wrong here.
    expect(FRED_REASON_GUIDANCE.UpdateFailed.mayBeHistorical).toBe(true);
    expect(FRED_REASON_GUIDANCE.UpdateFailed.explanation).toContain(
      'If app_status reports ready',
    );
    expect(FRED_REASON_GUIDANCE.UpdateFailed.explanation).toContain(
      'recovery may also have failed',
    );
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
