# ENG-805 HTTP read retries

Baseline: `a5db7479372d68e91a718072c283e59022f81994` (merged PR #225).
Branch: `codex/eng-805-http-read-retries`.
Owner: [ENG-805](https://linear.app/liftedinit/issue/ENG-805).

## Scope and decision

The real LCD adapter and faucet status helper preserve HTTP 408 as numeric
`details.httpStatus` on `QUERY_FAILED`. The current classifier treats that response
as permanent, so even an idempotent read with a retry budget stops after one attempt.
This follow-up adds bounded retries for that established read-error contract.

- Allow numeric HTTP 408 on `QUERY_FAILED`, after any gRPC envelope has supplied
  its authoritative verdict. Use the existing budget/backoff and retry owner.
- Preserve permanent errors, partial/submitted outcomes and cancellation vetoes
  throughout the cause chain. Do not infer 408 from message text or broaden other
  error categories. Identity preflight emits `RPC_CONNECTION_FAILED` with HTTP prose
  and remains outside this change's structured query-error scope.
- Keep HTTP-only 425 terminal. A 425 retry must avoid TLS early data, and the SDK
  does not establish that guarantee across native/injected fetch and LCD transports.
  Existing gRPC precedence still applies, including a transient gRPC verdict carried
  over HTTP 425. This does not claim that native Node fetch uses early data.
- Faucet GET/status remains caller-retried; credit POSTs retain their existing
  single-attempt behavior. No new retry ladder, dependency or public option is needed.
- Aggregate-error policy, compiler tooling, optional reason-compatibility coverage
  and the broader ENG-805 work retain their existing owners and acceptance criteria.

[RFC 9110 §15.5.9](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.9)
permits repeating an outstanding request after 408; transport implementations own
replacement of an unusable connection.
[RFC 8470 §5.2](https://www.rfc-editor.org/rfc/rfc8470.html#section-5.2)
requires a 425 retry to avoid early data. The standard
[RequestInit](https://fetch.spec.whatwg.org/#requestinit) contract supplies no control
for that guarantee, and the SDK does not constrain injected transport behavior.

## Implementation and validation

1. Reproduce the missing retry through actual LCD → cosmosQuery and faucet →
   withRetry paths; keep injected transports and generated response conversion.
2. Extend only the structured query-status decision. Test recovery, exhaustion,
   disabled retries, gRPC precedence, other error categories, native/overall
   cancellation, permanent/partial/submitted outcomes and unchanged credit POSTs.
3. Synchronize the retry documentation and changelog, including the HTTP-only 425
   decision and the limits of the structured 408 scope.
4. Run focused regressions, independent review, workspace builds/types, full coverage,
   packaging and unchanged bundle guards. Record exact results and open a follow-up
   PR; keep ENG-805 In Progress for its broader retained work.

## Progress

- [x] Confirm scope, standards and negative controls against the merge baseline.
- [x] Implement and verify the policy and producer regressions.
- [x] Complete integrated validation and independent review.

PR delivery and CI status are tracked in ENG-805.

Validation: 156 focused tests; full V8 suite 3,800 passing tests and 17 existing
skips across 175 files, without type errors. All coverage thresholds, standard
browser checks, workspace builds/types, E2E TypeScript, package/bundle checks and
architecture/coverage/type/workflow/dependency guards pass. The high/critical audit
gate passes with seven low and four moderate advisories in the unchanged tree.
Independent review found no concrete blocker (96% confidence). See the
[remediation record](../../eng805-remediation.md#http-read-status-follow-up-2026-09-10)
for policy confidence scores and the temporary-directory check retries.
