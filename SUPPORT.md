# Support policy

## Supported environment

The supported runtime is the pinned Node.js 26 and npm 12 baseline on current GitHub-hosted Linux, macOS, and Windows environments. Older Node/npm releases and obsolete MCP protocol versions are not compatibility targets.

The project supports the current package version and a direct upgrade from the immediately preceding published version when both use the current local state and policy schemas. See [Upgrading](docs/UPGRADING.md).

## Where to ask

- Reproducible defects: use the bug report template.
- Feature proposals: use the feature request template.
- Security vulnerabilities or suspected credential exposure: follow [SECURITY.md](SECURITY.md), not a public issue.
- General installation and recovery: consult [Getting started](docs/GETTING_STARTED.md) and [Operations](docs/OPERATIONS.md) before filing an issue.

## Required diagnostic information

A useful report includes:

- package version, operating system, Node version, and npm version;
- whether the transport is remote OAuth relay or local stdio;
- the active policy profile;
- the exact command or MCP operation that failed;
- sanitized output from `machine-mcp doctor` and, when available, `diagnose_runtime`;
- a minimal reproduction and whether the failure persists in a fresh disposable workspace.

Never include passwords, bearer tokens, private keys, browser pairing material, raw state files, real home/workspace paths, or unredacted logs. Replace them with synthetic values before posting.

## Response expectations

This is currently a single-maintainer project. There is no guaranteed response time or commercial support commitment. Security reports and regressions affecting data integrity, authorization, or release integrity receive priority over feature requests.
