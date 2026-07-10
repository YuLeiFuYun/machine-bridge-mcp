# Release process

The release invariant is:

- `main` points to the release commit.
- `v<package version>` points to that same commit locally and on GitHub.
- A final GitHub Release exists for the tag.
- The GitHub Release contains the npm tarball generated from that commit.
- `package.json`, `package-lock.json`, and the Worker-reported version agree.

`npm publish` runs `release:check` through `prepublishOnly`, so npm publication is blocked until all GitHub state is synchronized.

## Prepare a version

1. Set the new version without creating an automatic npm tag:

   ```sh
   npm version <version> --no-git-tag-version
   ```

2. Add the matching `CHANGELOG.md` section.
3. Run `npm run check`, review the diff, and commit all release changes to `main`.

## Publish GitHub source and release

From a clean `main` worktree:

```sh
npm run release:publish
```

The command validates the project, fast-forwards `origin/main`, creates or verifies the annotated version tag, pushes it, builds the npm tarball, creates or updates the GitHub Release, uploads the tarball, and verifies the resulting state.

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

The npm lifecycle repeats the full project checks and the GitHub synchronization check before upload.

## Authentication requirements

- Git push access to `origin`.
- An authenticated GitHub CLI session with repository release permission.
- An npm account that owns the package or has maintainer permission.

GitHub Actions is intentionally not required by this release path. This avoids coupling releases to an OAuth token with the separate `workflow` scope while retaining fail-closed synchronization.
