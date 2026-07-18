# Release process

The release invariant is:

- the repository owner started the exact npm tarball represented by `release-acceptance/v<version>.json` on the maintainer machine, and the coding agent observed the live candidate through Machine Bridge before recording a passing result;
- the current package produces the same SHA-1 and SHA-512 integrity values as that accepted tarball;
- `main` points to the release commit, and that exact commit has completed successful push-triggered CI, CodeQL, Governance, and OpenSSF Scorecard runs;
- `v<package version>` points to that same commit locally and on GitHub;
- a final GitHub Release exists for the tag and contains the accepted npm tarball;
- `package.json`, `package-lock.json`, the Worker-reported version, and `browser-extension/manifest.json` (`version`/`version_name`) agree;
- every npm-package change since the prior version tag has a higher package version and matching CHANGELOG section;
- the same accepted package content is present on GitHub and in a new npm version.

A green automated suite is necessary but is not evidence that the maintainer's ordinary installation path works. The repository therefore separates automated validation from observed live candidate verification and binds both to the final package bytes.

## Change classification

A change is **npm-package relevant** when it alters `package.json`, `package-lock.json`, or a path included by the package `files` manifest. Source, runtime scripts, browser extension files, shared contracts, shipped documentation, and package metadata therefore require a new version and local acceptance.

A repository-only change under paths such as `.github/` may be merged without a synthetic npm version when the package bytes are unchanged. It still requires review and all applicable GitHub checks. `scripts/release-impact-check.mjs` implements this distinction from the package manifest rather than from a duplicated path list.

## Prepare the candidate locally

1. Set the new version without creating a tag. The npm version hook synchronizes the Worker and browser-extension versions:

   ```sh
   npm version <version> --no-git-tag-version
   ```

2. Add the matching dated `CHANGELOG.md` section and update affected documentation and audit notes.
3. Run the required dependency, privacy, Worker, and package checks while iterating.
4. Inspect the complete diff.
5. Generate the final candidate:

   ```sh
   npm run release:candidate
   ```

`release:candidate` runs the complete repository suite and then writes the exact npm tarball plus a bounded pending manifest under ignored `.release-candidate/`. Do not modify a packaged file after generating the candidate without regenerating and retesting it.

## Interactive local candidate acceptance

The repository owner starts the exact `.release-candidate/*.tgz` artifact on the maintainer machine with:

```sh
npm run release:candidate:start -- --allow-worker-deploy
```

This command verifies the pending tarball hashes, installs it into the ignored `.release-candidate/runtime/` prefix without replacing the normal global installation, explicitly authorizes startup to update the configured same-name Worker when its version or deployment hash differs, and starts the installed candidate in the foreground. This is an in-place live candidate deployment, not an isolated staging Worker. The owner leaves that process running. The coding agent then connects through Machine Bridge and verifies at minimum:

- the remote Worker reports the candidate version and the persisted deployment hash matches the candidate Worker bundle;
- the remote health route succeeds without redirect;
- the connected runtime reports the candidate package version;
- relay readiness is healthy through the deployed Worker for the intended transport;
- one representative read-only operation succeeds;
- representative changed functionality succeeds, including browser, application, service, proxy, credential, or platform-specific behavior when relevant.

The owner does not run the acceptance command. After the coding agent has observed the live candidate passing those checks, the agent records the decision using the exact phrase printed by `release:candidate`, for example:

```sh
npm run release:accept -- --confirm "I VERIFIED machine-bridge-mcp 1.2.9 CANDIDATE ON THE OWNER MACHINE AND IT WORKS"
```

This creates `release-acceptance/v<version>.json` containing only package identity, hashes, timestamp, result, and a fixed observed-verification marker. It does not store a personal name, machine path, command output, credential, or user content. The acceptance record is intentionally excluded from the npm package, so adding it does not change the tested tarball.

The command repacks the current tree and refuses to record acceptance if any packaged byte changed after candidate preparation. Automated tests alone, a prepared tarball, a process the agent did not observe, or an ambiguous owner response do not authorize acceptance. Version 1.2.8 owner-recorded acceptance remains supported as a historical marker; version 1.2.9 and later require the owner-started, agent-observed workflow.

## Push and review

Commit the candidate changes and acceptance record, then push the branch only through:

```sh
npm run github:push
```

The command requires a clean non-`main` branch, verifies that the acceptance record is tracked, rebuilds the npm package, compares both hashes, and only then executes a non-force push of the current branch. Direct pushes to `main` remain prohibited. Any packaged-file change after acceptance invalidates the hash and blocks the next push until the owner retests a regenerated candidate.

Open a pull request, satisfy the required checks, and squash-merge. Pull-request CI repeats the acceptance verification. A content-preserving squash changes the Git commit but not the package bytes, so the accepted hash remains valid.

## Complete the GitHub source release

From a clean, fast-forwarded `main` worktree whose `HEAD` exactly equals `origin/main`:

```sh
npm run release
```

`npm run release` never pushes `main`. `release:publish` remains a compatibility alias. It verifies the interactive candidate acceptance, runs the complete project and version checks, requires successful exact-commit push runs for CI, CodeQL, Governance, and Scorecard, creates or verifies the annotated version tag, pushes only the version tag when absent, builds the npm tarball, creates or updates the final GitHub Release, uploads the tarball, and verifies the resulting state.

To verify an already completed source release without changing anything:

```sh
npm run release:check
```

To create GitHub Release records for historical remote tags that lack releases:

```sh
npm run release:backfill
```

Backfill is historical metadata repair. It does not retroactively claim that releases predating the 1.2.8 acceptance policy had a recorded local acceptance.

## Publish npm

Only after `release:check` succeeds:

```sh
npm publish --access public
```

`prepublishOnly` repeats the complete checks and GitHub synchronization check. npm publication remains a deliberate release-operator action and is not authorized by an ordinary source change.

## Authentication and external controls

Required local access:

- Git push access to `origin` for the accepted branch and version tag;
- an authenticated GitHub CLI session with pull-request and release permission;
- an npm account that owns the package or has maintainer permission for the separate registry publication step.

GitHub Actions remains a required cross-platform boundary. Missing, pending, cancelled, skipped, failed, pull-request-only, stale, or wrong-commit runs do not satisfy release publication. Observed local candidate acceptance and successful GitHub checks are complementary evidence; neither substitutes for the other.

The preferred registry target remains npm trusted publishing from a narrowly scoped GitHub Actions workflow using OIDC and a protected GitHub environment. Enabling it requires package-owner configuration in npm and a reviewed workflow change. Until then, never place an npm token in repository files, workflow YAML, logs, local acceptance records, or project notes.
