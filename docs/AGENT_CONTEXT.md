# Agent context, local skills, and registered commands

The default compatibility target is the current OpenAI Codex guidance for repository instructions and filesystem skills.

Machine Bridge exposes a stable agent bootstrap layer so an MCP client can use repository instructions and local workflows without requiring one dynamically named MCP tool per skill or command.

The default discovery rules intentionally track current Codex conventions where practical. Machine Bridge also adds a JSON manifest for custom instruction priority, additional skill roots, and named local commands.

This does not make a remote MCP session identical to a locally installed coding agent. The MCP host can independently filter tools, require confirmation, truncate results, or decline calls before they reach Machine Bridge. The bridge cannot alter or bypass those host decisions.

## Tool model

Five tools form the agent-context surface:

- `agent_context` discovers effective instructions, skill summaries, and registered commands for a target path;
- `list_local_skills` searches discovered `SKILL.md` or `skill.md` bundles;
- `load_local_skill` returns one skill entrypoint plus a bounded relative file inventory;
- `list_local_commands` returns the effective command registry;
- `run_local_command` executes one registered command as a direct argv process.

The server instructions tell MCP clients to call `agent_context` before substantive workspace work. This is behavioral guidance, not a protocol-enforced precondition. Every file, Git, mutation, and process tool therefore retains its own policy enforcement.

## Instruction scope and precedence

For a target path, Machine Bridge chooses the nearest ancestor containing `.git` as the project scope root. If no Git marker is found, a target inside the configured workspace uses the workspace root; an unrestricted target outside the workspace uses the target directory.

The default instruction candidates, in priority order, are:

```json
[
  "AGENTS.override.md",
  "AGENTS.md"
]
```

Discovery then works as follows:

1. under unrestricted policy, read the first non-empty candidate in `CODEX_HOME` or `~/.codex`;
2. walk from the project scope root to the target directory;
3. in each directory, apply its optional `.machine-bridge/agent.json` first;
4. select only the first non-empty instruction candidate in that directory;
5. concatenate selected files from global to root to leaf, so later directories have higher precedence.

Empty candidates are skipped. Only one instruction file is selected per directory. This matches the important Codex override behavior: `AGENTS.override.md` suppresses `AGENTS.md` in the same directory, while deeper directories override broader guidance.

The combined instruction budget defaults to 32 KiB. Once the budget would be exceeded, discovery stops and returns `instructions_truncated: true`. A manifest can raise or lower the budget within the hard 2 MiB ceiling.

Global instruction discovery is disabled under workspace-confined profiles because reading `~/.codex` would otherwise bypass the profile's direct-filesystem boundary. Project instructions still work in every profile.

## Custom instruction priority

A manifest may replace the candidate list. The list is priority order, not a list of files to concatenate from the same directory:

```json
{
  "version": 1,
  "instruction_files": [
    "LOCAL.override.md",
    "AGENTS.override.md",
    "AGENTS.md",
    ".github/agent-guidance.md"
  ],
  "instruction_max_bytes": 65536
}
```

For each directory, Machine Bridge selects the first non-empty file in that list. Candidate paths must be relative and their canonical targets must remain inside the directory being inspected.

## Configuration format

A project configuration lives at `.machine-bridge/agent.json`. Relative skill roots and command working directories are resolved against the directory containing `.machine-bridge`, not against the hidden configuration directory itself.

```json
{
  "version": 1,
  "instruction_files": [
    "PROJECT.override.md",
    "AGENTS.override.md",
    "AGENTS.md"
  ],
  "instruction_max_bytes": 65536,
  "skill_roots": [
    ".agents/skills",
    ".codex/skills"
  ],
  "commands": {
    "check": {
      "description": "Run the repository validation suite.",
      "argv": ["npm", "run", "check"],
      "cwd": ".",
      "timeout_seconds": 600,
      "allow_extra_args": false
    },
    "test-file": {
      "description": "Run one test file selected by the caller.",
      "argv": ["node", "--test"],
      "cwd": ".",
      "timeout_seconds": 120,
      "allow_extra_args": true
    }
  }
}
```

Supported top-level fields are:

- `version`: required and currently fixed at `1`;
- `instruction_files`: non-empty priority-ordered relative candidates;
- `instruction_max_bytes`: combined instruction budget from 1 KiB through 2 MiB;
- `skill_roots`: explicit skill directories; when present, this replaces inherited/default roots;
- `commands`: named command definitions merged with inherited commands.

