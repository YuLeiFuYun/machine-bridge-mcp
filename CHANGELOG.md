# Changelog

## 0.16.1 - 2026-07-13

### Fixed

- Fix `machine-mcp` startup after 0.16.0 by keeping normalized policy capabilities immutable while allowing the sealed CLI-owned state record to update persistence metadata.
- Add regression coverage proving `updatedAt` remains writable without permitting capability fields or undeclared fields to be mutated.

## 0.16.0 - 2026-07-13

### Runtime boundaries and lifecycle

- Replace the monolithic local tool dispatcher with a middleware-based execution pipeline covering policy authorization, bounded call registration, cancellation/deadlines, stable error normalization, structured lifecycle events, and per-tool metrics. Add explicit runtime lifecycle states and a process tracker so stop/cancel paths release calls and child ownership deterministically.
- Extract workspace filesystem transactions