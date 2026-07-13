# Changelog

## 0.16.1 - 2026-07-13

### Fixed

- Fix `machine-mcp` startup after 0.16.0 by keeping normalized policy capabilities immutable while allowing the sealed CLI-owned state record to update persistence metadata.
- Add regression coverage proving `updatedAt` remains writable without permitting capability fields or undeclared fields to be mutated.

## Historical releases

Release notes from 0.2.5 through 0.16.0 are preserved byte-for-byte in [CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md).
