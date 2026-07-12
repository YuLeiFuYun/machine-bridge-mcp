export function requireSuccessfulCiRun(runs, head) {
  if (!Array.isArray(runs)) throw new Error("GitHub Actions response is not an array");
  if (!/^[0-9a-f]{40,64}$/i.test(String(head || ""))) throw new Error("release commit SHA is invalid");
  const matching = runs
    .filter((run) => run && run.headSha === head && run.event === "push")
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const run = matching[0];
  if (!run) {
    throw new Error(`no push-triggered CI run exists for release commit ${head}; wait for GitHub Actions to register the run and retry`);
  }
  if (run.status !== "completed") {
    throw new Error(`CI run ${run.databaseId || "unknown"} for release commit ${head} is ${run.status || "unknown"}; wait for completion and retry`);
  }
  if (run.conclusion !== "success") {
    throw new Error(`CI run ${run.databaseId || "unknown"} for release commit ${head} concluded ${run.conclusion || "unknown"}; fix or rerun CI before release`);
  }
  return run;
}
