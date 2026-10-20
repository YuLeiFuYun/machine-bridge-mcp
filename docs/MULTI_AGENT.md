# Multi-Agent Concurrency and Coordination Guide

Machine Bridge MCP provides unified tool surfaces for autonomous AI agents, coding assistants, and multi-agent orchestrators. When multiple agents or subagents concurrently access the same machine or workspace, coordination, race prevention, and resource contention must be managed rigorously.

This guide outlines the concurrency model, locking primitives, task delegation, and best practices for multi-agent systems.

---

## 1. Concurrency Architecture

Multi-agent coordination in Machine Bridge operates across three structural tiers:

```
+-------------------------------------------------------------------+
|               Multi-Agent Orchestrator (e.g. Swarm / Pipeline)     |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               Machine Bridge MCP Host Gateway                      |
|  - MCP 2026-07-28 Transport (StdIO / Request-scoped Streamable)  |
|  - Resource Admission & Host Pressure Governor                    |
|  - In-flight Pending Call Registry (JSON-RPC ID deduplication)     |
+-------------------------------------------------------------------+
                                  |
        +-------------------------+-------------------------+
        |                                                   |
        v                                                   v
+-------------------------------+   +-------------------------------+
|     Workspace Mutation Locks  |   |   Background Process Sessions |
| - withMutationPaths exclusivity|   | - Managed Job Store (cbor)   |
| - Atomic replace & rollback   |   | - Output ring buffers (5MB)   |
| - Staged Git index locks      |   | - Authority & lease tracking  |
+-------------------------------+   +-------------------------------+
```

---

## 2. Workspace Concurrency & File System Protection

When multiple agents perform file system reads and writes in parallel, naive concurrent writes can lead to file corruption, lost updates, or broken intermediate builds.

Machine Bridge implements path-level exclusive reservation for mutations:

### Mutation Path Exclusion (`withMutationPaths`)
- Every destructive workspace operation (`write_file`, `edit_file`, `apply_patch`) resolves canonical target paths and acquires a temporary cooperative lock.
- If an agent attempts to mutate a file path currently undergoing modification by another in-flight operation, the request receives a typed `conflict` error rather than interleaving dirty bytes.
- Atomic file writes write first to a temporary sibling file (`.mbm-tmp.*`) and atomically swap via filesystem rename, ensuring readers never observe half-written files.

### Recommended Multi-Agent File Access Pattern
1. **Partition by directory**: When dispatching parallel subagents, assign each subagent an independent directory branch (e.g., `tests/`, `src/frontend/`, `src/backend/`).
2. **Handle `conflict` with Reflexion**: If a mutation returns code `conflict`, the agent receives `actionable_remedy: "Resource state changed; inspect current state before retrying."` The calling agent should reload the file contents (`read_file`) and reapply its changes.

---

## 3. Background Job & Task Management

For compute-intensive or long-running tasks (e.g. running test suites, build pipelines, dependency installs), concurrent agents should not block transport threads.

### Async Execution Pattern
1. **Launch**: Agent A triggers `start_job` or launches a managed process.
2. **Monitoring & Result Collection**: Local agents use `read_job`; remote clients that negotiated `io.modelcontextprotocol/tasks` use `tasks/get` with the server-issued task identifier and retrieve the terminal result from that response.
3. **Cancellation**: If a supervising agent detects a failing plan or budget exhaustion, it requests cancellation with `cancel_job` locally or `tasks/cancel` for a negotiated remote task. A cancellation acknowledgement is not proof that execution has already stopped.

### Host Pressure & Admission Governor
Machine Bridge continuously samples system memory, CPU load, and active process count. If host pressure reaches the `red` threshold:
- New heavy background jobs or commands are rejected with typed `unavailable` error and `reason: "resource_admission"`.
- Agents should back off exponentially or wait for running tasks to complete.

---

## 4. Subagent Delegation via MCP Prompts

Machine Bridge MCP exposes reusable prompt templates via the standard MCP `prompts/list` and `prompts/get` protocol methods:

- **`agent_instructions`**: Bootstraps specialized agent personas with repository context, rules, and workspace guidelines.
- **`code_review`**: Formats structured multi-file diffs and instructs a reviewer agent on contract verification, boundary checks, and test coverage.
- **`run_skill`**: Loads skill content by the `skill` argument and returns its instructions; it does not run skill files.

Orchestrator agents can fetch these prompt definitions and inject them directly into subagent system instructions.

---

## 5. Security & Multi-Account Isolation

