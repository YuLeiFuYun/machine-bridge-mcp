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

## Terminal persistence and sensitive-plan cleanup

A job terminal transition is not a single best-effort write. The runner first attempts the bounded `result.json`, then persists a conservative terminal `status.json` with cleanup pending, then removes the private runtime directory, active plan, PID claim, and cancellation marker, and finally confirms cleanup state. `transition.lock` and `recovery.lock` are not ordinary artifacts: only their owning/reclaiming lock primitive may release them. A result-write failure is visible as `result_persisted=false` together with a bounded `terminal_record_error_class`; `read_job` then returns that persisted failure evidence without retrying an explicitly unpersisted result. Destructive terminal cleanup accepts that degraded form only when both fields are present. If a result file is present, `read_job` validates that it is a terminal result belonging to the same job and, once status is terminal, that status/result state agree; cleanup additionally requires the same `finished_at` generation before treating the two files as one terminal commit. Malformed, cross-job, missing, or cross-generation result state fails as an integrity error instead of authorizing cleanup or being passed through. Conversely, a terminal status that does not explicitly record `result_persisted=false` must still have its result file; a missing terminal result is also an integrity error rather than a silently incomplete success/failure response. A status-write failure leaves recovery material intact. Artifact removal failures remain visible as `artifact_cleanup_pending` and are retried by later read/list/prune operations.

If the runner writes a valid terminal result but exits before terminal status is committed, the manager reconstructs status from that result before considering recovery. If a dead runner instead leaves a present but non-terminal, cross-job, or otherwise invalid result object, recovery fails closed and retains the state for inspection rather than treating that corruption as an absent result and overwriting it with a cleanup retry. Lifecycle status is likewise an explicit enum, not a `not-active => terminal` inference: an unknown on-disk status is retained as an integrity failure, is not scrubbed or capacity-evicted as a completed job, blocks destructive removal through active-job inventory, and cannot be acknowledged as already finished by cancellation/revocation. While the runner is still alive in the narrow result-first/status-second settlement window, `read_job` also projects a coherent terminal status from that already-durable result in memory rather than returning an active outer status beside a terminal nested result; cleanup remains conservatively reported as pending until the persisted status catches up. This read-side projection never writes runner-owned state. These rules prevent a completed finally sequence from being replayed or observably mixed merely because the status write has not happened yet. If no valid terminal result exists, recovery may still repeat finally work, so finally steps must remain idempotent.

Unexecuted staged plans can contain stdin, environment values, and temporary scripts. They expire after 24 hours, but expiry is itself a per-job state transition: pruning must acquire the job transition lock, re-read the current status, and only then commit the non-executing terminal record through the same result-first persistence boundary. A concurrent cancel/other transition therefore wins or finishes before expiry rather than racing it. Terminal retention begins from that terminal record's `finished_at`, not from the older staged directory age, so a long-abandoned draft is not immediately deleted in the same pass that first expires it. When seven-day retention or capacity pressure eventually retires a complete job directory, removal is also generation-bound: the inspected directory is atomically quarantined under an internal `retired_job_*` generation name before recursive deletion. That internal namespace is deliberately outside the public `job_...` ID grammar, so normal list/read/lock paths cannot reinterpret cleanup state as a job. A crash after rename leaves a recognizable cleanup record. Later pruning reclaims it only when the encoded filesystem generation still matches. Verification failure never renames quarantine back onto the public job pathname; the retired evidence stays isolated for a later safe retry. Any malformed reserved `retired_job_*` name, generation mismatch, wrong type, or unreadable retired entry remains a privacy-bounded destructive-state blocker without exposing its internal filename/device/inode through ordinary job diagnostics. Every recognized retired entry still counts toward the 50-item retained-state capacity until safely removed, so namespace separation cannot become a capacity bypass. The public `job_...` namespace is reserved just as strictly: a matching name with the wrong filesystem type is retained as `unreadable`, counts toward the same capacity, blocks destructive inventory, and is shown only to owner/local diagnostics. New deterministic job admission securely inspects an existing target before any capacity eviction, so a dangling link or other invalid target cannot consume retained terminal history before the request fails. Ordinary completed-job metadata may remain under the separate seven-day retention policy. A minimal-environment plan also launches its detached runner with a minimal control environment. Full parent-environment inheritance occurs only when the accepted plan explicitly captured that policy.

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

Finally steps are attempted after success, failure, timeout, or cancellation. Cancellation is delivered through an owner-only marker polled by the runner; the runner terminates the current child process tree and remains alive to execute cleanup. A ChildProcess `error` event by itself does not settle a step or release its resource lease: the runner latches that error and keeps the child as the active cancellation target until close/exit settlement proves the process lifecycle ended. This avoids both platform-specific signal behavior killing the coordinator itself and asynchronous child errors turning a still-live process into unaccounted work. If a runner is interrupted, the next daemon start or local `machine-mcp job ...` command detects the dead runner, removes stale private resource copies, and runs the finally phase in recovery mode.

Automatic dead-runner recovery is attempted at most three times; persistent failure becomes `recovery_exhausted` to avoid an endless restart loop. A terminal result's compatibility field `recovered=true` means the result was produced while the runner was in recovery mode; it does **not** mean recovery succeeded. Use terminal `status` as the authority: `recovered` means the recovery/finally phase completed, while `recovery_failed` and `recovery_exhausted` are failures even when the result also carries `recovered=true`. Cleanup is best effort, not mathematically guaranteed. Power loss, disk failure, permanent account loss, or a local security product that denies the cleanup executable can still prevent it. Finally steps should therefore be idempotent and safe to run more than once.

