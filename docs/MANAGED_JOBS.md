# Managed jobs and local resources

## Problem addressed

An MCP conversation is not a durable execution coordinator. A host or connector may reject a later tool call, an approval may be withdrawn, the network may disconnect, or local endpoint-security software may begin denying process creation. A sequence such as:

1. create a helper script;
2. connect to a remote server;
3. repair the service;
4. remove the helper;

can therefore stop after step 2 or 3 and leave local or remote temporary state behind.

Machine Bridge managed jobs reduce this failure mode by accepting the complete execution and cleanup plan in one call. After acceptance, an independent local runner owns the lifecycle. It does not depend on the MCP socket remaining connected.

Recovery inventory is deliberately ordered by recoverability rather than recency alone. `list_jobs.jobs` returns at most 50 primary records, with unreadable state, active jobs, staged plans, and durable terminal history ahead of transient one-step helper history so a burst of short helpers cannot push an older long-running or pre-spawn-waiting job out of that bounded primary window. A hosted one-step helper whose current response still requires `read_job` continuation retains stronger private recovery priority for thirty minutes because Machine Bridge explicitly instructed the caller to follow that durable handle. Once Machine Bridge produces a terminal hosted response—during initial settlement or a later `read_job`—the helper drops to the bounded newest-16 transient delivery reserve. A separate `recent_process_recovery` array remains capped at 16 authority-visible public handles, prioritizes retained follow-up-required helpers when the primary window omits them, and contains no step output or internal retention state. It is recovery inventory, not a polling or MCP replay/session surface. Owner/local listings also include only aggregate recent creation/churn counts; the internal `transient_process` retention class and follow-up marker remain hidden per job.

Remote one-step `exec_command`, `run_process`, and `run_local_command` requests still become durable managed jobs before execution. Hosted `start_job` now shares the same short two-second initial-settlement check after its explicit multi-step plan has been durably accepted. A job that reaches terminal state inside that window can therefore return its managed-job result in the original tool response with `follow_up_read_required=false`, eliminating the usual immediate second `read_job` event. A job that remains active keeps the same durable `job_id` and recovery envelope with `follow_up_read_required=true`; execution timeouts, dependency waiting, the pre-spawn resource-admission allowance, finally behavior, and later recovery semantics are unchanged. Local/stdio `start_job` does not add this hosted response wait.

This mechanism does **not** bypass host, operating-system, or endpoint-security policy. A job snapshots its execution policy/environment at acceptance; later profile changes affect new jobs, while accepted jobs continue until completion or explicit cancellation. The initial `start_job` request must still be permitted, and every local child process remains subject to local security controls.

## Diagnose the blocking layer

Use the MCP tool:

```text
diagnose_runtime
```

For an owner/local caller, interruption diagnosis includes three bounded evidence classes that are intentionally safe to correlate: managed-job creation/churn aggregates, content-free security-audit call-density/tool-frequency aggregates, and up to four resource waiters with their current pre-spawn admission reasons. Those waiter summaries never expose command text, paths, waiter IDs/tokens, PIDs, or contention keys. A long `resource_admission` waiter is scheduling evidence, not proof that the child timed out or that the overall user task should be shortened.

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

Managed jobs are also the required Machine Bridge execution carrier for operations that intentionally replace the current daemon, including persistent release-candidate activation. A process session is retained only by the current daemon and its process group is drained during daemon shutdown; a managed-job runner is detached, unreferenced, persisted under the owner-only job root, and can be inspected again after the replacement daemon reconnects. Do not substitute `start_process` for a daemon-replacing transaction merely because both APIs return an identifier.

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

