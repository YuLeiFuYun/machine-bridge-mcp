# Managed jobs and local resources

## Problem addressed

An MCP conversation is not a durable execution coordinator. A host or connector may reject a later tool call, an approval may be withdrawn, the network may disconnect, or local endpoint-security software may begin denying process creation. A sequence such as:

1. create a helper script;
2. connect to a remote server;
3. repair the service;
4. remove the helper;

can therefore stop after step 2 or 3 and leave local or remote temporary state behind.

Machine Bridge managed jobs reduce this failure mode by accepting the complete execution and cleanup plan in one call. After acceptance, an independent local runner owns the lifecycle. It does not depend on the MCP socket remaining connected.

This mechanism does **not** bypass host, operating-system, or endpoint-security policy. A job snapshots its execution policy/environment at acceptance; later profile changes affect new jobs, while accepted jobs continue until completion or explicit cancellation. The initial `start_job` request must still be permitted, and every local child process remains subject to local security controls.

## Diagnose the blocking layer

Use the MCP tool:

```text
diagnose_runtime
```

or the local terminal:

```sh
machine-mcp doctor
```

Interpretation:

| Observation | Likely boundary |
|---|---|
| The tool call is rejected before any structured response | MCP host, connector gateway, approval system, or transport |
| `diagnose_runtime` responds, but `local-process-spawn` fails | Local OS permissions, endpoint security, executable policy, or broken runtime |
| Process spawn passes but `local-shell` fails | Shell configuration or shell-specific local policy |
| Managed-job storage fails | State-root permissions, disk, filesystem policy, or endpoint security |
| A job was accepted and later MCP calls are rejected | The detached job continues; inspect it through local CLI |

A successful diagnostic response proves that particular request reached the local daemon. It cannot retrospectively identify a request that the host blocked before delivery.

## Register local resources

Secrets and other local-only files should be registered from the user's terminal, not read into the model context:

```sh
chmod 600 ~/.ssh/example_maintenance_ed25519
machine-mcp resource add maintenance-key ~/.ssh/example_maintenance_ed25519
machine-mcp resource list                 # paths omitted by default
machine-mcp resource list --show-paths    # explicit local-only disclosure
machine-mcp resource check maintenance-key
```

Registration stores only canonical path and bounded metadata in owner-only state. It reads the file locally to validate accessibility and size but does not print or send its contents. New jobs see registry changes immediately; the daemon does not need a restart.

Unix-like systems reject group/other-readable resource files by default. `--allow-insecure-permissions` is an explicit override. Windows ACLs and extended Unix ACLs cannot be fully represented by the portable mode check, so operators must still inspect platform permissions.

Remove an alias with:

```sh
machine-mcp resource remove maintenance-key
```

Removing an alias affects new jobs. A job already accepted has an owner-only resource snapshot specification and continues independently.

Generate a new Ed25519 resource rather than exposing a private-key creation command through a model-generated shell string:

```sh
machine-mcp resource generate-ssh-key maintenance-key ~/.ssh/machine-mcp-example-maint-ed25519
```

Canonical-full MCP clients also receive `generate_ssh_key_resource`. It generates or reuses the pair locally, verifies correspondence, registers the private file, and returns neither private bytes nor local paths by default. Set `expose_paths=true` only for an explicit path-retrieval operation. Public-key installation in a cloud or remote account should be a separate reviewed step or managed job.

## Resource injection modes

A managed step is argv-based and supports three local resource modes:

### File-path placeholder

```json
{
  "argv": ["ssh", "-i", "{{resource:maintenance-key}}", "admin@server.example", "true"]
}
```

The runner copies the resource into the private job runtime with mode `0600`, substitutes that copy's path, and removes the runtime after cleanup.

### Standard input

```json
{
  "argv": ["some-program", "--password-stdin"],
  "stdin_resource": "service-password",
  "capture_output": "discard"
}
```

### Environment variable

```json
{
  "argv": ["some-program"],
  "env_resources": {
    "SERVICE_TOKEN": "service-token"
  },
  "capture_output": "discard"
}
```

Environment injection is convenient but may expose a value to same-user process inspection or child processes. Prefer a file path or stdin when the target program supports it.

At job acceptance, referenced resources are reopened, bounded, hashed, and recorded in the owner-only active plan. The runner reopens and verifies the hash before copying. A changed resource causes the job to fail rather than silently using different content.

## Job-scoped temporary files

Do not create ad hoc helpers in the workspace when the file exists only for one operation. Include it in the job:

```json
{
  "temporary_files": [
    {
      "name": "repair.js",
      "content": "console.log('repair')"
    }
  ],
  "steps": [
    {
      "argv": ["node", "{{temp:repair.js}}"]
    }
  ]
}
```

Available placeholders are:

```text
{{temp:name}}
{{resource:name}}
{{job:runtime}}
{{job:workspace}}
```

Temporary files live only below the private job runtime and are removed in the runner's final cleanup path. This is preferable to writing into `Codex/daily/ops`, `/tmp`, or a remote home directory and relying on a later MCP call to delete the file.

