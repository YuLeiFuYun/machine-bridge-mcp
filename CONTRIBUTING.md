# Contributing and release discipline

This repository treats every Git-tracked or nonignored repository file as release-relevant, including source code, tests, scripts, examples, documentation, CI configuration, ignore rules, and package metadata.

## Required for every release-relevant change

Before a change is merged to `main`:

1. bump `package.json` to a version newer than the latest reachable `v*` tag;
2. add the matching dated section to `CHANGELOG.md`;
3. run `npm run check`, `npm audit`, `npm audit --omit=dev`, and `npm run worker:dry-run`;
4. inspect the complete diff and the npm package manifest;
5. push the reviewed commit to GitHub;
6. create the matching Git tag and GitHub Release;
7. publish the same version to npm.

`npm run release-impact:check` enforces the version and changelog parts. It fails when release-relevant files changed after the latest version tag but the package version was not advanced.

A privacy or security correction is always release-relevant. Removing a private identifier only from the current branch is insufficient: publish a replacement npm version, update GitHub, and deprecate or unpublish the affected npm version when policy and authentication permit.

## Privacy

Use only synthetic names, reserved example domains, and generic paths. Maintain private local identifiers in the ignored `.privacy-denylist` and run `npm run privacy:check` before committing.