Unexecuted staged plans can contain stdin, environment values, and temporary scripts. They expire after 24 hours, but expiry is itself a per-job state transition: pruning must acquire the job transition lock, re-read the current status, and only then commit the non-executing terminal record through the same result-first persistence boundary. A concurrent cancel/other transition therefore wins or finishes before expiry rather than racing it. Terminal retention begins from that terminal record's `finished_at`, not from the older staged directory age, so a long-abandoned draft is not immediately deleted in the same pass that first expires it. When seven-day retention or capacity pressure eventually retires a complete job directory, removal is also generation-bound: the inspected directory is atomically quarantined under an internal `retired_job_*` generation name before recursive deletion. That internal namespace is deliberately outside the public `job_...` ID grammar, so normal list/read/lock paths cannot reinterpret cleanup state as a job. A crash after rename leaves a recognizable cleanup record. Later pruning reclaims it only when the encoded filesystem generation still matches. Verification failure never renames quarantine back onto the public job pathname; the retired evidence stays isolated for a later safe retry. Any malformed reserved `retired_job_*` name, generation mismatch, wrong type, or unreadable retired entry remains a privacy-bounded destructive-state blocker without exposing its internal filename/device/inode through ordinary job diagnostics. Every recognized retired entry still counts toward the 512-state retained-state capacity until safely removed, so namespace separation cannot become a capacity bypass. The public `job_...` namespace is reserved just as strictly: a matching name with the wrong filesystem type is retained as `unreadable`, counts toward the same capacity, blocks destructive inventory, and is shown only to owner/local diagnostics. New deterministic job admission securely inspects an existing target before any capacity eviction, so a dangling link or other invalid target cannot consume retained terminal history before the request fails. Ordinary completed-job metadata may remain under the separate seven-day retention policy. The retained-state hard cap is 512. `list_jobs.jobs` deliberately returns at most 50 primary records per response so deeper recovery history does not inflate the ordinary MCP inventory window. One-step remote process carriers created by `exec_command`, `run_process`, and `run_local_command` are internally marked with the low-cardinality `transient_process` retention class; that marker is not part of the public job projection and contains no argv, path, output, or credential data. Under capacity pressure, completed transient process records are reclaimed before explicit managed-job terminal history whenever such transient records are available, except for the fixed newest-16/thirty-minute immediate recovery reserve. A retained recent process terminal that the durable-first primary `jobs` window omits may appear in `recent_process_recovery`, which is independently capped at 16 authority-visible public job handles and carries no step output or retention metadata. This prevents diagnostic/helper-command churn from preferentially destroying the recovery result of a long explicit managed job while keeping disk/privacy state and both inventory windows bounded. Active or staged plans that declare `depends_on` additionally pin those referenced retained job records against time- or capacity-based pruning until the dependency-bearing plan is terminal; if dependency protection cannot be read safely, capacity pruning fails closed rather than guessing that no dependency exists. A valid `job_id` whose directory has expired or been capacity-retired returns typed `not_found` rather than a generic execution failure. That absence means only that the retained record is unavailable; callers must not infer that the underlying operation never executed or blindly replay its side effects. A minimal-environment plan also launches its detached runner with a minimal control environment. Full parent-environment inheritance occurs only when the accepted plan explicitly captured that policy.

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

Temporary files live only below the private job runtime and are removed in the runner's final cleanup path. This is preferable to writing into a workspace-local scratch tree, `/tmp`, or a remote home directory and relying on a later MCP call to delete the file.

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

Finally steps are attempted after success, failure, timeout, or cancellation. Cancellation is delivered through an owner-only marker polled by the runner; the runner terminates the current child process tree and remains alive to execute cleanup. For each cancellation-aware main step, the runner checks that marker again after asynchronous resource admission and launch preparation, immediately before the synchronous `spawn` call. That final marker read is the managed-job launch decision point: a cancellation already visible there prevents child creation and releases the admitted lease, while a cancellation that becomes visible only after that decision is post-dispatch cancellation and terminates the owned process tree through the normal polling path. Because the marker is cross-process filesystem state rather than a same-isolate `AbortSignal`, `cancel_job` acknowledges a cancellation request; it does not claim the stronger real-time guarantee that a concurrently racing OS `spawn` syscall could not have won immediately after the runner's final marker read. Callers that need replay safety must therefore use the durable `job_id`, terminal status, and the documented idempotency contract rather than treating `cancellation_requested=true` as proof that no side effect ever started. A stronger wall-clock no-spawn-after-cancel-return contract would require a serialized cross-process launch/cancel protocol, not another asynchronous check.

