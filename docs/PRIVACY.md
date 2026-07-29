# Repository privacy hygiene

Source code, tests, examples, release notes, and documentation are publication surfaces. Examples must use synthetic identifiers such as `maintenance-key`, `admin@server.example`, reserved example domains, and generic filesystem paths. Do not copy a real server alias, username, hostname, account name, workspace path, key filename, customer name, or internal codename into a fixture merely because the value is not itself a credential.

## Automated check

Run:

```sh
npm run privacy:check
npm run privacy:history
```

`privacy:check` scans tracked and unignored new UTF-8 files and relative names for generic/encrypted/algorithm-specific private-key headers, AWS/GitHub/GitLab/npm/Slack/Google/live-payment/API token forms, JWT-shaped bearer values, embedded-credential URLs, absolute user-home paths, non-example email/`user@host` identifiers, credential-shaped filenames, and locally configured private identifiers. A tracked `.npmrc` is parsed: non-secret repository settings such as `engine-strict=true` are allowed, while authentication/identity keys, environment interpolation, and embedded credentials fail closed. Publication-surface symbolic links are rejected rather than followed. Binary, invalid UTF-8, and files above the bounded scanner limit require explicit manual review instead of being silently skipped. Findings report only file, line, and rule; the matched value is never printed.

`privacy:history` first runs the same current-tree checks, then scans every reachable historical blob path and bounded UTF-8 blob plus every reachable commit message. It catches values that were committed and later deleted. Standard public Dependabot signing trailers are ignored only in that exact commit-message context; the same non-example address remains disallowed in ordinary files. The local `.privacy-denylist` is also applied to history, so a developer may discover older identifiers that CI cannot know. Such a finding is real publication history, but ordinary commits cannot erase it.

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

When automatic project context is enabled, Machine Bridge sends a small generated block through the authorized MCP transport. Modern clients retrieve it explicitly through `session_bootstrap` or capability resolution; legacy initialization may include the same bounded material through its compatibility response. It may contain the target path relative to the repository root, recognized project/build filenames, package-manager and lockfile names, package script names, runtime constraints, common documentation filenames, and CI workflow filenames.

The generator does not include package script bodies, dependency names or versions, source/document contents, environment values, absolute home paths, or command output. It executes nothing and writes no repository or user files. File and script names can still reveal project structure, so users who do not want that metadata to traverse a remote Worker/host can set `"automatic_project_context": false` in `~/.config/machine-bridge-mcp/agent.json`. Built-in instructions can be disabled separately with `"builtin_instructions": false`.

Neither generated nor explicit instruction content is written to ordinary operational logs.

## Capability-routing privacy

Task routing is computed only from the current request, bounded project/skill/command metadata, public tool descriptions, and policy-visible application/browser metadata. The effective authenticated account policy is applied before local application discovery or route construction; a restricted role cannot use the resolver as an inventory side channel for hidden shell, browser, application, or write capabilities.

The returned route set contains tool names, coarse scores, named reasons, ambiguity, and fallbacks. It does not include command bodies, secret values, application documents, browser page data, or tool arguments. Runtime observability keeps only an HMAC task fingerprint and coarse route fields; raw task text and route explanations are not logged. A client-supplied `known_refresh_fingerprint` is a content identity for static context, not a bearer credential.

## Protocol validation privacy

Modern Streamable HTTP mirrors protocol version, method, tool/resource/prompt name, and explicitly annotated primitive tool parameters into headers. These values are used only for routing consistency and are compared with the body before dispatch. Operational logs omit all request headers and every `Mcp-Param-*` value; mismatch errors identify only the field class and do not echo either side. Unknown names, methods, metadata keys, extension keys, and unsupported-version data are bounded or omitted rather than reflected verbatim.

Modern response closure is conveyed by a random internal stream capability. Public requests cannot set it because the outer Worker removes both internal headers, and the credential-free cancel control forwards no access token or DPoP proof. The capability is used only to remove one active pending call and is never logged or persisted as user-visible evidence.

Tool schemas are compiled locally. Network `$ref` dereference is unsupported, so schema validation cannot turn a catalog entry into an outbound metadata request or SSRF channel. Runtime validation also has a total step budget: each array item and own object property consumes work without first allocating an unbounded key list. Open `_meta`, capability-extension, and subscription-filter JSON has an independent 4,096-node/32-level/bounded-key limit; resource subscription lists are count/length bounded. Failures report only JSON Pointer path, keyword, and constraint text; the rejected value is never copied into an error or log, even when it resembles a credential.

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
## Legacy transient resumable result storage

Modern MCP `2026-07-28` response streams are not persisted or resumable: closing the stream cancels the request and releases its transient in-memory owner. For legacy MCP `2025-11-25` Streamable HTTP recovery, the workspace Durable Object may temporarily persist the terminal JSON-RPC response of a remote tool call. This response can contain source text, command output, file metadata, images encoded by the protocol, or other user data returned by the requested tool. It is operational delivery state, not anonymized telemetry and not publication-safe evidence.

Persistence is bounded to 64 streams, at most 1.5 MiB per terminal response, and a two-minute terminal-retention window. While a streamed call is active, the record also contains the tool name, opaque call and WebSocket-generation identifiers, daemon-process identifier, client request correlation, operation/reconnect deadlines, and bounded account metadata needed only to project `project_overview`. It does not persist tool arguments or an in-progress result. Legacy records are bound to the OAuth access-token identity and signed MCP session, carry a SHA-256 integrity value after terminal serialization, and are removed on expiry or completed-record eviction. Opaque call, connection, stream, and event identifiers are correlation values rather than bearer credentials. The digest detects accidental corruption; it is not a signature against an attacker who controls the Durable Object. Normal logs continue to omit tool arguments and results.
