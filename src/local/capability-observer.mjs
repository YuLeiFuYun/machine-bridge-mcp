import { createHmac, randomBytes } from "node:crypto";

export class CapabilityObserver {
  constructor(now = () => Date.now(), taskFingerprintKey = randomBytes(32)) {
    this.now = now;
    this.taskFingerprintKey = Buffer.from(taskFingerprintKey);
    this.bootstrapCount = 0;
    this.resolutionCount = 0;
    this.lastBootstrap = null;
    this.lastResolution = null;
  }

  recordBootstrap(result) {
    this.bootstrapCount += 1;
    this.lastBootstrap = {
      observed_at: timestamp(this.now()),
      target: result?.target || ".",
      instruction_bytes: Buffer.byteLength(String(result?.instructions || "")),
      builtin_loaded: Boolean(result?.builtin_instructions),
      automatic_project_context_loaded: Boolean(result?.automatic_project_context),
      global_model_instructions_loaded: Boolean(result?.model_instructions_file),
      refresh_fingerprint: String(result?.capability_refresh?.instruction_and_command_fingerprint || ""),
    };
  }

  recordResolution(task, result) {
    this.resolutionCount += 1;
    this.lastResolution = {
      observed_at: timestamp(this.now()),
      task_fingerprint: createHmac("sha256", this.taskFingerprintKey).update(String(task || "")).digest("hex"),
      target: result?.target || ".",
      selected_skill: result?.selected_skill?.name || null,
      matched_skills: Array.isArray(result?.skill_matches) ? result.skill_matches.length : 0,
      matched_commands: Array.isArray(result?.command_matches) ? result.command_matches.length : 0,
      matched_applications: Array.isArray(result?.application_matches) ? result.application_matches.length : 0,
      recommended_tools: Array.isArray(result?.recommended_tools) ? [...result.recommended_tools] : [],
      refresh_fingerprint: String(result?.refresh?.fingerprint || ""),
    };
  }

  snapshot() {
    return {
      bootstrap_observed: this.bootstrapCount > 0,
      bootstrap_count: this.bootstrapCount,
      task_resolution_observed: this.resolutionCount > 0,
      task_resolution_count: this.resolutionCount,
      last_bootstrap: this.lastBootstrap ? structuredClone(this.lastBootstrap) : null,
      last_task_resolution: this.lastResolution ? structuredClone(this.lastResolution) : null,
      enforcement_boundary: "The server can discover, rank, load, and report capabilities; the MCP host decides whether to call the resolver or recommended tools.",
    };
  }
}

function timestamp(milliseconds) {
  return new Date(Number(milliseconds)).toISOString();
}