A ChildProcess `error` event by itself does not settle a step or release its resource lease: the runner latches that error and keeps the child as the active cancellation target until close/exit settlement proves the process lifecycle ended. This avoids both platform-specific signal behavior killing the coordinator itself and asynchronous child errors turning a still-live process into unaccounted work. Immediately after spawning a business child, the runner also persists an owner-only `active-child.json` claim with PID, process-start identity, a random ownership token, and process-group isolation semantics. Normal close/exit settlement removes that exact claim. If the runner itself dies while its child remains detached, the claim is the durable evidence recovery uses instead of guessing from a bare PID.

While the same daemon remains alive, it observes exits only for managed-job runners that it launched and schedules one reconciliation after the existing crash-settlement grace period; it does not scan all retained jobs on a periodic clock. A daemon or CLI restart still performs the established recovery scan. Before an interrupted recovery runner releases the recovery lock, becomes terminal-authoritative, or runs `finally_steps`, it must verify the persisted active-child identity and terminate that exact old process tree. PID reuse, malformed claims, or otherwise unverifiable ownership fail closed: no signal is sent, the claim is not deleted, and recovery state remains available for later inspection/retry. Recovery exhaustion likewise cannot declare the job terminal while a verified old child remains alive. The unavoidable OS boundary remains explicit: a crash in the tiny interval after the kernel accepts `spawn` but before the ownership claim is durably written is a post-dispatch unknown outcome, not proof that no side effect started.

Automatic dead-runner recovery is attempted at most three times; persistent failure becomes `recovery_exhausted` to avoid an endless restart loop. A terminal result's compatibility field `recovered=true` means the result was produced while the runner was in recovery mode; it does **not** mean recovery succeeded. Use terminal `status` as the authority: `recovered` means the recovery/finally phase completed, while `recovery_failed` and `recovery_exhausted` are failures even when the result also carries `recovered=true`. Cleanup is best effort, not mathematically guaranteed. Power loss, disk failure, permanent account loss, or a local security product that denies the cleanup executable can still prevent it. Finally steps should therefore be idempotent and safe to run more than once.

## Durable dependencies for long workflows

Use top-level `depends_on` when one managed job must wait for one or more earlier managed jobs. This replaces shell loops that repeatedly check for files which may never be created after an upstream failure:

```json
{
  "name": "qualification consumer",
  "depends_on": ["job_example_upstream_identifier"],
  "steps": [
    { "argv": ["python3", "consume-qualified-result.py"], "timeout_seconds": 21600 }
  ]
}
```

At acceptance, each dependency is bound to its current durable job identity (`job_id`, plan hash, and creation generation). Staged dependencies and dependencies that have already failed are rejected before the new job is accepted. While any accepted dependency remains active, the dependent job stays `queued` with `current_phase=dependency_wait`; `dependency_total` and `dependency_pending_count` report progress, and the dependent job has not spawned its main child, entered process resource admission, or materialized private registered-resource/temporary-file execution copies. As upstream jobs settle, a hosted `read_job` long-poll wakes when the pending count changes. A transient dependency-state read failure classified as `permission_denied`, `identity_changed`, or generic `resource_unavailable` keeps the dependent in `dependency_wait` for a fixed 45-second recovery grace instead of converting one Windows sharing/atomic-replacement race into a permanent dependency failure. A successful read clears that per-dependency grace immediately. Persistent unavailability past the grace still fails closed as `dependency_unavailable`; `not_found`, integrity failure, witness/identity mismatch, staged state, and other invalid dependency evidence remain immediate failures. All dependencies succeeding releases the normal main-step sequence and materializes execution inputs immediately before they can be needed. An upstream job that later ends unsuccessfully makes the dependent job terminal with `result.error_class=dependency_failed` and bounded `dependency_failure` evidence instead of waiting minutes or hours for an impossible artifact. If that failure still requires declared `finally_steps`, their resource/temporary-file inputs are materialized only when the cleanup phase begins.

