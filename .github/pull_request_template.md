## Problem and cause

<!-- What fails or is missing? Explain the causal mechanism, not only the symptom. -->

## Solution

<!-- Describe the chosen change and important rejected alternatives. -->

## Risk and compatibility

- [ ] Public contract or compatibility impact assessed
- [ ] Security and privacy impact assessed
- [ ] Operational, migration, and rollback impact assessed
- [ ] No impact in these areas

## Verification

<!-- List automated tests and focused manual checks. -->

- [ ] Regression test added for a defect
- [ ] Permission expansion includes a denial test
- [ ] Bounded/multi-stage behavior includes limit or partial-failure tests
- [ ] `npm run check`
- [ ] `npm audit --audit-level=high`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npm run worker:dry-run`

## Documentation and release

- [ ] User and operator documentation updated where required
- [ ] Generated references are current
- [ ] Version and changelog reflect the release impact
- [ ] Complete diff and package manifest reviewed for private or sensitive data
