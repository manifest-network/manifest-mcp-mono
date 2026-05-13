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
});