Terminal persistence is result-first: the durable `result.json` is written before `status.json` is changed to the matching terminal state. Dependency polling therefore treats a valid terminal result for the same job as a read-only terminal projection during that narrow publication window instead of waiting for an unrelated manager read to repair the status file. It does not rewrite the upstream record. Once the dependent itself becomes terminal, `dependency_pending_count` is zero because the dependent is no longer waiting; `dependency_failure` identifies the upstream terminal cause when the job failed.

Dependency waiting is local durable execution state, not a ChatGPT turn timer. It survives MCP disconnection, and a runner that dies before any dependent main step has started is relaunched as the same pre-execution `dependency_wait` job rather than being converted to cleanup-only recovery. The internal dependency-wait orphan guard is measured in days, not minutes; it exists only to prevent an indefinitely unrecoverable dependency set from consuming state forever. It does not reduce the six-hour per-step execution ceiling, the 40-second hosted `read_job` pacing contract, or the requirement to keep following a long task in the same assistant response while tool calls continue to be accepted. The user must not be used as a polling clock.

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

The current runtime does not implement copy-an-ID, approve, and retry workflows. Staged drafts count toward the 512-state retention limit and expire after 24 hours. They are not active processes and do not independently block uninstall after normal confirmation.

## Submit and inspect

Through MCP:

```text
stage_job
start_job
list_jobs
read_job
cancel_job
```

In hosted remote use, successful `start_job` acceptance hands execution to durable background ownership without forcing the current assistant response to end. If the current task needs the result, `read_job` may be used for bounded same-response follow-up until terminal state while calls continue to be accepted. An active relay read defaults to a 40-second server-side long-poll. Terminal settlement returns on the next bounded five-second internal poll; nonterminal status/phase/dependency progress is coalesced for at least 30 seconds by default, and `current_step`-only churn does not wake the hosted call. `wait_ms=0` is an explicit immediate checkpoint, while public hosted `wait_ms` is capped at 60 seconds. The default stays at 40 seconds because hosted acceptance must demonstrate the per-call lifetime; longer jobs continue through another paced read of the same `job_id` rather than one overlong tool invocation. For a coherent non-interactive sequence, prefer one multi-step managed job or a repository umbrella command to many one-step durable carriers. Do not busy-loop, do not replace server-side pacing with rapid immediate reads, do not substitute repeated `list_jobs` calls for a known-job read, and do not infer or preempt a host/tool deadline from elapsed wall-clock time. Return the `job_id`, status, and current phase for a later turn only after an actual host/tool boundary is observed, external input or authorization is required, or the user explicitly requested a checkpoint. Local explicit-wait inspection retains its operator-driven step-progress behavior; the `current_step` wake suppression is hosted-only.

From the local terminal:

```sh
machine-mcp job list
machine-mcp job inspect JOB_ID
machine-mcp job cancel JOB_ID
machine-mcp job submit plan.json
```

`job submit` is an explicit local operator action; it does not consume or promote a staged MCP draft.

The plan format is the same object accepted by `start_job`. Each main or finally step defaults to a ten-minute execution timeout and may explicitly request up to six hours (`timeout_seconds=21600`); resource admission happens before that execution timer begins. This permits one continuous command to run beyond 100 minutes without splitting it merely to satisfy an orchestration timeout.

### Uncertain submission retries

The underlying local/stdio `start_job` API accepts an optional `idempotency_key`. The hosted Worker surface is stricter: generation 8 requires the caller to choose the key **before dispatch** because the host may lose an acceptance response after the daemon has already persisted or started the job. Retrying the same hosted `start_job` arguments with the same key recovers that logical submission instead of creating a second job. The key is never persisted in cleartext. Instead, the runtime derives a deterministic job identity from the key plus the effective local/account authority binding. While that job record remains retained, retrying the same key with the same canonical plan returns the existing job with `idempotency_replay=true`; the same retained key with a different plan fails as a conflict. Replay inspects the persisted status through the same bounded no-follow reader used by ordinary job state—only a real `ENOENT` means no prior status—and reconciles any already-durable terminal `result.json` before deciding whether a dead `queued` runner may be launched again. A result-first/status-second crash therefore converges to the durable terminal result instead of repeating the main steps under the same idempotency key.

