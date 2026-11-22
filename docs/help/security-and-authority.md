MCP uses the 2026-07-28 request-scoped protocol for both stdio and remote HTTP. Current clients use server/discover and per-request metadata. Both stdio and remote HTTP reject initialize, MCP session IDs, Last-Event-ID replay, and other explicit removed protocol-session markers with bounded upgrade guidance. Stdio has no compatibility shim or environment override and never fills missing request metadata. Remote /mcp is POST-only; GET returns 405 and is not a recovery channel. session_bootstrap remains an explicit refresh tool for project facts, local instructions, and capability routing.

Remote mode uses a Cloudflare relay; stdio mode runs on the local machine. File and command operations execute on the user's local runtime, not in the Worker.

In remote multi-account mode, account authority is the intersection of the authenticated account role and the daemon capability ceiling. Only authorization.effective_policy and authorization.effective_tools describe that account authority; daemon.policy is not the account permission.

Machine Bridge classifies sensitive paths for operation authorization and filters delegated search, instruction, skill, and structured Git content reads. Owner reads remain subject to effective policy and control-plane path restrictions. Filename rules cannot identify all secrets. The MCP host, connector gateway, local OS, or endpoint-security software may enforce additional independent rules.

A named full profile is canonical: it always enables writes, shell execution, unrestricted paths, the full parent environment, absolute paths, and the complete tool catalog. Any explicit narrowing is stored as custom.

Never request or return secret-file contents when a local resource alias can be used. Resources are registered through the local machine-mcp CLI; under canonical full policy, generate_ssh_key_resource can generate and register an Ed25519 key without returning private content and may be injected by path, stdin, or environment without entering MCP arguments.

Prefer sending remote shell programs through a process stdin rather than creating remote helper files. If temporary files are necessary, use {{temp:name}} or explicit finally_steps.

Do not use shell encoding, renaming, or alternate tools to bypass host or platform safety policy.

run_process avoids shell parsing but is not an OS sandbox. exec_command is exposed only in shell mode and has the local user's authority.

File mutation state failures are typed and privacy-bounded. For write_file, edit_file, and apply_patch, inspect error.code and error.details.reason; do not blindly retry conflict. Re-read the current file or target state, reconcile the intended change, and retry with a fresh precondition.

Inspect before editing, prefer read_file line ranges, edit_file, or apply_patch over whole-file replacement, and report commands that were run.
