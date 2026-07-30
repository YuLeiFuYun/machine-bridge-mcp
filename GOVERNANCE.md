# Project governance

## Current ownership

The project currently has one human maintainer, `@YuLeiFuYun`. Repository automation may complete reviewed source changes under [AGENTS.md](AGENTS.md), but automation is not an independent reviewer and cannot replace accountable human ownership.

The maintainer owns product direction, security policy, repository administration, GitHub tag/Release publication, npm package ownership, Cloudflare deployment decisions, and release credentials. GitHub source publication, live npm publication, Worker deployment, credential rotation, and daemon/service replacement remain explicit operator actions.

## Decision model

Changes are accepted on technical evidence. The deciding criteria are, in order:

1. preservation of authorization, integrity, privacy, and recovery invariants;
2. correctness across supported platforms and failure paths;
3. clarity of public contracts and upgrade behavior;
4. cohesion, coupling, and long-term maintenance cost;
5. user value relative to operational complexity.

A product or security invariant may change only through an explicit documented decision with tests, migration consequences, and release notes.

## Maintainer admission and succession

A second maintainer should have a sustained history of high-quality review or contributions, understand the trust boundaries in `SECURITY.md` and `docs/ARCHITECTURE.md`, and be able to operate the release process without access to another person's credentials.

Before granting write or publication authority:

- require hardware-backed multifactor authentication where the platform supports it;
- add the person to CODEOWNERS for the areas they can review;
- verify recovery access for GitHub and npm through separate principals;
- rehearse a release from a protected branch and a non-production test deployment;
- document how access is revoked if the maintainer becomes unavailable or leaves.

Once a second active maintainer exists, branch protection must require one non-author approval and approval of the last push for changes affecting Worker authorization, policy contracts, process execution, browser automation, persistent state, workflows, security policy, or release tooling.

## Release authority

Source release completion requires the exact `main` commit to pass CI, CodeQL, Governance, and OpenSSF Scorecard gates. The repository owner must start Git tag/GitHub Release publication from a TTY-backed terminal with the explicit confirmation flag; background agents, managed jobs, CI, and redirected sessions are rejected by the supported workflow. This ceremony records accountable operator action but cannot distinguish a human from arbitrary code already running as the same OS user. The annotated Git tag, GitHub Release, release asset, package version, Worker version, and extension version must identify the same source state.

npm publication should move to trusted publishing with GitHub OIDC and a protected release environment. Until the external npm trust relationship is configured, publication remains a deliberate local operator action and no long-lived npm token may be stored in the repository.

## Inactivity and transfer

If the sole maintainer expects to be unavailable, the preferred order is:

1. appoint and verify a successor before transferring publication or repository authority;
2. publish a maintenance notice and freeze feature work;
3. preserve security-report access and package deprecation/recovery capability;
4. archive the repository only when no qualified successor exists.

No contributor acquires release authority solely through commit volume. Access must be explicit, least-privilege, reviewable, and reversible.