In enterprise environments with distinct accounts or tenants:
- Each client connection presents cryptographic DPoP proofs and OAuth 2.1 access tokens.
- Managed jobs are bound to `(account_id, account_version)`. An agent belonging to one tenant cannot read, signal, or cancel processes belonging to another tenant.
- Non-owner delegated accounts operate under OS sandboxing (e.g. `sandbox-exec` on macOS or container isolation on Linux), preventing accidental modification of shared machine state outside designated workspace roots.

---

## 6. Research References and Implementation Boundaries

These papers and agent systems are design references, not evidence that Machine Bridge reproduces their algorithms or research results. Treat a behavior as implemented only when it exists in production code and is exercised by tests. `agent-evals:test` is an offline smoke suite against production modules, not a task-success-rate benchmark; this project does not claim a measured success rate from those checks.

### 1. Reflexion (Shinn et al., 2023)
- Reference: [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366). Tool errors may include bounded `actionable_remedy` guidance. Follow-up reads, retries, and self-correction remain caller/orchestrator decisions; the bridge does not claim to run a general Reflexion loop.

### 2. SWE-agent & Agent-Computer Interface (ACI) (Yang et al., 2024)
- Reference: [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793). Bounded file reads accept explicit line ranges, and tool results have byte limits. These are local interface choices, not a reproduction of SWE-agent's ACI or a guarantee against context exhaustion.

### 3. MemGPT Context Virtualization (Packer et al., 2023)
- Reference: [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560). Hosted file reads paginate by whole-line `next_start_line`; result projection bounds duplicated human-readable text. This is not a MemGPT-style memory hierarchy and does not expose a generic `pagination_cursor` contract.

### 4. AgentDojo (NeurIPS 2024) and InjecAgent (Findings of ACL 2024)
- References: [AgentDojo](https://proceedings.nips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html) and [InjecAgent](https://aclanthology.org/2024.findings-acl.624/). These are threat-model references only. The repository does not implement general end-to-end taint tracking with `untrusted_external_content` markers. Retrieved browser, file, and repository text must still be treated as untrusted input; tool schemas and authorization gates do not establish content provenance.

### 5. τ-bench & Benchmark Reliability (Yao et al., 2024)
- Reference: [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045). `tests/agent-evals-test.mjs` runs nine offline smoke checks against production catalog, prompt dispatch, protocol validation, result projection, bounded output, and file transaction code. These checks are not a τ-bench reproduction, do not measure task success rate, and are not evidence of end-to-end agent performance.

---

## 7. Comparative Ecosystem Review (54 Repositories, 55 Entries)

The comparative review records design patterns from 54 distinct open-source repositories across 55 entries. Only links containing `/tree/<commit>` pin a revision; plain repository links are mutable discovery references, not reproducible source-review evidence. This is not a benchmark of Machine Bridge performance and does not imply that every referenced feature is implemented:

- **Protocols & Discovery**: Adopts the MCP 2026-07-28 specification, request-scoped discovery, and declarative schema models (`modelcontextprotocol/spec`, `fastmcp`, `mcp-agent`).
- **Computer Use & Browser**: Combines dual-tier screenshots with accessibility tree semantic references and explicit `tab_id` isolation (`playwright-mcp`, `stagehand`, `skyvern`, `agent-browser`).
- **Code Assistance & Checkpoints**: Implements atomic temporary file swaps and transactional mutation boundaries; Git checkpoint and worktree orchestration remains client-managed (`claude-code`, `aider`, `cline`, `SWE-agent`).
- **Durable Execution & Transactions**: Provides bounded durable job records, principal-bound recovery capabilities, and explicit retention rules. The 24-hour grace applies to specific undelivered hosted results, not all terminal jobs (`temporalio`, `restate`, `inngest`).
- **Safety & Sandboxing**: Uses content-free audit events, DPoP authorization, and platform-dependent sandboxing for delegated accounts; this is not a claim of reproducing E2B or a general taint-tracking framework (`e2b`, `guardrails`, `agentops`).

---

## 8. Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture and component boundaries
- [OPERATIONS.md](OPERATIONS.md) - Operational runbooks and capacity limits
- [MANAGED_JOBS.md](MANAGED_JOBS.md) - Background job lifecycle and durability guarantees
- [AGENT_CONTEXT.md](AGENT_CONTEXT.md) - Context projection and project rules
- [TOOL_REFERENCE.md](TOOL_REFERENCE.md) - Complete tool invocation reference
- [COMPARATIVE_REVIEW.md](COMPARATIVE_REVIEW.md) - Comprehensive evaluation of 55 AI Agent repositories
