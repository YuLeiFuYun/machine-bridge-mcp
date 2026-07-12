# Session instructions, skills, commands, and capability discovery

Machine Bridge provides a static MCP bootstrap surface for Codex-style instructions and filesystem skills. The catalog remains stable while local instructions, skills, commands, applications, and browser state are discovered at call time.

This approximates a local coding agent without pretending that the MCP server owns the model loop. The host can filter tools, require confirmation, truncate context, or decline calls before they reach Machine Bridge.

## MCP tools

- `session_bootstrap` returns the current global/session instruction text and refresh fingerprint.
- `agent_context` returns the complete target-specific instruction chain, skill summaries, and command registry.
- `resolve_task_capabilities` rescans and ranks skills/commands for the current task, optionally loading the best skill; the runtime also adds application and browser capability metadata.
- `list_local_skills` searches discovered `SKILL.md` bundles.
- `load_local_skill` returns one skill entrypoint and bounded file inventory without execution.
- `list_local_commands` returns effective registered commands.
- `run_local_command` executes a registered direct-argv command when policy permits.

Both stdio and remote Worker connection initialization attempt `session_bootstrap`. Its instruction text is appended to the MCP `initialize` result. Because a host may reuse one MCP connection across conversations, the explicit tool and per-task `resolve_task_capabilities` call remain necessary to refresh and reapply instructions reliably.

## Global `model_instructions_file`

The user-level configuration is:

```text
~/.config/machine-bridge-mcp/agent.json
```

Example:

```json
{
  "version": 1,
  "model_instructions_file": "~/.config/machine-bridge-mcp/MODEL.md"
}
```

Copy-paste setup on macOS/Linux:

```sh
mkdir -p ~/.config/machine-bridge-mcp
cat > ~/.config/machine-bridge-mcp/MODEL.md <<'EOF'
# Global operating instructions

- Use the language and level of detail I request.
- Inspect repository instructions and tests before changing code.
- Do not publish, deploy, rotate credentials, or restart services without explicit authorization.
EOF
cat > ~/.config/machine-bridge-mcp/agent.json <<'EOF'
{
  "version": 1,
  "model_instructions_file": "~/.config/machine-bridge-mcp/MODEL.md"
}
EOF
chmod 600 ~/.config/machine-bridge-mcp/agent.json ~/.config/machine-bridge-mcp/MODEL.md
```

The file is loaded before repository guidance for every session and every target path. It must be a non-empty, regular, non-symbolic-link UTF-8 file and is bounded by the hard instruction-file limit. Relative values are resolved from the user's home directory. Keep credentials, tokens, private keys, and unrelated personal data out of instruction files.

Changes are discovered on the next `session_bootstrap`, `agent_context`, or `resolve_task_capabilities` call and do not require daemon restart. Because an MCP host may reuse a connection and may not call those tools automatically, start a new conversation or reconnect the MCP client when the revised global instructions must be present in initialization context from the beginning.

`model_instructions_file` is global-only. A project `.machine-bridge/agent.json` cannot set or override it. It is read even under workspace-confined profiles because the user explicitly designated it as session configuration. Under those profiles, other user-manifest fields that would widen filesystem/skill/command scope are ignored; project instruction and command policy remains confined.

In remote mode, the selected instruction text necessarily traverses the user's Cloudflare Worker and the authorized MCP host as part of initialization. Do not put credentials or private data in an instruction file.

## Repository instruction precedence

For a target path, Machine Bridge chooses the nearest Git ancestor as scope root, falling back to the configured workspace or target directory. The default candidate priority in each directory is:

```json
[
  "AGENTS.override.md",
  "AGENTS.md"
]
```

Order:

1. `model_instructions_file`, when configured;
2. under unrestricted policy, the first non-empty candidate in `CODEX_HOME` or `~/.codex`;
3. project scope root through the target directory;
4. in each directory, apply `.machine-bridge/agent.json`, then select its first non-empty candidate.

Only one candidate contributes per directory. Deeper files have higher precedence. Empty files are skipped. The repository/global candidate budget defaults to 32 KiB and can be configured up to the hard 2 MiB ceiling. The separately designated model-instructions file retains its own file-size ceiling.

## Project manifest

A project manifest lives at `.machine-bridge/agent.json`:

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
      "description": "Run repository validation.",
      "argv": ["npm", "run", "check"],
      "cwd": ".",
      "timeout_seconds": 600,
      "allow_extra_args": false
    }
  }
}
```

Supported project fields are `version`, `instruction_files`, `instruction_max_bytes`, `skill_roots`, and `commands`. Unknown fields fail closed. Deeper manifests replace inherited instruction/skill settings, override commands by name, and can delete a command with `null`.

## Skill discovery and live refresh

Without explicit `skill_roots`, discovery scans:

- target-to-root `.agents/skills` directories;
- under unrestricted policy, `~/.agents/skills`;
- under unrestricted policy on Unix-like systems, `/etc/codex/skills`.

A skill directory contains `SKILL.md` or `skill.md` with simple front matter:

```markdown
---
name: release-review
description: Review a release without publishing it.
---
```

The entrypoint requires non-empty `name` and `description`. Invalid bundles are skipped with bounded warnings. Symlinked skill directories are followed after canonical policy validation; symbolic-link entrypoint files are rejected. Traversal, depth, entries, summaries, content, and inventory are bounded.

No persistent skill index is trusted as authoritative. `agent_context`, `list_local_skills`, and `resolve_task_capabilities` rescan the effective roots. A refresh fingerprint changes when instruction hashes, skill hashes, command definitions, or relevant configuration changes. Newly created or edited skills are therefore visible without restarting the daemon or changing the MCP tool catalog.

## Progressive disclosure and task selection

`agent_context` returns bounded skill metadata. `load_local_skill` returns full instructions only for one selected bundle. `resolve_task_capabilities` tokenizes the current task, ranks skill names/descriptions and command names/descriptions/argv, returns matches with scores, and loads the leading skill only when its relevance threshold is met.

This ranking is deterministic local assistance, not semantic certainty. The model must still evaluate whether the selected skill applies. Machine Bridge does not execute skill scripts implicitly and does not fabricate a dynamically named MCP tool per skill.

## Registered commands

`run_local_command` uses direct argv spawning rather than a shell. The manifest controls working directory, timeout ceiling, and whether caller arguments are accepted. A caller may reduce but not increase the timeout.

Registered commands are workflow aliases, not an approval boundary or sandbox. Package scripts, interpreters, compilers, and executables retain local-user authority. Use `review` or `edit`, or external VM/container isolation, for untrusted content.

## Recommended host workflow

1. consume MCP initialization instructions;
2. call `resolve_task_capabilities` with the complete user task and target path;
3. apply returned global/project instructions;
4. follow the selected skill only after checking relevance;
5. prefer registered commands for stable workflows;
6. use structured application/browser tools where applicable;
7. inspect before mutation or submission and report operations performed.

Machine Bridge can automatically discover, refresh, rank, and load capabilities. Actual invocation remains a host/model decision. This boundary cannot be removed by server architecture alone.

## Security and failure behavior

Instruction and skill text is untrusted operational content and may contain prompt injection or destructive guidance. The bridge exposes it but does not certify it. Paths, files, roots, counts, byte budgets, argv, timeouts, and result sizes are bounded. Escaping paths, ambiguous skill names, malformed metadata, invalid configuration, and missing commands fail explicitly or produce bounded warnings.