For a remote shell program, avoid a remote helper entirely when possible:

```json
{
  "steps": [
    {
      "argv": [
        "ssh",
        "-i",
        "{{resource:maintenance-key}}",
        "admin@server.example",
        "sh",
        "-s"
      ],
      "stdin": "set -eu\n# repair commands here\n"
    }
  ]
}
```

The script travels through the SSH process stdin and is not stored as a remote file.

## Finally steps

A job can contain ordered main steps and ordered `finally_steps`:

```json
{
  "name": "remote maintenance",
  "steps": [
    {
      "argv": ["ssh", "admin@server.example", "perform-maintenance"]
    }
  ],
  "finally_steps": [
    {
      "argv": ["ssh", "admin@server.example", "rm", "-f", "/tmp/maintenance-helper"],
      "allow_failure": true
    }
  ]
}
```

Finally steps are attempted after success, failure, timeout, or cancellation. Cancellation is delivered through an owner-only marker polled by the runner; the runner terminates the current child process tree and remains alive to execute cleanup. This avoids platform-specific signal behavior killing the coordinator itself. If a runner is interrupted, the next daemon start or local `machine-mcp job ...` command detects the dead runner, removes stale private resource copies, and runs the finally phase in recovery mode.

Automatic dead-runner recovery is attempted at most three times; persistent failure becomes `recovery_exhausted` to avoid an endless restart loop. Cleanup is best effort, not mathematically guaranteed. Power loss, disk failure, permanent account loss, or a local security product that denies the cleanup executable can still prevent it. Finally steps should therefore be idempotent and safe to run more than once.

## Two-phase local approval

If the MCP host rejects execution-class tools but still allows state changes, use:

```text
stage_job
```

This performs the same schema, cwd, resource, size, and permission validation as `start_job`, but records status `staged` and launches no process. The response includes the local approval command:

```sh
machine-mcp job inspect JOB_ID
machine-mcp job approve JOB_ID
# or after a separate review, non-interactively:
machine-mcp job approve JOB_ID --yes
```

`job inspect` displays the reviewable plan, including argv, ordinary environment overrides, stdin, temporary helper content, and finally steps, while omitting registered resource source paths and per-resource hashes. The overall `plan_sha256` is displayed for review and is revalidated atomically during approval and again by the runner before execution. A modified staged plan is rejected.

Local approval is a new operator authorization. It intentionally does not depend on the current MCP execution profile: a plan staged under a write-capable profile can be reviewed and approved from the terminal even when the connector is not allowed to execute. The plan retains the filesystem scope and environment mode captured when it was staged.

Before approval:

- no main step runs;
- no finally step runs;
- no resource is copied into a runtime directory;
- cancelling produces `cancelled_before_start` and deletes the plan.

Staged plans count toward the 50-item retention limit and expire with the seven-day job retention policy. They are not considered active processes and do not independently block uninstall after the normal uninstall confirmation.

## Submit and inspect

Through MCP:

```text
stage_job
start_job
list_jobs
read_job
cancel_job
```

From the local terminal, including after an MCP host blocks further execution calls:

```sh
machine-mcp job list
machine-mcp job inspect JOB_ID
machine-mcp job approve JOB_ID [--yes]
machine-mcp job cancel JOB_ID
```

A local JSON fallback is also available:

```sh
machine-mcp job submit plan.json
```

The plan format is the same object accepted by `start_job`.

## Output and secret handling

Step output is bounded to 64 KiB per stream and a shared 256 KiB capture budget per job, then stored in owner-only job results. Exact registered resource paths and exact resource content are replaced before results are returned. Common exact base64 and hexadecimal forms are also replaced for bounded resources.

This redaction is defense in depth, not a data-loss-prevention guarantee. It cannot reliably detect:

- partial secrets;
- encrypted, compressed, hashed, or otherwise transformed values;
- values copied from the full inherited environment rather than registered resources;
- application-specific encodings.

Use:

```json
{ "capture_output": "discard" }
```

for any step that may echo a credential. In discard mode stdout and stderr are consumed but not retained or returned.

Never place a secret directly in `argv`, `env`, `stdin`, a temporary file's `content`, or a plan JSON file. Use a registered resource alias.

## Persistence and privacy

Per-workspace jobs are stored below the owner-only profile directory. Active jobs retain an owner-only plan for crash recovery. After a terminal status is committed, the full plan is deleted, including argv, stdin, embedded temporary-file content, and resource source paths.

Retained public job data contains bounded status and redacted results. Up to 50 jobs are retained for up to seven days. Private runtime copies are removed after the finally phase. Runner stdout/stderr log files contain only runner-level diagnostics; step output is not written to those operational logs.

Process sessions and managed jobs have different semantics:

- process sessions are interactive, memory-only, and die with the daemon connection;
- managed jobs are non-interactive, persistent, detached, and designed to survive MCP disconnection.
