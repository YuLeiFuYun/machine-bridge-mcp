# Release process

The release invariant is:

- `main` points to the release commit.
- `v<package version>` points to that same commit locally and on GitHub.
- A final GitHub Release exists for the tag.
- The GitHub Release contains the npm tarball generated from that commit.
- `package.json`, `package-lock.json`, and the Worker-reported version agree.
- Every release-relevant change since the prior version tag has a higher package version and matching CHANGELOG section.
- The same reviewed change is present on GitHub and in a new npm version.

`npm publish` runs `release:check` through `prepublishOnly`, so npm publication is blocked until all GitHub state is synchronized.

## Prepare a version

1. Set the new version without creating an automatic npm tag:

   ```sh
   npm version <version> --no-git-tag-version
   ```

2. Add the matching dated `CHANGELOG.md` section.
3. Run `npm run release-impact:check`, `npm run privacy:check`, `npm run check`, both dependency audits, `npm audit signatures`, and generate a CycloneDX `npm sbom`.
4. Inspect the complete diff and `npm pack --dry-run`, then commit and push all release changes to `main`.

A privacy/security documentation correction is not “docs only” for release purposes. It requires a replacement npm version and, when appropriate, deprecation or unpublication of the affected version.

## Publish GitHub source and release

From a clean `main` worktree:

```sh
npm run release:publish
```

The command validates the project, including repository privacy checks, fast-forwards `origin/main`, creates or verifies the annotated version tag, pushes it, builds the npm tarball, creates or updates the GitHub Release, uploads the tarball, and verifies the resulting state. Read-only GitHub operations, Git pushes, and idempotent release updates use bounded retries only for classified transient network failures; ambiguous Release creation responses are resolved by querying server state before continuing.

To verify without changing anything:

```sh
npm run release:check
```

To create GitHub Release records for existing remote version tags that lack releases:

```sh
npm run release:backfill
```

## Publish npm

Only after `release:check` succeeds:

```sh
npm publish --access public
```

The npm lifecycle repeats the full project checks and the GitHub synchronization check before upload. Do not leave a code or documentation fix only on GitHub; the corresponding npm version must be published, and the operator should be explicitly reminded until registry publication is confirmed.

## Authentication requirements

- Git push access to `origin`.
- An authenticated GitHub CLI session with repository release permission.
- An npm account that owns the package or has maintainer permission.

GitHub Actions is intentionally not required by this release path. This avoids coupling releases to an OAuth token with the separate `workflow` scope while retaining fail-closed synchronization.
