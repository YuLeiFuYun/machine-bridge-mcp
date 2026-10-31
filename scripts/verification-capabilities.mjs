import { processStartTimeMs } from "../src/local/process-identity.mjs";

// Tasks that cannot complete on a host without a readable process start time: durable job
// recovery has to prove a recovered pid is still the same process.
const PROCESS_IDENTITY_TASKS = new Set(["agent-workflows:test", "self-test"]);

/**
 * Fail before the plan spends minutes on work the host cannot complete.
 *
 * Without `/proc` or `ps` these tasks fail deep inside their own assertions, which reads as
 * a product bug. Probing once up front turns that into an immediate, actionable failure.
 *
 * @param {string[]} tasks
 * @param {{platform?: string, env?: Record<string, string | undefined>, probe?: (pid: number) => number | null, ppid?: number}} [options]
 */
export function assertHostCapabilities(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const platform = options.platform || process.platform;
  if (platform === "win32") return;
  const env = options.env || process.env;
  const needed = list.filter((task) => {
    if (!PROCESS_IDENTITY_TASKS.has(task)) return false;
    // The agent-workflows task has its own explicit skip; honour it so an opted-in run is
    // not blocked by this probe.
    return task === "agent-workflows:test" ? env.MBM_ALLOW_AGENT_WORKFLOW_SKIP !== "1" : true;
  });
  if (!needed.length) return;
  const probe = typeof options.probe === "function" ? options.probe : processStartTimeMs;
  const ppid = Number.isInteger(options.ppid) ? options.ppid : process.ppid;
  if (probe(ppid) !== null) return;
  throw new Error(
    `${needed[0]} requires a host process start time from /proc or ps, and this host cannot provide one `
    + "(a sandbox or missing permissions is the usual cause). Fix the host before running this plan; "
    + "durable job recovery cannot verify a recovered pid without it.",
  );
}
