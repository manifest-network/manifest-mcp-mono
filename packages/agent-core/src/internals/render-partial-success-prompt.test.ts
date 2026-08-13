import { describe, expect, it } from 'vitest';
import {
  type RenderPartialSuccessPromptInput,
  renderPartialSuccessPrompt,
} from './render-partial-success-prompt.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function base(
  overrides: Partial<RenderPartialSuccessPromptInput> = {},
): RenderPartialSuccessPromptInput {
  return {
    leaseUuid: VALID_UUID,
    decodedState: 'LEASE_STATE_PENDING',
    reason: 'simulation failed',
    ...overrides,
  };
}

describe('renderPartialSuccessPrompt', () => {
  describe('input validation', () => {
    it('throws TypeError for non-UUID lease', () => {
      expect(() =>
        renderPartialSuccessPrompt({
          ...base(),
          leaseUuid: 'not-a-uuid',
        }),
      ).toThrow(/leaseUuid must be a UUID/);
    });

    it('throws TypeError for empty decodedState', () => {
      expect(() =>
        renderPartialSuccessPrompt({ ...base(), decodedState: '' }),
      ).toThrow(/decodedState must be a non-empty string/);
    });

    it('throws TypeError for empty reason', () => {
      expect(() =>
        renderPartialSuccessPrompt({ ...base(), reason: '' }),
      ).toThrow(/reason must be a non-empty string/);
    });
  });

  describe('prompt body', () => {
    it('includes the lease UUID + decoded state in the lease line', () => {
      const out = renderPartialSuccessPrompt(base());
      expect(out.prompt).toContain('Deploy partially succeeded:');
      expect(out.prompt).toContain(
        `  - Lease ${VALID_UUID} was created on-chain (state: LEASE_STATE_PENDING).`,
      );
    });

    it('preserves the LEASE_STATE_ prefix verbatim (vs format-success which strips it)', () => {
      const out = renderPartialSuccessPrompt(
        base({ decodedState: 'LEASE_STATE_ACTIVE' }),
      );
      expect(out.prompt).toContain('LEASE_STATE_ACTIVE');
    });

    it('renders the with-domain failure framing when requestedCustomDomain is set', () => {
      const out = renderPartialSuccessPrompt(
        base({ requestedCustomDomain: 'app.example.com' }),
      );
      expect(out.prompt).toContain(
        '  - The set-domain step for app.example.com did NOT complete: simulation failed.',
      );
      expect(out.prompt).toContain(
        '    The manifest was therefore NEVER uploaded to the provider — no app is running on this lease.',
      );
    });

    it('renders the no-domain failure framing when requestedCustomDomain is absent', () => {
      const out = renderPartialSuccessPrompt(base());
      expect(out.prompt).toContain(
        '  - The manifest upload or readiness poll failed: simulation failed.',
      );
      expect(out.prompt).toContain(
        '    The provider may or may not have started the app.',
      );
    });

    it('appends the user-choice question on a blank-line-separated paragraph', () => {
      const out = renderPartialSuccessPrompt(base());
      expect(out.prompt).toMatch(/\n\nWhat do you want to do\?$/);
    });
  });

  describe('options', () => {
    it('returns 2 options (salvage + close) when no domain was requested', () => {
      const out = renderPartialSuccessPrompt(base());
      expect(out.options).toEqual(['salvage_without_domain', 'close_lease']);
    });

    it('returns 3 options (retry + salvage + close) when a domain was requested', () => {
      const out = renderPartialSuccessPrompt(
        base({ requestedCustomDomain: 'app.example.com' }),
      );
      expect(out.options).toEqual([
        'retry_set_domain',
        'salvage_without_domain',
        'close_lease',
      ]);
    });

    it('omits retry_set_domain when requestedCustomDomain is empty string', () => {
      const out = renderPartialSuccessPrompt(
        base({ requestedCustomDomain: '' }),
      );
      expect(out.options).not.toContain('retry_set_domain');
    });

    it('uses close_lease (not cancel_lease) for the unified terminal user-choice', () => {
      // Divergence note: CJS emits a single "Cancel or close the lease"
      // option; the typed vocabulary splits cancel/close. We surface
      // close_lease as the user-facing unified terminal choice; the
      // orchestrator routes to the precise tx based on lease state.
      // cancel_lease remains reachable from verify-recover non-user-
      // prompted paths.
      const out = renderPartialSuccessPrompt(base());
      expect(out.options).toContain('close_lease');
      expect(out.options).not.toContain('cancel_lease');
    });
  });

  /**
   * ENG-661. `hasDomain` was only ever a PROXY for "the set-domain step
   * failed", and a wrong one whenever the deploy got past that step: set-domain
   * runs FIRST, so a domain-carrying deploy whose readiness poll timed out was
   * told the domain never landed and the manifest was never uploaded — both
   * false — and offered retry_set_domain for a domain already claimed.
   */
  describe('step-aware body selection', () => {
    it('a readiness timeout does not claim the set-domain step failed, even with a domain requested', () => {
      const out = renderPartialSuccessPrompt(
        base({
          requestedCustomDomain: 'app.example.com',
          failedStep: 'poll',
          readinessUnconfirmed: true,
        }),
      );

      expect(out.prompt).not.toContain('set-domain step');
      expect(out.prompt).not.toContain('NEVER uploaded');
      expect(out.prompt).toContain('NOT a reported failure');
      expect(out.prompt).toContain('The manifest was uploaded');
      // Retrying a domain that is already claimed is not a recovery.
      expect(out.options).not.toContain('retry_set_domain');
      expect(out.options).toEqual(['salvage_without_domain', 'close_lease']);
    });

    it('warns that closing the lease now would tear down a working deployment', () => {
      const out = renderPartialSuccessPrompt(
        base({ readinessUnconfirmed: true }),
      );
      expect(out.prompt).toContain('closing the lease');
      expect(out.prompt).toContain('working');
    });

    it('an explicit set_domain step keeps the original wording and retry option', () => {
      const out = renderPartialSuccessPrompt(
        base({
          requestedCustomDomain: 'app.example.com',
          failedStep: 'set_domain',
        }),
      );
      expect(out.prompt).toContain('The set-domain step for app.example.com');
      expect(out.prompt).toContain('NEVER uploaded');
      expect(out.options).toEqual([
        'retry_set_domain',
        'salvage_without_domain',
        'close_lease',
      ]);
    });

    it('an upload failure says plainly that no app is running', () => {
      const out = renderPartialSuccessPrompt(base({ failedStep: 'upload' }));
      expect(out.prompt).toContain('The manifest upload failed');
      expect(out.prompt).toContain('No app is running on this lease.');
      expect(out.options).not.toContain('retry_set_domain');
    });

    it('falls back to the legacy inference when fred reported no step', () => {
      // Cross-version safety: an older fred sends neither flag, and must
      // render exactly as it did before.
      const withDomain = renderPartialSuccessPrompt(
        base({ requestedCustomDomain: 'app.example.com' }),
      );
      expect(withDomain.prompt).toContain('The set-domain step for');
      expect(withDomain.options).toContain('retry_set_domain');

      const withoutDomain = renderPartialSuccessPrompt(base());
      expect(withoutDomain.prompt).toContain(
        'The manifest upload or readiness poll failed',
      );
    });
  });
});
