# Lease diagnostic — 11111111-1111-4111-8111-111111111111

## Chain state

- **State:** LEASE_STATE_CLOSED
- **Provider:** 22222222-2222-4222-8222-222222222222
- **Created:** 2026-05-19T15:00:00.000Z
- **Closed:** 2026-05-19T15:30:00.000Z

## Items

- **web** → (no custom domain)
- **db** → (no custom domain)

## Guidance

- Lease is in terminal state `LEASE_STATE_CLOSED`. No further provider activity expected.
- To redeploy, create a new lease via `deployApp`.