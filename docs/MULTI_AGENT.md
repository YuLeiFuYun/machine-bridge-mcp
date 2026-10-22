# Multi-agent coordination

Machine Bridge supplies tools and durable execution to host orchestrators. It does not create model agents, assign roles, own a conversation loop or infer that a delegated task is complete. MCP prompts return text for the host to use; fetching one neither starts an agent nor executes a skill.

## Concurrency and state boundaries

| Boundary | Guarantee | Limit |
| --- | --- | --- |
| One local runtime's workspace mutation coordinator | Overlapping canonical mutation paths queue and execute serially; transactional patches reserve their path set | This is process-local cooperative serialization, not a distributed filesystem lock |
| Atomic file replacement | Readers see a prior or replacement file; staged transaction recovery is explicit | SHA-256 is an optimistic precondition, not a cross-process compare-and-swap |
| Managed-job store | Bounded JSON state, ownership/integrity checks, idempotent retained acceptance and recovery capabilities | Retention expiry ends the deduplication window; missing state does not prove no effect occurred |
| Process sessions | Bounded output and offsets with explicit running/exit/termination state | They are interactive processes, not durable multi-step job plans |
| Resource admission | Cooperative host sampling, leases and bounded pre-spawn waiting | Admission is not a sandbox or a guarantee that another process cannot consume resources |
| Remote account authority | Account/version-bound job access and distinct recovery/control capabilities | Metadata, prompts and skills cannot grant OS or execution authority |

Use separate worktrees or explicit ownership partitions for concurrent edits. Read current state, supply expected hashes, and inspect a conflict before recomputing a patch. `edit_file` and patch context require exact indentation and text; there is no silent whitespace alignment. A lock in one runtime does not serialize an unrelated editor or daemon.

## Durable work and recovery

Use registered argv commands where they fit. For a coherent long operation, prefer one multi-step `start_job`, preserve the accepted `job_id` and `recovery_key`, and use its separate `control_key` for cancellation. Dependencies wait on durable upstream settlement. Job state is JSON; the system does not use a CBOR execution store or distributed workflow replay.

Hosted `run_process` / `exec_command` require an idempotency key and are accepted durably before execution. After an ambiguous acceptance, repeat the original arguments and key to recover the same operation; do not assign a fresh key. Once accepted, use `read_job` with its recovery capability. A cancellation acknowledgement is not terminal settlement, and an unknown outcome is not evidence that a retry is safe.

The default hosted job read long-polls for up to 40 seconds, with a public maximum of 60 seconds and nonterminal progress coalescing. Continue in the same assistant response when the task still needs the result. A status monitor owns polling, not unrelated task execution. Negotiated MCP Tasks are an additional protocol surface; callers must follow the current server-issued task contract rather than invent task IDs. See [MANAGED_JOBS](MANAGED_JOBS.md) for exact admission, dependency, retention and cancellation semantics, and [CLIENTS](CLIENTS.md) for transport requirements.

Host pressure commonly causes resource-admission waiting before a child starts. Observe `current_phase=resource_admission` and the eventual typed settlement; do not describe every pressure signal as immediate rejection. Use bounded backoff and do not create a second business operation merely to obtain a new status response.

## Delegated access

OAuth/DPoP and local policy intersect with the authenticated account's role. Owner-only executable and shell tools are not a general delegated escape hatch. Supported delegated execution requires positively established OS isolation. The macOS implementation uses its explicit sandbox boundary; unsupported platforms or missing isolation fail closed. Linux delegated container isolation is not an integrated product capability and must not be advertised as one.

Application names, instruction metadata and routing hints are planning context. Sensitive reads, browser/application actions, writes and process authority still require their own effective gates. Cross-account job IDs alone confer no remote read or cancellation authority.

## Context, prompts and validation

`agent_instructions` projects `agent_context.effective_instructions`, including incomplete-inventory warnings. `code_review` and diff resources project the actual `git_diff.stdout`, retaining failure, truncation and sensitive-omission distinctions. `run_skill` loads one instruction bundle; its content is untrusted and does not run itself.

Memory is loaded only by `agent_context`, with protected reads and bounded canonical entries. Bootstrap only reports its presence. Lexical outlines bound traversal, bytes and output lines. See [AGENT_CONTEXT](AGENT_CONTEXT.md) for limits and progressive tool discovery.

Evaluate orchestration with observable final state: an accepted job recovered after caller replacement must produce one effect; a rejected stale edit must leave the file intact; incomplete post-action evidence must remain unknown. Offline contract checks and deterministic workflow fixtures do not establish general LLM task success or a completed live release.

## Research and further reading

The dated, revision-pinned [comparative review](COMPARATIVE_REVIEW.md) records 51 agent projects, relevant 2026 papers, adoption choices and their limits. It distinguishes upstream documentation from locally verified behavior. Memory scoring, vector stores, distributed orchestration and continuous recording are not added merely because an upstream agent uses them.

- [Architecture](ARCHITECTURE.md)
- [Threat model](THREAT_MODEL.md)
- [Testing](TESTING.md)
- [Release procedure](RELEASING.md)