Configuration is evaluated from global to project root to target directory. A deeper definition replaces the inherited value. A deeper command value of `null` removes that command:

```json
{
  "version": 1,
  "commands": {
    "deploy": null
  }
}
```

Unknown fields are rejected so misspellings do not silently weaken the intended workflow.

Under unrestricted policy only, `~/.config/machine-bridge-mcp/agent.json` acts as the initial user-level manifest. Relative paths in that file are resolved from the user's home directory.

## Skill discovery

Without an explicit `skill_roots` setting, Machine Bridge uses Codex-compatible filesystem locations:

- `<target>/.agents/skills`;
- every ancestor's `.agents/skills` through the project root;
- under unrestricted policy, `~/.agents/skills`;
- under unrestricted policy on Unix-like systems, `/etc/codex/skills`.

An explicit `skill_roots` list can add compatibility with other layouts, such as `.codex/skills`, or narrow discovery to selected directories.

Machine Bridge recursively finds directories containing `SKILL.md` or `skill.md`. The entrypoint must contain simple YAML front matter with non-empty `name` and `description` fields:

```markdown
---
name: release-review
description: Review a release without publishing it.
---

# Workflow

...
```

Invalid skills are skipped and reported in `skill_warnings` or `warnings`; one malformed bundle does not prevent valid skills from loading.

Symlinked skill folders are followed, matching Codex behavior. Under workspace-confined profiles, the canonical symlink target must remain inside the workspace. Skill entrypoint files themselves may not be symbolic links. Directory traversal, cycles, entry count, depth, content, and returned file inventory are bounded.

## Progressive disclosure

`agent_context` initially returns only skill metadata: name, description, path, ID, size, and hash. Its skill summary list has an 8,000-character budget and a caller-selected count limit. Descriptions are shortened first and excess skills are omitted with `skills_truncated: true`.

`load_local_skill` accepts a stable opaque ID, an unambiguous exact name, or a displayed entrypoint path. It returns:

- the full bounded UTF-8 `SKILL.md` content;
- metadata and a content hash;
- a bounded relative inventory of files in the skill directory.

Loading a skill never executes its scripts. The model must inspect the instructions and then invoke an ordinary bridge tool, a registered command, or a managed job. This keeps documentation loading separate from executable authority.

## Registered command execution

`run_local_command` is available only when direct process execution is enabled (`agent` or `full`, including equivalent custom policies). It does not invoke a shell. Manifest `argv` elements and caller-supplied arguments remain distinct process arguments, so characters such as `;`, `$()`, pipes, and redirections are not interpreted by a shell.

The manifest remains authoritative:

- caller arguments are rejected unless `allow_extra_args` is true;
- a caller can reduce the timeout but cannot increase it beyond `timeout_seconds`;
- the working directory is canonicalized and remains subject to active path policy;
- the command receives the isolated or full environment selected by the Machine Bridge profile.

Registered commands are workflow aliases, not a sandbox or approval boundary. Repository-controlled package scripts, interpreters, compilers, and executables can run arbitrary code with the local user's authority. Use `edit` or `review`, or external VM/container isolation, for untrusted repositories.

For arbitrary one-off execution, existing tools remain available according to policy:

- `run_process` for direct argv execution;
- `exec_command` for shell syntax under shell-enabled policy;
- `start_job` for durable multi-step work;
- `stage_job` for local operator review and later approval.

## Recommended remote workflow

A remote coding task should normally follow this sequence:

1. call `agent_context` with the file or directory being changed;
2. apply returned instructions in precedence order;
3. load only skills relevant to the task;
4. inspect files before editing;
5. prefer a registered command for validation or a standard workflow;
6. use direct or shell execution only when the registry does not cover the operation;
7. report files changed and commands run.

This approximates local coding-agent context loading while keeping MCP transport, local policy, and host policy as explicit independent boundaries.

## Security and failure behavior

Agent configuration, instruction content, skill traversal, skill summaries, skill inventory, command count, argv size, timeouts, and process output are bounded. Invalid JSON, unknown fields, escaping paths, ambiguous skill names, invalid skill metadata, and missing commands fail explicitly or produce bounded warnings.

Instruction and skill contents are untrusted operational text. They may contain prompt injection or unsafe command guidance. Machine Bridge exposes the content; it does not certify or approve it.