This is a bounded submission-deduplication window, not permanent exactly-once execution. Terminal job records may be removed after the normal retention period or earlier when safe terminal eviction is required to stay within the 512-state capacity. After that record has been evicted, the server no longer has evidence with which to deduplicate the old key, and a later submission may execute again. Use one fresh key per logical operation, retry only while resolving an uncertain submission, and treat a confirmed eviction/not-found boundary as the end of that key's deduplication guarantee. The tool therefore intentionally keeps `idempotentHint=false`.

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

Retained public job data contains bounded status and redacted results. The hard capacity is 512 retained-state slots across ordinary job directories plus any recognized internal retired-cleanup entries that have not yet been safely removed; `list_jobs.jobs` still returns at most 50 primary records per call, while `recent_process_recovery` may add at most 16 authority-visible process recovery handles that were omitted from that primary window. Terminal jobs are normally retained for up to seven days from their persisted `finished_at` settlement time, but when capacity is full the oldest safely removable terminal records are evicted to reserve a slot for a new job. Staged drafts expire after 24 hours, dependency-referenced records are protected while an active/staged dependent plan still needs them, and active, staged, unreadable, or abnormal retired state is never evicted merely to make room. One-step process results add a private distinction that never appears in public projections: a terminal whose initiating hosted response still required `read_job` keeps follow-up recovery priority for the thirty-minute transient grace, while a terminal already delivered in the initial response competes only for the newest-16 delivery reserve. The hard 512-state cap still wins: protected follow-up results may displace older ordinary durable terminal history, but cannot evict active/staged/unreadable/dependency-pinned state, and if all safely removable records are exhausted creation still returns retryable `limit_exceeded`. `list_jobs.retained` remains the number of visible ordinary jobs even when only 50 are returned. That bounded inventory is recovery-first: unreadable, active, and staged state stays first, durable terminal managed-job results precede ordinary transient one-step process terminals, while the separate 16-handle recovery projection prioritizes retained follow-up-required helpers. Owner/local responses additionally include the coarse capacity summary plus `durable_terminal` and `transient_terminal` counts so a full 512-state store can be distinguished from helper churn without exposing job identities, paths, arguments, output, or the private follow-up marker. Delegated non-owner responses omit the global capacity summary. These counts improve recovery visibility only; Machine Bridge still cannot observe whether an external host consumed a terminal result or rendered a final assistant response. Private runtime copies are removed after the finally phase. Runner stdout/stderr log files contain only runner-level diagnostics; step output is not written to those operational logs.

The detached runner records a structured owner record containing PID and process start time. Recovery rejects a reused PID instead of treating an unrelated process as the active runner. Numeric-only runner records are invalid. Initial runner publication uses provisional then committed atomic generations; a claim reader is explicitly coupled to that publication protocol and may therefore retry a transient `MBM_IDENTITY_CHANGED` observation for four 1 ms attempts before failing. Each retry repeats the complete secure read and identity validation; this exception does not apply to generic or destructive file reads. Recovery-lock handoff preserves a random ownership token, and the runner removes only a lock whose PID, token, and file snapshot still match. A recovery runner does not gain authority to write terminal evidence merely by confirming its runner claim: it must first complete recovery-lock handoff. Failure or ambiguity in that bootstrap phase leaves the prior `interrupted` status and plan intact for a later safe retry instead of publishing `recovery_failed` and scrubbing recovery material. The handoff has a 30-second monotonic ownership-settlement budget. Timeout and cancellation terminate the process group/tree, retain a referenced forced-escalation timer, and clean descendants that ignore graceful termination before the runner exits.

Missing job JSON is distinct from unreadable or invalid job JSON. Permission, type, symbolic-link, size, UTF-8, I/O, and parse failures retain the job directory, produce an `unreadable` status for listing, skip automatic recovery/pruning, and block uninstall until an operator inspects the state.

Process sessions and managed jobs have different semantics:

- process sessions are interactive, memory-only, and die with the daemon connection;
- managed jobs are non-interactive, persistent, detached, and designed to survive MCP disconnection.