## Non-executing staged drafts

`stage_job` performs the same schema, cwd, resource, size, and permission validation as `start_job`, but records status `staged` and launches no process.

A staged record is a review artifact, not an authorization request:

- it contains no executable approval token;
- it cannot be promoted by `machine-mcp job approve`;
- no main or finally step runs;
- no registered resource is copied into a runtime directory;
- cancellation produces `cancelled_before_start` and removes the plan.

Use `machine-mcp job inspect JOB_ID` to review the stored plan. The projection includes argv, ordinary environment overrides, stdin, temporary helper content, and finally steps while omitting registered resource source paths and per-resource hashes. The overall `plan_sha256` is displayed and remains integrity-checked.

Execution requires a separate authority-bearing action:

- a trusted owner submits the plan through `start_job`; or
- the local machine operator submits a reviewed JSON plan with `machine-mcp job submit PLAN.json`.

The current runtime does not implement copy-an-ID, approve, and retry workflows. Staged drafts count toward the 50-item retention limit and expire after 24 hours. They are not active processes and do not independently block uninstall after normal confirmation.

## Submit and inspect

Through MCP:

```text
stage_job
start_job
list_jobs
read_job
cancel_job
```

From the local terminal:

```sh
machine-mcp job list
machine-mcp job inspect JOB_ID
machine-mcp job cancel JOB_ID
machine-mcp job submit plan.json
```

`job submit` is an explicit local operator action; it does not consume or promote a staged MCP draft.

The plan format is the same object accepted by `start_job`.

### Uncertain submission retries

`start_job` accepts an optional `idempotency_key` for a client that may need to retry the *same logical submission* after an uncertain transport outcome. The key is never persisted in cleartext. Instead, the runtime derives a deterministic job identity from the key plus the effective local/account authority binding. While that job record remains retained, retrying the same key with the same canonical plan returns the existing job with `idempotency_replay=true`; the same retained key with a different plan fails as a conflict. Replay inspects the persisted status through the same bounded no-follow reader used by ordinary job state—only a real `ENOENT` means no prior status—and reconciles any already-durable terminal `result.json` before deciding whether a dead `queued` runner may be launched again. A result-first/status-second crash therefore converges to the durable terminal result instead of repeating the main steps under the same idempotency key.

This is a bounded submission-deduplication window, not permanent exactly-once execution. Terminal job records may be removed after the normal retention period or earlier when safe terminal eviction is required to stay within the 50-record capacity. After that record has been evicted, the server no longer has evidence with which to deduplicate the old key, and a later submission may execute again. Use one fresh key per logical operation, retry only while resolving an uncertain submission, and treat a confirmed eviction/not-found boundary as the end of that key's deduplication guarantee. The tool therefore intentionally keeps `idempotentHint=false`.

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

Per-workspace jobs are stored below the owner-only profile directory. Active jobs retain an owner-only plan for crash recovery. Plan, status, result, runner identity, and lock updates use flushed atomic replacement or complete-before-visible exclusive claims. Transition/recovery locks contain ownership tokens and process start time and are removed only when their file snapshot still matches. After a terminal status is committed, the full plan is deleted, including argv, stdin, embedded temporary-file content, and resource source paths.

Retained public job data contains bounded status and redacted results. The hard capacity is 50 retained-state slots across ordinary job directories plus any recognized internal retired-cleanup entries that have not yet been safely removed. Terminal jobs are normally retained for up to seven days from their persisted `finished_at` settlement time, but when capacity is full the oldest safely removable terminal records are evicted to reserve a slot for a new job. Staged drafts expire after 24 hours and active, staged, unreadable, or abnormal retired state is never evicted merely to make room; if all 50 slots are occupied, new job creation returns a retryable `limit_exceeded` error whose owner-only details include coarse `retained_state`, `retired_state`, and `retired_unreadable` counts. `list_jobs.retained` remains the number of visible ordinary jobs; owner/local responses additionally include the same coarse capacity summary so an internal retired blocker cannot make a 49-job list look mysteriously full. Delegated non-owner responses omit the global capacity summary. Private runtime copies are removed after the finally phase. Runner stdout/stderr log files contain only runner-level diagnostics; step output is not written to those operational logs.

The detached runner records a structured owner record containing PID and process start time. Recovery rejects a reused PID instead of treating an unrelated process as the active runner. Numeric-only runner records are invalid. Recovery-lock handoff preserves a random ownership token, and the runner removes only a lock whose PID, token, and file snapshot still match. A recovery runner does not gain authority to write terminal evidence merely by confirming its runner claim: it must first complete recovery-lock handoff. Failure or ambiguity in that bootstrap phase leaves the prior `interrupted` status and plan intact for a later safe retry instead of publishing `recovery_failed` and scrubbing recovery material. The handoff has a 30-second monotonic ownership-settlement budget. Timeout and cancellation terminate the process group/tree, retain a referenced forced-escalation timer, and clean descendants that ignore graceful termination before the runner exits.

Missing job JSON is distinct from unreadable or invalid job JSON. Permission, type, symbolic-link, size, UTF-8, I/O, and parse failures retain the job directory, produce an `unreadable` status for listing, skip automatic recovery/pruning, and block uninstall until an operator inspects the state.

Process sessions and managed jobs have different semantics:

- process sessions are interactive, memory-only, and die with the daemon connection;
- managed jobs are non-interactive, persistent, detached, and designed to survive MCP disconnection.
