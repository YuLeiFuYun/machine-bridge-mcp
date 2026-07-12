# Repository privacy hygiene

Source code, tests, examples, release notes, and documentation are publication surfaces. Examples must use synthetic identifiers such as `maintenance-key`, `admin@server.example`, reserved example domains, and generic filesystem paths. Do not copy a real server alias, username, hostname, account name, workspace path, key filename, customer name, or internal codename into a fixture merely because the value is not itself a credential.

## Automated check

Run:

```sh
npm run privacy:check
npm run privacy:history
```

`privacy:check` scans tracked and unignored new UTF-8 files and relative names for generic/encrypted/algorithm-specific private-key headers, AWS/GitHub/GitLab/npm/Slack/Google/live-payment/API token forms, JWT-shaped bearer values, embedded-credential URLs, absolute user-home paths, non-example email/`user@host` identifiers, credential-shaped filenames, and locally configured private identifiers. A tracked `.npmrc` is parsed: non-secret repository settings such as `engine-strict=true` are allowed, while authentication/identity keys, environment interpolation, and embedded credentials fail closed. Publication-surface symbolic links are rejected rather than followed. Binary, invalid UTF-8, and files above the bounded scanner limit require explicit manual review instead of being silently skipped. Findings report only file, line, and rule; the matched value is never printed.

`privacy:history` first runs the same current-tree checks, then scans every reachable historical blob path and bounded UTF-8 blob plus every reachable commit message. It catches values that were committed and later deleted. Standard public Dependabot signing trailers are ignored only in that exact commit-message context; the same non-example address remains disallowed in ordinary files. The local `.privacy-denylist` is also applied to history, so a developer may discover legacy identifiers that CI cannot know. Such a finding is real publication history, but ordinary commits cannot erase it.

Git author and committer identity headers are canonical Git metadata rather than blob or commit-message content and are not automatically rejected. Audit them separately with `git log`; changing historical identity metadata requires a coordinated history rewrite and force-update of affected refs.

Maintain machine-specific names in an ignored owner-only file:

```sh
cp .privacy-denylist.example .privacy-denylist
chmod 600 .privacy-denylist
```

Add one identifier per line. The denylist is deliberately local and must never be committed. CI still runs the built-in generic checks; a developer's local check adds their private vocabulary.

## Local maintenance notes

Machine-specific operational notes may be kept under the ignored `.project-local/` directory. Use it for temporary environment state and one-machine recovery observations, not for reusable engineering decisions. General lessons belong in tracked documentation such as `ENGINEERING.md`.

Ignored does not mean safe for secrets: do not store passwords, tokens, private keys, authorization URLs, or copied secret-bearing logs there. `.privacy-denylist` remains the dedicated local vocabulary gate.

## Runtime instruction context

When automatic project context is enabled, Machine Bridge sends a small generated block through the same authorized MCP transport as other session instructions. It may contain the target path relative to the repository root, recognized project/build filenames, package-manager and lockfile names, package script names, runtime constraints, common documentation filenames, and CI workflow filenames.

The generator does not include package script bodies, dependency names or versions, source/document contents, environment values, absolute home paths, or command output. It executes nothing and writes no repository or user files. File and script names can still reveal project structure, so users who do not want that metadata to traverse a remote Worker/host can set `"automatic_project_context": false` in `~/.config/machine-bridge-mcp/agent.json`. Built-in instructions can be disabled separately with `"builtin_instructions": false`.

Neither generated nor explicit instruction content is written to ordinary operational logs.

## Review rules

Before committing or publishing:

- inspect the complete staged diff, including tests, snapshots, examples, release notes, and generated metadata;
- use reserved example domains and neutral aliases;
- run `npm run privacy:check`, review `npm run privacy:history`, run `npm run check`, and inspect `npm pack --dry-run`;
- treat paths, host aliases, usernames, codenames, real browser URLs/page captures, application names tied to a user, and form data as private metadata even when they are not authentication secrets;
- keep browser pairing-state files and captured source/screenshots out of fixtures, documentation, support logs, and release assets;
- review any tracked `.npmrc` as configuration code and never commit authentication, registry identity, environment interpolation, cert/key paths, or credential-bearing URLs;
- inspect package modes and filenames as well as file contents—an empty `.env`, private-key filename, database, or log is still an inappropriate publication artifact.

The scanner is heuristic. It cannot identify every personal or organizational name, split/transformed/encrypted value, image, archive, binary fixture, custom credential format, unreachable/pruned object, reflog-only object, fork/cache copy, or Git identity header. Passing current-tree and reachable-history checks is a gate, not proof that every publication copy contains no private data.

## Incident response

For an accidental publication, remove the value from the current tree and release artifacts, determine whether it is merely identifying metadata or an active credential, and rotate/revoke any credential immediately. Public Git and npm history are immutable in ordinary workflows: replacing the current file does not erase old commits or a published package. A coordinated history rewrite, cache invalidation request, or replacement release may be appropriate, but those actions are disruptive and require an explicit repository-owner decision.
